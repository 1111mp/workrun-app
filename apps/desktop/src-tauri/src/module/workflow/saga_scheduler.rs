//! Abandonment is durable authorization; execution failure alone is never one.
use super::*;
use sqlx::Row;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Abandonment {
    pub status: String,
    pub automatic: bool,
    pub requested_at: String,
    pub last_error: Option<String>,
    pub completed: i64,
    pub total: i64,
}

pub(crate) async fn inspect(pool: &sqlx::SqlitePool, run_id: &str) -> Result<Option<Abandonment>> {
    Ok(sqlx::query_as("SELECT b.status,COALESCE(json_extract(r.runtime_json,'$.automaticProcessCleanup'),0) AS automatic,b.requested_at,b.last_error,(SELECT COUNT(DISTINCT i.id) FROM workflow_compensation_intents i JOIN workflow_operations o ON o.id=i.operation_id JOIN workflow_operation_attempts a ON a.operation_id=i.operation_id WHERE a.run_id=b.run_id AND i.mode='compensatable' AND i.status='succeeded' AND o.dispatched_at IS NOT NULL AND o.confirmed_no_effect=0) AS completed,(SELECT COUNT(DISTINCT i.id) FROM workflow_compensation_intents i JOIN workflow_operations o ON o.id=i.operation_id JOIN workflow_operation_attempts a ON a.operation_id=i.operation_id WHERE a.run_id=b.run_id AND i.mode='compensatable' AND o.dispatched_at IS NOT NULL AND o.confirmed_no_effect=0 AND (COALESCE(json_extract(r.runtime_json,'$.automaticProcessCleanup'),0)=0 OR i.status!='not_requested')) AS total FROM workflow_abandonments b JOIN run_records r ON r.id=b.run_id WHERE b.run_id=?")
        .bind(run_id).fetch_optional(pool).await?)
}

pub(crate) async fn ensure_continuable(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, run_id: &str) -> Result<()> {
    let abandoned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_abandonments WHERE run_id=?)")
        .bind(run_id)
        .fetch_one(&mut **tx)
        .await?;
    let undecided:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE id=? AND status='failed' AND json_extract(runtime_json,'$.processCleanupVersion')=1 AND COALESCE(json_extract(runtime_json,'$.processCleanupConsidered'),0)=0)")
        .bind(run_id).fetch_one(&mut **tx).await?;
    if undecided {
        bail!("Workflow failure cleanup is being scheduled; wait for the task status to refresh");
    }
    if abandoned {
        bail!("Task compensation or cleanup has started; create a new task to execute business again");
    }
    Ok(())
}

pub(crate) async fn request(pool: &sqlx::SqlitePool, run_id: &str) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT target_type,status,runtime_json FROM run_records WHERE id=?")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
    let runtime: Value = serde_json::from_str(&row.get::<String, _>("runtime_json"))?;
    if row.get::<String, _>("target_type") != "workflow" || !runtime["evaluationProfile"].is_null() {
        bail!("Only production workflow tasks can be abandoned with compensation");
    }
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT OR IGNORE INTO workflow_abandonments (run_id,status,requested_at,updated_at,next_check_at) VALUES (?,'pending',?,?,?)")
        .bind(run_id).bind(&now).bind(&now).bind(&now).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE run_recovery_jobs SET status='blocked',last_error='Task abandoned',updated_at=? WHERE run_id=?",
    )
    .bind(&now)
    .bind(run_id)
    .execute(&mut *tx)
    .await?;
    // Revoke queued scheduling in the same transaction as abandonment. An
    // already claimed owner is cancelled separately and the worker waits for it.
    sqlx::query("UPDATE run_records SET status='cancelled',ended_at=?,updated_at=? WHERE id=? AND status='queued'")
        .bind(&now)
        .bind(&now)
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn retry(pool: &sqlx::SqlitePool, run_id: &str) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let now = chrono::Utc::now().to_rfc3339();
    let changed=sqlx::query("UPDATE workflow_abandonments SET status='pending',last_error=NULL,next_check_at=?,updated_at=? WHERE run_id=? AND status='blocked'")
        .bind(&now).bind(&now).bind(run_id).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        bail!("No blocked compensation plan is available to retry");
    }
    sqlx::query("UPDATE workflow_compensation_intents SET status='pending',last_error=NULL,updated_at=? WHERE status IN ('failed','blocked') AND mode='compensatable' AND operation_id IN (SELECT operation_id FROM workflow_operation_attempts WHERE run_id=?)")
        .bind(now).bind(run_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn recover_startup(pool: &sqlx::SqlitePool) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query(
        "UPDATE workflow_abandonments SET status='pending',next_check_at=?,updated_at=? WHERE status='running'",
    )
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE workflow_compensation_intents SET status='pending',updated_at=? WHERE status='running'")
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE run_recovery_jobs SET status='blocked',last_error='Task abandoned',updated_at=? WHERE run_id IN (SELECT run_id FROM workflow_abandonments)")
        .bind(now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn claim(pool: &sqlx::SqlitePool) -> Result<Option<String>> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let id:Option<String>=sqlx::query_scalar("SELECT run_id FROM workflow_abandonments WHERE status='pending' AND next_check_at<=? ORDER BY requested_at LIMIT 1")
        .bind(&now).fetch_optional(&mut *tx).await?;
    if let Some(id) = &id {
        sqlx::query("UPDATE workflow_abandonments SET status='running',updated_at=? WHERE run_id=?")
            .bind(now)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(id)
}

pub(super) async fn plan_status(
    pool: &sqlx::SqlitePool,
    run_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let now = chrono::Utc::now();
    sqlx::query("UPDATE workflow_abandonments SET status=?,last_error=?,updated_at=?,next_check_at=? WHERE run_id=? AND status='running'")
        .bind(status).bind(error).bind(now.to_rfc3339()).bind((now+chrono::Duration::seconds(5)).to_rfc3339()).bind(run_id).execute(pool).await?;
    Ok(())
}

fn validate_dsl_coverage(dsl: &Value) -> Result<()> {
    // CodeAct bypasses the journal. Even an apparently completed checkpoint
    // cannot prove its effects were captured, so don't advertise full reversal.
    if dsl["nodes"]
        .as_array()
        .is_some_and(|nodes| nodes.iter().any(|node| node["type"] == "codeact_agent"))
    {
        bail!("CodeAct effects have no compensation journal; manual reconciliation required");
    }
    Ok(())
}

/// Verify the entire original task before any reversal. Unknown leaves block
/// all compensation, including unrelated branches, to fence late side effects.
async fn prepare_plan(pool: &sqlx::SqlitePool, key: &[u8], run_id: &str) -> Result<()> {
    let runtime: String = sqlx::query_scalar("SELECT runtime_json FROM run_records WHERE id=?")
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    let runtime: Value = serde_json::from_str(&runtime)?;
    if runtime["compensationJournalVersion"] != 1 {
        let started: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_attempts WHERE run_id=?) OR EXISTS(SELECT 1 FROM workflow_operation_attempts WHERE run_id=?)")
            .bind(run_id).bind(run_id).fetch_one(pool).await?;
        if started {
            bail!("Legacy task has no complete operation-journal coverage; manual remediation required");
        }
    }
    validate_dsl_coverage(&runtime["dsl"])?;
    let snapshots:Vec<String>=sqlx::query_scalar("SELECT DISTINCT s.snapshot_ciphertext FROM workflow_subworkflow_invocations s JOIN workflow_operation_attempts a ON a.operation_id=s.operation_id WHERE a.run_id=?")
        .bind(run_id).fetch_all(pool).await?;
    for snapshot in snapshots {
        let value = crate::config::decrypt_data_with_key(&snapshot, key)
            .map_err(|_| anyhow!("Cannot decrypt child snapshot"))?;
        validate_dsl_coverage(&serde_json::from_str::<Value>(&value)?["dsl"])?;
    }
    let unbound:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM remote_tasks t WHERE t.run_id=? AND NOT EXISTS(SELECT 1 FROM workflow_operations o WHERE o.adapter_record_id=t.id) AND NOT EXISTS(SELECT 1 FROM workflow_operation_reviews v WHERE v.remote_record_id=t.id))")
        .bind(run_id).fetch_one(pool).await?;
    if unbound {
        bail!("Legacy remote operation is not bound to the journal; reconcile manually");
    }
    let rows=sqlx::query("SELECT DISTINCT o.*,i.id AS intent_id,i.mode,i.provenance FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id LEFT JOIN workflow_compensation_intents i ON i.operation_id=o.id WHERE a.run_id=? AND o.purpose='execution'")
        .bind(run_id).fetch_all(pool).await?;
    for row in &rows {
        if row.get::<String, _>("status") == "running" {
            bail!("Original operation is still stopping");
        }
        if row.get::<bool, _>("confirmed_no_effect") || row.get::<Option<String>, _>("dispatched_at").is_none() {
            continue;
        }
        let adapter: String = row.get("adapter");
        if adapter == "subworkflow" {
            let saved: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workflow_subworkflow_invocations WHERE operation_id=?)",
            )
            .bind(row.get::<String, _>("id"))
            .fetch_one(pool)
            .await?;
            if !saved {
                bail!("Child invocation has no durable snapshot; reconcile manually");
            }
            if row.get::<Option<String>, _>("mode").as_deref() != Some("delegated") {
                bail!("Child effects have no delegation contract");
            }
            continue;
        }
        if row.get::<String, _>("status") != "succeeded" || row.get::<Option<String>, _>("result_json").is_none() {
            bail!("Original operation outcome is unresolved; reconcile before compensation");
        }
        if row.get::<i64, _>("dependencies_recorded") != 1 {
            bail!("Legacy operation has no durable dependency order; manual compensation required");
        }
        if row.get::<Option<String>, _>("provenance").as_deref() != Some("before_dispatch") {
            bail!("Original effect has no before-dispatch compensation contract; manual remediation required");
        }
        match row.get::<Option<String>, _>("mode").as_deref() {
            Some("read_only") => {},
            Some("compensatable") => {
                saga::arguments(pool, key, &row.get::<String, _>("id")).await?;
            },
            Some("irreversible") => bail!("Task contains an irreversible operation; manual remediation required"),
            _ => bail!("Task contains an operation without a compensation contract; manual remediation required"),
        }
    }
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE workflow_compensation_intents SET status='pending',updated_at=? WHERE status='not_requested' AND mode='compensatable' AND operation_id IN (SELECT o.id FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id WHERE a.run_id=? AND o.dispatched_at IS NOT NULL AND o.confirmed_no_effect=0 AND o.purpose='execution')")
        .bind(chrono::Utc::now().to_rfc3339()).bind(run_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(super) async fn next_intent(pool: &sqlx::SqlitePool, run_id: &str) -> Result<Option<(String, String)>> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let next:Option<(String,String)>=sqlx::query_as("SELECT i.id,i.operation_id FROM workflow_compensation_intents i WHERE i.status='pending' AND EXISTS(SELECT 1 FROM workflow_operations original WHERE original.id=i.operation_id AND original.confirmed_no_effect=0) AND EXISTS(SELECT 1 FROM workflow_operation_attempts a WHERE a.operation_id=i.operation_id AND a.run_id=?) AND NOT EXISTS(SELECT 1 FROM workflow_operation_dependencies d JOIN workflow_compensation_intents successor ON successor.operation_id=d.operation_id JOIN workflow_operations successor_op ON successor_op.id=successor.operation_id WHERE d.predecessor_id=i.operation_id AND successor_op.confirmed_no_effect=0 AND successor.mode='compensatable' AND successor.status!='succeeded') ORDER BY i.created_at DESC,i.id LIMIT 1")
        .bind(run_id).fetch_optional(&mut *tx).await?;
    if let Some((id, _)) = &next {
        sqlx::query("UPDATE workflow_compensation_intents SET status='running',updated_at=? WHERE id=?")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(next)
}

/// One bounded work item per tick. The SQLite claim survives renderer loss;
/// shutdown never starts another item and startup reopens an interrupted claim.
pub(crate) async fn tick(pool: sqlx::SqlitePool, key: Vec<u8>, run_id: &str) -> Result<()> {
    if process_cleanup::is_automatic(&pool, run_id).await? {
        return process_cleanup::tick(&pool, &key, run_id).await;
    }

    let result = process_plan(&pool, &key, run_id, |intent, operation| {
        let pool = &pool;
        let key = &key;
        async move { saga::execute_compensation(pool, key, run_id, &intent, &operation).await }
    })
    .await;
    if result.is_err() {
        // Errors may include credentials/arguments from an executor. Keep only
        // an actionable, non-sensitive classification in the public journal.
        plan_status(&pool,run_id,"blocked",Some("Compensation blocked; inspect operation status and reconcile unresolved effects or restore the original contract")).await?;
    }
    result
}

async fn process_plan<F, Fut>(pool: &sqlx::SqlitePool, key: &[u8], run_id: &str, execute: F) -> Result<()>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id=?")
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    if matches!(status.as_str(), "queued" | "running" | "waiting_for_input") {
        plan_status(pool, run_id, "pending", Some("Waiting for original execution to stop")).await?;
        return Ok(());
    }
    // Reconcile existing Remote task identities, never create new forward work.
    if super::remote_agent::reconcile_abandoned_operations(pool, key, run_id).await? {
        plan_status(
            pool,
            run_id,
            "pending",
            Some("Waiting for existing Remote tasks to reach a confirmed terminal outcome"),
        )
        .await?;
        return Ok(());
    }
    if let Err(error) = prepare_plan(pool, key, run_id).await {
        plan_status(pool, run_id, "blocked", Some(&error.to_string())).await?;
        return Err(error);
    }
    let Some((intent, operation_id)) = next_intent(pool, run_id).await? else {
        let remaining:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_compensation_intents i JOIN workflow_operation_attempts a ON a.operation_id=i.operation_id JOIN workflow_operations o ON o.id=i.operation_id WHERE a.run_id=? AND i.mode='compensatable' AND o.dispatched_at IS NOT NULL AND o.confirmed_no_effect=0 AND i.status!='succeeded')")
            .bind(run_id).fetch_one(pool).await?;
        if remaining {
            bail!("Compensation dependencies remain unresolved");
        }
        plan_status(pool, run_id, "completed", None).await?;
        return Ok(());
    };
    let outcome = execute(intent.clone(), operation_id).await;
    let (status, error) = match &outcome {
        Ok(_) => ("succeeded", None),
        Err(_) => {
            let submitted: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE purpose='compensation' AND execution_id=? AND execution_path=? AND dispatched_at IS NOT NULL AND result_json IS NULL)")
                .bind(format!("compensation:{run_id}")).bind(&intent).fetch_one(pool).await?;
            if submitted {
                (
                    "blocked",
                    Some("Compensation result pending confirmation; reconcile the existing operation before retrying"),
                )
            } else {
                (
                    "failed",
                    Some(
                        "Compensation did not start; restore its saved target/contract or required approval before retrying",
                    ),
                )
            }
        },
    };
    sqlx::query(
        "UPDATE workflow_compensation_intents SET status=?,last_error=?,updated_at=? WHERE id=? AND status='running'",
    )
    .bind(status)
    .bind(error)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(intent)
    .execute(pool)
    .await?;
    outcome?;
    plan_status(pool, run_id, "pending", None).await?;
    Ok(())
}

pub(crate) async fn block_claim(run_id: &str) -> Result<()> {
    plan_status(
        &crate::core::db::DBManager::global().pool()?,
        run_id,
        "blocked",
        Some("Compensation worker interrupted before execution; retry after restoring workspace access"),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::super::operations::Operation;
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    const KEY: &[u8] = &[42; 32];

    async fn pool() -> sqlx::SqlitePool {
        let pool = super::super::remote_tasks::test_pool().await;
        sqlx::query("UPDATE run_records SET status='failed',runtime_json=? WHERE id='run-1'")
            .bind(json!({"kind":"workflow","compensationJournalVersion":1,"dsl":{"nodes":[]}}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    fn snapshot() -> Value {
        json!({"compensation":{"mode":"compensatable","action":{"kind":"remote_agent","url":"https://fixture.invalid/undo"},"bindings":{"resource":{"from":"output","pointer":"/resource"}},"idempotency":{"keyArgument":"requestId","contract":"deduplicate undo by requestId"}}})
    }
    async fn enter(pool: &sqlx::SqlitePool, path: &str) -> Operation {
        let mut op = Operation::enter(pool.clone(), "run-1", path, "run-1", "tool", &json!({}), &snapshot())
            .await
            .unwrap();
        op.prepare_compensation(KEY, &json!({}), &snapshot()).await.unwrap();
        op
    }
    async fn effect(pool: &sqlx::SqlitePool, path: &str) -> String {
        let mut op = enter(pool, path).await;
        op.mark_dispatched().await.unwrap();
        op.finish(Some(&json!({"resource":path})), "succeeded", None)
            .await
            .unwrap();
        op.id.clone()
    }
    async fn ready(pool: &sqlx::SqlitePool) {
        sqlx::query("UPDATE workflow_abandonments SET next_check_at='2000-01-01T00:00:00Z'")
            .execute(pool)
            .await
            .unwrap();
        assert_eq!(claim(pool).await.unwrap().as_deref(), Some("run-1"));
    }
    async fn fake_undo(pool: &sqlx::SqlitePool, intent: &str, operation: &str, calls: &AtomicU32) -> Result<()> {
        let args = saga::arguments(pool, KEY, operation).await?;
        let mut op =
            Operation::enter_compensation(pool.clone(), "run-1", intent, "tool", &args, &json!({"fixture":1})).await?;
        let saved = match op.result.clone() {
            Some(saved) => saved,
            None => {
                if !op.can_submit {
                    bail!("Unknown result; must reconcile before dispatch");
                }
                op.mark_dispatched().await?;
                calls.fetch_add(1, Ordering::SeqCst);
                json!({"receipt":"undo-completed"})
            },
        };
        op.finish(Some(&saved), "succeeded", None).await?;
        Ok(())
    }

    #[tokio::test]
    async fn abandonment_fences_dispatch_recovery_and_preserves_execution_status() {
        let pool = pool().await;
        let mut claimed = enter(&pool, "claimed-before-abandon").await;
        request(&pool, "run-1").await.unwrap();
        request(&pool, "run-1").await.unwrap(); // Same durable authorization.
        assert!(claimed.mark_dispatched().await.is_err());
        claimed.finish(None, "failed", None).await.unwrap();
        assert!(
            Operation::enter(pool.clone(), "run-1", "new", "run-1", "tool", &json!({}), &snapshot())
                .await
                .is_err()
        );
        assert!(
            crate::module::run_history::recovery::enqueue_recovery_in_pool(&pool, "run-1", json!({}))
                .await
                .is_err()
        );
        let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id='run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "failed");
        assert_eq!(inspect(&pool, "run-1").await.unwrap().unwrap().total, 0);
    }

    #[tokio::test]
    async fn serial_effects_compensate_in_reverse_order_under_one_task() {
        let pool = pool().await;
        let mut originals = Vec::new();
        for path in ["file", "upload", "publish"] {
            originals.push(effect(&pool, path).await);
        }
        request(&pool, "run-1").await.unwrap();
        let calls = AtomicU32::new(0);
        let mut order = Vec::new();
        for _ in 0..3 {
            ready(&pool).await;
            process_plan(&pool, KEY, "run-1", |intent, operation| {
                let pool = &pool;
                let calls = &calls;
                let order = &mut order;
                async move {
                    order.push(operation.clone());
                    fake_undo(pool, &intent, &operation, calls).await
                }
            })
            .await
            .unwrap();
        }
        originals.reverse();
        assert_eq!(order, originals);
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |_, _| async {
            panic!("All compensations already committed")
        })
        .await
        .unwrap();
        let summary = inspect(&pool, "run-1").await.unwrap().unwrap();
        assert_eq!(
            (summary.status.as_str(), summary.completed, summary.total),
            ("completed", 3, 3)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM run_records")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn parallel_leaves_join_without_false_cycles_and_failed_successor_blocks_predecessors() {
        let pool = pool().await;
        let mut a = enter(&pool, "branch-a").await;
        a.mark_dispatched().await.unwrap();
        let mut b = enter(&pool, "branch-b").await;
        b.mark_dispatched().await.unwrap();
        for (op, resource) in [(&mut a, "a"), (&mut b, "b")] {
            op.finish(Some(&json!({"resource":resource})), "succeeded", None)
                .await
                .unwrap();
        }
        let join = effect(&pool, "join").await;
        let edges: Vec<(String, String)> =
            sqlx::query_as("SELECT operation_id,predecessor_id FROM workflow_operation_dependencies")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(edges.len(), 2);
        assert!(edges.iter().all(|edge| edge.0 == join));
        request(&pool, "run-1").await.unwrap();
        prepare_plan(&pool, KEY, "run-1").await.unwrap();
        let (id, op) = next_intent(&pool, "run-1").await.unwrap().unwrap();
        assert_eq!(op, join);
        sqlx::query("UPDATE workflow_compensation_intents SET status='failed' WHERE id=?")
            .bind(&id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(next_intent(&pool, "run-1").await.unwrap().is_none());
        sqlx::query("UPDATE workflow_compensation_intents SET status='succeeded' WHERE id=?")
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
        let (_, leaf) = next_intent(&pool, "run-1").await.unwrap().unwrap();
        assert!(leaf == a.id || leaf == b.id);
    }

    #[tokio::test]
    async fn confirmed_no_effect_successor_does_not_block_predecessor_undo() {
        let pool = pool().await;
        let predecessor = effect(&pool, "predecessor").await;
        let mut successor = enter(&pool, "successor").await;
        successor.mark_dispatched().await.unwrap();
        successor.finish(None, "unknown", None).await.unwrap();
        request(&pool, "run-1").await.unwrap();
        sqlx::query("UPDATE workflow_abandonments SET status='blocked' WHERE run_id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        let review = operation_review::ReviewRequest {
            run_id: "run-1".into(),
            operation_id: successor.id.clone(),
            expected_attempt: 1,
            stopped_confirmed: true,
            evidence: "Provider confirms no resources created".into(),
            decision: operation_review::Decision::NoEffect,
        };
        operation_review::resolve(&pool, KEY, &review, |_| Ok(()))
            .await
            .unwrap();
        prepare_plan(&pool, KEY, "run-1").await.unwrap();
        let (_, next) = next_intent(&pool, "run-1").await.unwrap().unwrap();
        assert_eq!(next, predecessor);
        assert_eq!(inspect(&pool, "run-1").await.unwrap().unwrap().total, 1);
    }

    #[tokio::test]
    async fn crash_after_undo_receipt_before_intent_ack_reuses_receipt_on_startup() {
        let pool = pool().await;
        effect(&pool, "effect").await;
        request(&pool, "run-1").await.unwrap();
        ready(&pool).await;
        prepare_plan(&pool, KEY, "run-1").await.unwrap();
        let (intent, operation) = next_intent(&pool, "run-1").await.unwrap().unwrap();
        let calls = AtomicU32::new(0);
        fake_undo(&pool, &intent, &operation, &calls).await.unwrap();
        // Kill the worker before updating intent.status. Startup reopens its
        // durable claim; the adapter sees the already committed undo result.
        operations::recover_interrupted(&pool).await.unwrap();
        recover_startup(&pool).await.unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            let calls = &calls;
            async move { fake_undo(pool, &intent, &operation, calls).await }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let attempts:Vec<String>=sqlx::query_scalar("SELECT a.action FROM workflow_operation_attempts a JOIN workflow_operations o ON o.id=a.operation_id WHERE o.purpose='compensation' ORDER BY a.sequence").fetch_all(&pool).await.unwrap();
        assert_eq!(attempts, ["submit", "reuse"]);
    }

    #[tokio::test]
    async fn unknown_original_failure_and_legacy_order_block_every_undo() {
        for state in ["unknown", "failed", "legacy"] {
            let pool = pool().await;
            let id = effect(&pool, "known-success").await;
            if state == "legacy" {
                sqlx::query("UPDATE workflow_operations SET dependencies_recorded=0 WHERE id=?")
                    .bind(id)
                    .execute(&pool)
                    .await
                    .unwrap();
            } else {
                let mut unknown = enter(&pool, "possible-late-effect").await;
                unknown.mark_dispatched().await.unwrap();
                unknown.finish(None, state, None).await.unwrap();
            }
            request(&pool, "run-1").await.unwrap();
            ready(&pool).await;
            assert!(
                process_plan(&pool, KEY, "run-1", |_, _| async { panic!("Unsafe undo dispatch") })
                    .await
                    .is_err()
            );
            assert_eq!(inspect(&pool, "run-1").await.unwrap().unwrap().status, "blocked");
        }
    }

    #[tokio::test]
    async fn failed_pre_dispatch_compensation_can_retry_without_new_identity() {
        let pool = pool().await;
        effect(&pool, "effect").await;
        request(&pool, "run-1").await.unwrap();
        ready(&pool).await;
        let result = process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            async move {
                let args = saga::arguments(pool, KEY, &operation).await?;
                let mut op =
                    Operation::enter_compensation(pool.clone(), "run-1", &intent, "tool", &args, &json!({"fixture":1}))
                        .await?;
                op.finish(None, "failed", Some("Preflight unavailable")).await?;
                bail!("Preflight unavailable")
            }
        })
        .await;
        assert!(result.is_err());
        plan_status(&pool, "run-1", "blocked", Some("Preflight unavailable"))
            .await
            .unwrap();
        retry(&pool, "run-1").await.unwrap();
        let calls = AtomicU32::new(0);
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            let calls = &calls;
            async move { fake_undo(pool, &intent, &operation, calls).await }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operations WHERE purpose='compensation'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        let count:i64=sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operation_attempts a JOIN workflow_operations o ON a.operation_id=o.id WHERE o.purpose='compensation'").fetch_one(&pool).await.unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn unknown_compensation_survives_restart_and_retry_cannot_blindly_resubmit() {
        let pool = pool().await;
        effect(&pool, "effect").await;
        request(&pool, "run-1").await.unwrap();
        prepare_plan(&pool, KEY, "run-1").await.unwrap();
        let (intent, operation) = next_intent(&pool, "run-1").await.unwrap().unwrap();
        let args = saga::arguments(&pool, KEY, &operation).await.unwrap();
        let mut op =
            Operation::enter_compensation(pool.clone(), "run-1", &intent, "tool", &args, &json!({"fixture":1}))
                .await
                .unwrap();
        op.mark_dispatched().await.unwrap();
        op.finish(None, "unknown", Some("Response lost after effect"))
            .await
            .unwrap();
        recover_startup(&pool).await.unwrap();
        let calls = AtomicU32::new(0);
        assert!(fake_undo(&pool, &intent, &operation, &calls).await.is_err());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn claims_once_and_requires_coverage_of_child_and_irreversible_effects() {
        let pool = pool().await;
        effect(&pool, "effect").await;
        request(&pool, "run-1").await.unwrap();
        let (a, b) = tokio::join!(claim(&pool), claim(&pool));
        assert_eq!(usize::from(a.unwrap().is_some()) + usize::from(b.unwrap().is_some()), 1);
        for mode in ["unspecified", "irreversible"] {
            sqlx::query("UPDATE workflow_compensation_intents SET mode=?")
                .bind(mode)
                .execute(&pool)
                .await
                .unwrap();
            assert!(prepare_plan(&pool, KEY, "run-1").await.is_err());
        }
        assert!(validate_dsl_coverage(&json!({"nodes":[{"type":"codeact_agent"}]})).is_err());
    }
}

#[cfg(test)]
mod child_ownership_tests {
    use super::*;

    #[tokio::test]
    async fn incomplete_child_delegates_to_descendant_once_and_loop_effects_reverse() {
        let pool = super::super::remote_tasks::test_pool().await;
        let key = [42; 32];
        sqlx::query("UPDATE run_records SET status='interrupted',runtime_json=? WHERE id='run-1'")
            .bind(json!({"kind":"workflow","compensationJournalVersion":1,"dsl":{"nodes":[{"id":"child","type":"subworkflow"}]}}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        let snapshot = json!({"dsl":{"nodes":[]},"version":1});
        let mut parent = operations::Operation::enter(
            pool.clone(),
            "run-1",
            "parent-child",
            "run-1",
            "subworkflow",
            &json!({}),
            &snapshot,
        )
        .await
        .unwrap();
        parent.prepare_compensation(&key, &json!({}), &snapshot).await.unwrap();
        let invocation = crate::config::encrypt_data_with_key(
            &json!({"dsl":{"nodes":[{"id":"effect","type":"process"}]},"scope":"child-scope"}).to_string(),
            &key,
        )
        .unwrap();
        sqlx::query("INSERT INTO workflow_subworkflow_invocations (operation_id,thread_id,snapshot_ciphertext) VALUES (?,'child-thread',?)").bind(&parent.id).bind(invocation).execute(&pool).await.unwrap();
        parent.mark_dispatched().await.unwrap();
        let mut leaves = Vec::new();
        for step in 0..2 {
            let snapshot = json!({"compensation":{"mode":"compensatable","action":{"kind":"remote_agent","url":"https://fixture.invalid/undo"},"bindings":{},"idempotency":{"keyArgument":"requestId","contract":"deduplicates requests"}}});
            let mut leaf = operations::Operation::enter(
                pool.clone(),
                "run-1",
                &json!(["child-scope", "effect", step, "process"]).to_string(),
                "run-1",
                "process",
                &json!({}),
                &snapshot,
            )
            .await
            .unwrap();
            leaf.prepare_compensation(&key, &json!({}), &snapshot).await.unwrap();
            leaf.mark_dispatched().await.unwrap();
            leaf.finish(Some(&json!({"result":{}})), "succeeded", None)
                .await
                .unwrap();
            leaves.push(leaf.id.clone());
        }
        parent
            .finish(None, "unknown", Some("Child interrupted after leaf effects"))
            .await
            .unwrap();
        request(&pool, "run-1").await.unwrap();
        prepare_plan(&pool, &key, "run-1").await.unwrap();
        for expected in leaves.into_iter().rev() {
            let (intent, operation) = next_intent(&pool, "run-1").await.unwrap().unwrap();
            assert_eq!(operation, expected);
            assert_ne!(operation, parent.id);
            sqlx::query("UPDATE workflow_compensation_intents SET status='succeeded' WHERE id=?")
                .bind(intent)
                .execute(&pool)
                .await
                .unwrap();
        }
        assert!(next_intent(&pool, "run-1").await.unwrap().is_none());
        assert_eq!(inspect(&pool, "run-1").await.unwrap().unwrap().total, 2);
    }
}

#[cfg(test)]
mod legacy_coverage_tests {
    use super::*;

    #[tokio::test]
    async fn absent_legacy_logs_never_prove_no_effects_but_never_started_tasks_are_safe() {
        let pool = super::super::remote_tasks::test_pool().await;
        sqlx::query("UPDATE run_records SET status='failed',runtime_json=? WHERE id='run-1'")
            .bind(json!({"kind":"workflow","dsl":{"nodes":[]}}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            prepare_plan(&pool, &[42; 32], "run-1")
                .await
                .unwrap_err()
                .to_string()
                .contains("coverage")
        );
        sqlx::query("DELETE FROM run_attempts").execute(&pool).await.unwrap();
        sqlx::query("UPDATE run_records SET status='queued'")
            .execute(&pool)
            .await
            .unwrap();
        request(&pool, "run-1").await.unwrap();
        prepare_plan(&pool, &[42; 32], "run-1").await.unwrap();
        assert!(next_intent(&pool, "run-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn read_only_assertion_added_after_dispatch_cannot_waive_original_coverage() {
        let pool = super::super::remote_tasks::test_pool().await;
        sqlx::query("UPDATE run_records SET status='failed',runtime_json=? WHERE id='run-1'")
            .bind(json!({"kind":"workflow","compensationJournalVersion":1,"dsl":{"nodes":[]}}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        let snapshot = json!({"compensation":{"mode":"read_only"}});
        let mut op = operations::Operation::enter(
            pool.clone(),
            "run-1",
            "late-read-only",
            "run-1",
            "tool",
            &json!({}),
            &snapshot,
        )
        .await
        .unwrap();
        op.mark_dispatched().await.unwrap();
        op.prepare_compensation(&[42; 32], &json!({}), &snapshot).await.unwrap();
        op.finish(Some(&json!({"value":1})), "succeeded", None).await.unwrap();
        request(&pool, "run-1").await.unwrap();
        assert!(
            prepare_plan(&pool, &[42; 32], "run-1")
                .await
                .unwrap_err()
                .to_string()
                .contains("before-dispatch")
        );
    }
}
