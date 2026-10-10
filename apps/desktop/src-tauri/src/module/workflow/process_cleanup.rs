//! Automatic failure cleanup is narrower than manual whole-workflow Saga.
//! Only successful same-App invocations participate; failed calls own their cleanup.
use super::*;
use sqlx::Row;

pub(super) async fn is_automatic(pool: &sqlx::SqlitePool, run_id: &str) -> Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT COALESCE(json_extract(runtime_json,'$.automaticProcessCleanup'),0) FROM run_records WHERE id=?",
    )
    .bind(run_id)
    .fetch_one(pool)
    .await?)
}

/// Persist the selected successful calls and fence forward recovery together.
/// The version marker prevents upgrading from retrospectively cleaning old tasks.
pub(crate) async fn request(pool: &sqlx::SqlitePool, key: &[u8], run_id: &str) -> Result<bool> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT target_type,status,runtime_json FROM run_records WHERE id=?")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
    let runtime: Value = serde_json::from_str(&row.get::<String, _>("runtime_json"))?;
    if row.get::<String, _>("target_type") != "workflow"
        || row.get::<String, _>("status") != "failed"
        || runtime["processCleanupVersion"] != 1
        || !runtime["evaluationProfile"].is_null()
    {
        return Ok(false);
    }
    if sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM workflow_abandonments WHERE run_id=?)")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?
    {
        return Ok(true);
    }
    let records=sqlx::query("SELECT DISTINCT i.id,i.context_ciphertext FROM workflow_compensation_intents i JOIN workflow_operations o ON o.id=i.operation_id JOIN workflow_operation_attempts a ON a.operation_id=o.id WHERE a.run_id=? AND o.purpose='execution' AND o.status='succeeded' AND o.result_json IS NOT NULL AND o.confirmed_no_effect=0 AND i.provenance='before_dispatch' AND i.mode='compensatable' AND i.status='not_requested'")
        .bind(run_id).fetch_all(&mut *tx).await?;
    let mut selected = Vec::new();
    for record in records {
        if saga::app_cleanup_metadata(&record.get::<String, _>("context_ciphertext"), key)?.is_some() {
            selected.push(record.get::<String, _>("id"));
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE run_records SET runtime_json=json_set(runtime_json,'$.processCleanupConsidered',json('true')),updated_at=? WHERE id=?")
        .bind(&now).bind(run_id).execute(&mut *tx).await?;
    if selected.is_empty() {
        tx.commit().await?;
        return Ok(false);
    }
    sqlx::query("INSERT INTO workflow_abandonments (run_id,status,requested_at,updated_at,next_check_at) VALUES (?,'pending',?,?,?)")
        .bind(run_id).bind(&now).bind(&now).bind(&now).execute(&mut *tx).await?;
    sqlx::query("UPDATE run_records SET runtime_json=json_set(runtime_json,'$.automaticProcessCleanup',json('true')) WHERE id=?")
        .bind(run_id).execute(&mut *tx).await?;
    for intent in selected {
        sqlx::query("UPDATE workflow_compensation_intents SET status='pending',updated_at=? WHERE id=?")
            .bind(&now)
            .bind(intent)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE run_recovery_jobs SET status='blocked',last_error='Automatic App failure cleanup started',updated_at=? WHERE run_id=?")
        .bind(&now).bind(run_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(true)
}

/// Covers a crash after failure committed but before cleanup was enqueued.
pub(crate) async fn recover_failed(pool: &sqlx::SqlitePool, key: &[u8]) -> Result<()> {
    let ids:Vec<String>=sqlx::query_scalar("SELECT id FROM run_records WHERE target_type='workflow' AND status='failed' AND json_extract(runtime_json,'$.processCleanupVersion')=1 AND COALESCE(json_extract(runtime_json,'$.processCleanupConsidered'),0)=0")
        .fetch_all(pool).await?;
    for id in ids {
        request(pool, key, &id).await?;
    }
    Ok(())
}

pub(super) async fn tick(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    run_id: &str,
    permits: std::sync::Arc<tokio::sync::Semaphore>,
) -> Result<()> {
    process_plan(pool, key, run_id, |intent, operation| async move {
        let _permit = permits.acquire_owned().await?;
        saga::execute_compensation(pool, key, run_id, &intent, &operation).await
    })
    .await
}

async fn process_plan<F, Fut>(pool: &sqlx::SqlitePool, key: &[u8], run_id: &str, execute: F) -> Result<()>
where
    F: FnOnce(String, String) -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let inactive: bool = sqlx::query_scalar("SELECT status='failed' FROM run_records WHERE id=?")
        .bind(run_id)
        .fetch_one(pool)
        .await?;
    if !inactive {
        bail!("Automatic cleanup requires a failed inactive workflow");
    }
    let next:Option<(String,String)>=sqlx::query_as("SELECT i.id,i.operation_id FROM workflow_compensation_intents i JOIN workflow_operations o ON o.id=i.operation_id WHERE i.status='pending' AND EXISTS(SELECT 1 FROM workflow_operation_attempts a WHERE a.operation_id=o.id AND a.run_id=?) AND NOT EXISTS(SELECT 1 FROM workflow_operation_dependencies d JOIN workflow_compensation_intents successor ON successor.operation_id=d.operation_id WHERE d.predecessor_id=o.id AND successor.status IN ('pending','running','failed','blocked')) ORDER BY i.created_at DESC,i.id DESC LIMIT 1")
        .bind(run_id).fetch_optional(pool).await?;
    let Some((intent, operation)) = next else {
        let unfinished:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_compensation_intents i JOIN workflow_operation_attempts a ON a.operation_id=i.operation_id WHERE a.run_id=? AND i.status IN ('pending','running','failed','blocked'))")
            .bind(run_id).fetch_one(pool).await?;
        return saga_scheduler::plan_status(
            pool,
            run_id,
            if unfinished { "blocked" } else { "completed" },
            if unfinished {
                Some("App cleanup has unfinished items; see node messages")
            } else {
                None
            },
        )
        .await;
    };
    let context: String = sqlx::query_scalar("SELECT context_ciphertext FROM workflow_compensation_intents WHERE id=?")
        .bind(&intent)
        .fetch_one(pool)
        .await?;
    let (name, entry) = saga::app_cleanup_metadata(&context, key)?
        .context("Automatic cleanup can only execute the original App entry")?;
    let path: String = sqlx::query_scalar("SELECT execution_path FROM workflow_operations WHERE id=?")
        .bind(&operation)
        .fetch_one(pool)
        .await?;
    message(
        pool, run_id, &intent, &operation, &path, &name, &entry, "running", None, None,
    )
    .await?;
    let outcome = execute(intent.clone(), operation.clone()).await;
    let submitted:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE purpose='compensation' AND execution_id=? AND execution_path=? AND dispatched_at IS NOT NULL AND result_json IS NULL AND confirmed_no_effect=0)")
        .bind(format!("compensation:{run_id}")).bind(&intent).fetch_one(pool).await?;
    let (status, error) = if outcome.is_ok() {
        ("succeeded", None)
    } else if submitted {
        (
            "blocked",
            Some("Compensation result unknown; automatic resubmission disabled"),
        )
    } else {
        (
            "failed",
            Some("Compensation could not start; check the saved App entry and original code"),
        )
    };
    message(
        pool, run_id, &intent, &operation, &path, &name, &entry, status, error, None,
    )
    .await?;
    // A failed item does not suppress independent cleanup. Its predecessors
    // remain fenced because a dependent side effect may still need them.
    saga_scheduler::plan_status(pool, run_id, "pending", None).await
}

pub(super) async fn record_output(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    run_id: &str,
    intent: &str,
    operation: &str,
    output: &str,
) -> Result<()> {
    if output.is_empty() || !is_automatic(pool, run_id).await? {
        return Ok(());
    }
    let context: String = sqlx::query_scalar("SELECT context_ciphertext FROM workflow_compensation_intents WHERE id=?")
        .bind(intent)
        .fetch_one(pool)
        .await?;
    let Some((name, entry)) = saga::app_cleanup_metadata(&context, key)? else {
        return Ok(());
    };
    let path: String = sqlx::query_scalar("SELECT execution_path FROM workflow_operations WHERE id=?")
        .bind(operation)
        .fetch_one(pool)
        .await?;
    message(
        pool,
        run_id,
        intent,
        operation,
        &path,
        &name,
        &entry,
        "running",
        None,
        Some(output),
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn message(
    pool: &sqlx::SqlitePool,
    run_id: &str,
    intent: &str,
    operation: &str,
    path: &str,
    name: &str,
    entry: &str,
    status: &str,
    error: Option<&str>,
    output: Option<&str>,
) -> Result<()> {
    let path: Value = serde_json::from_str(path)?;
    let mut node = path[1].as_str().unwrap_or("").to_owned();
    let mut owner_step = path[2].clone();
    let mut scope = path[0].as_str().unwrap_or("root").to_owned();
    // Child graph messages belong to their visible root invocation row.
    while scope != "root" {
        let Ok(parent) = serde_json::from_str::<Value>(&scope) else {
            break;
        };
        let Some(parent_node) = parent[1].as_str() else {
            break;
        };
        node = parent_node.to_owned();
        owner_step = parent[2].clone();
        let Some(parent_scope) = parent[0].as_str() else {
            break;
        };
        scope = parent_scope.to_owned();
    }

    let event = json!({"type":"custom","node":node,"event_type":"process.compensation","data":{"operationId":operation,"executionPath":path,"ownerStep":owner_step,"appName":name,"entry":entry,"status":status,"error":error,"output":output}});
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE workflow_compensation_intents SET status=?,last_error=?,updated_at=? WHERE id=?")
        .bind(status)
        .bind(error)
        .bind(&now)
        .bind(intent)
        .execute(&mut *tx)
        .await?;
    let sequence: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),-1)+1 FROM run_events WHERE run_id=?")
        .bind(run_id)
        .fetch_one(&mut *tx)
        .await?;
    sqlx::query("INSERT INTO run_events (run_id,sequence,event_json,created_at) VALUES (?,?,?,?)")
        .bind(run_id)
        .bind(sequence)
        .bind(event.to_string())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE run_records SET last_sequence=?,updated_at=? WHERE id=?")
        .bind(sequence)
        .bind(now)
        .bind(run_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::module::run_manager::emit_cleanup_event(run_id, sequence, event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::operations::Operation;
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    const KEY: &[u8] = &[42; 32];
    async fn test_pool() -> sqlx::SqlitePool {
        let pool = remote_tasks::test_pool().await;
        sqlx::query("CREATE TABLE run_events (run_id TEXT,sequence INTEGER,event_json TEXT,created_at TEXT,PRIMARY KEY(run_id,sequence))").execute(&pool).await.unwrap();
        sqlx::query("UPDATE run_records SET runtime_json=? WHERE id='run-1'")
            .bind(json!({"kind":"workflow","processCleanupVersion":1}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        pool
    }
    async fn app(
        pool: &sqlx::SqlitePool,
        directory: &tempfile::TempDir,
        node: &str,
        adapter: &str,
        status: &str,
        configured: bool,
    ) -> String {
        let id = "019b812d-4958-7d37-8a45-47e1e20a4744";
        let root = directory.path().join(id);
        std::fs::create_dir_all(&root).unwrap();
        for name in ["main.py", "compensate.py", "uv.lock", "pyproject.toml"] {
            std::fs::write(root.join(name), "fixture").unwrap();
        }
        let mut definition = json!({"id":id,"name":node,"version":"0.1.0","entry":"main.py","projectRoot":directory.path(),"kind":if adapter=="tool" {"tool"} else {"workflow"},"toolExecutionPolicy":"ask_every_time"});
        if configured {
            definition["compensation"] = json!({"entry":"compensate.py"});
        }
        let snapshot = if adapter == "tool" {
            json!({"app":definition})
        } else {
            json!({"definition":definition})
        };
        let input = json!({"original":"input"});
        let path = json!(["root", node, 0, adapter]).to_string();
        let mut op = Operation::enter(pool.clone(), "run-1", &path, "run-1", adapter, &input, &snapshot)
            .await
            .unwrap();
        op.prepare_compensation(KEY, &input, &snapshot).await.unwrap();
        op.mark_dispatched().await.unwrap();
        let value = if adapter == "tool" {
            json!({"fileId":node})
        } else {
            json!({"exitCode":0,"result":{"fileId":node}})
        };
        let encrypted = crate::config::encrypt_data_with_key(&value.to_string(), KEY).unwrap();
        let result = if adapter == "tool" {
            json!({"toolResultCiphertext":encrypted})
        } else {
            json!({"processResultCiphertext":encrypted})
        };
        op.finish(if status == "succeeded" { Some(&result) } else { None }, status, None)
            .await
            .unwrap();
        op.id.clone()
    }
    async fn fail(pool: &sqlx::SqlitePool) {
        sqlx::query("UPDATE run_records SET status='failed',error='original workflow failure' WHERE id='run-1'")
            .execute(pool)
            .await
            .unwrap();
    }
    async fn undo(pool: &sqlx::SqlitePool, intent: &str, operation: &str, calls: &AtomicU32) -> Result<()> {
        let args = saga::arguments(pool, KEY, operation).await?;
        let mut op = Operation::enter_compensation(pool.clone(), "run-1", intent, "process", &args, &json!({})).await?;
        let saved = if let Some(result) = &op.result {
            result.clone()
        } else {
            if !op.can_submit {
                op.finish(None, "unknown", None).await?;
                bail!("Cannot resend unknown cleanup");
            }
            op.mark_dispatched().await?;
            calls.fetch_add(1, Ordering::SeqCst);
            json!({"receipt":"removed"})
        };
        op.finish(Some(&saved), "succeeded", None).await
    }
    async fn ready(pool: &sqlx::SqlitePool) {
        sqlx::query("UPDATE workflow_abandonments SET next_check_at='2000-01-01T00:00:00Z'")
            .execute(pool)
            .await
            .unwrap();
        assert_eq!(saga_scheduler::claim(pool).await.unwrap().as_deref(), Some("run-1"));
    }
    #[tokio::test]
    async fn failure_cleans_successful_apps_and_tool_calls_in_reverse_order_without_approval() {
        let pool = test_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let a = app(&pool, &directory, "generate", "process", "succeeded", true).await;
        let b = app(&pool, &directory, "upload", "tool", "succeeded", true).await;
        app(&pool, &directory, "failed", "process", "failed", true).await;
        app(&pool, &directory, "unknown", "process", "unknown", true).await;
        app(&pool, &directory, "no-entry", "process", "succeeded", false).await;
        fail(&pool).await;
        assert!(request(&pool, KEY, "run-1").await.unwrap());
        assert!(request(&pool, KEY, "run-1").await.unwrap());
        let calls = AtomicU32::new(0);
        let mut order = Vec::new();
        for _ in 0..3 {
            ready(&pool).await;
            process_plan(&pool, KEY, "run-1", |intent, operation| {
                order.push(operation.clone());
                let pool = &pool;
                let calls = &calls;
                async move { undo(pool, &intent, &operation, calls).await }
            })
            .await
            .unwrap();
        }
        assert_eq!(order, vec![b, a]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        let summary = saga_scheduler::inspect(&pool, "run-1").await.unwrap().unwrap();
        assert!(summary.automatic);
        assert_eq!(summary.status, "completed");
        assert_eq!((summary.completed, summary.total), (2, 2));
        let approval_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_compensation_approvals")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(approval_count, 0);
        let error: String = sqlx::query_scalar("SELECT error FROM run_records WHERE id='run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(error, "original workflow failure");
        let events: Vec<String> = sqlx::query_scalar("SELECT event_json FROM run_events ORDER BY sequence")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(events.len(), 4);
        assert_eq!(serde_json::from_str::<Value>(&events[0]).unwrap()["node"], "upload");
        let mut tx = pool.begin().await.unwrap();
        assert!(saga_scheduler::ensure_continuable(&mut tx, "run-1").await.is_err());
    }
    #[tokio::test]
    async fn completion_stop_evaluation_and_missing_entry_do_not_trigger_cleanup() {
        for status in ["completed", "cancelled", "interrupted"] {
            let pool = test_pool().await;
            let directory = tempfile::tempdir().unwrap();
            app(&pool, &directory, "generate", "process", "succeeded", true).await;
            sqlx::query("UPDATE run_records SET status=? WHERE id='run-1'")
                .bind(status)
                .execute(&pool)
                .await
                .unwrap();
            assert!(!request(&pool, KEY, "run-1").await.unwrap());
        }
        for field in ["evaluationProfile", "legacy"] {
            let pool = test_pool().await;
            let directory = tempfile::tempdir().unwrap();
            app(&pool, &directory, "configured", "process", "succeeded", true).await;
            fail(&pool).await;
            let runtime = if field == "legacy" {
                json!({"kind":"workflow"})
            } else {
                json!({"kind":"workflow","processCleanupVersion":1,"evaluationProfile":{"fixtures":[]}})
            };
            sqlx::query("UPDATE run_records SET runtime_json=?")
                .bind(runtime.to_string())
                .execute(&pool)
                .await
                .unwrap();
            assert!(!request(&pool, KEY, "run-1").await.unwrap());
        }
        let pool = test_pool().await;
        let directory = tempfile::tempdir().unwrap();
        app(&pool, &directory, "unconfigured", "process", "succeeded", false).await;
        fail(&pool).await;
        assert!(!request(&pool, KEY, "run-1").await.unwrap());
        sqlx::query("UPDATE run_records SET status='running'")
            .execute(&pool)
            .await
            .unwrap();
        app(&pool, &directory, "later-success", "process", "succeeded", true).await;
        fail(&pool).await;
        assert!(request(&pool, KEY, "run-1").await.unwrap());
    }
    #[tokio::test]
    async fn failure_of_one_cleanup_does_not_suppress_an_independent_branch() {
        let pool = test_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let a = app(&pool, &directory, "a", "process", "succeeded", true).await;
        let b = app(&pool, &directory, "b", "process", "succeeded", true).await;
        sqlx::query("DELETE FROM workflow_operation_dependencies")
            .execute(&pool)
            .await
            .unwrap();
        fail(&pool).await;
        request(&pool, KEY, "run-1").await.unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |_, _| async { bail!("preflight failure") })
            .await
            .unwrap();
        ready(&pool).await;
        let calls = AtomicU32::new(0);
        process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            let calls = &calls;
            async move {
                assert!(operation == a || operation == b);
                undo(pool, &intent, &operation, calls).await
            }
        })
        .await
        .unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |_, _| async { panic!("No further work") })
            .await
            .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            saga_scheduler::inspect(&pool, "run-1").await.unwrap().unwrap().status,
            "blocked"
        );
    }
    #[tokio::test]
    async fn startup_reuses_committed_undo_receipt_and_never_resends_unknown_cleanup() {
        let pool = test_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let operation = app(&pool, &directory, "generate", "process", "succeeded", true).await;
        fail(&pool).await;
        recover_failed(&pool, KEY).await.unwrap();
        ready(&pool).await;
        let intent: String = sqlx::query_scalar("SELECT id FROM workflow_compensation_intents WHERE operation_id=?")
            .bind(&operation)
            .fetch_one(&pool)
            .await
            .unwrap();
        let calls = AtomicU32::new(0);
        undo(&pool, &intent, &operation, &calls).await.unwrap();
        sqlx::query("UPDATE workflow_compensation_intents SET status='running'")
            .execute(&pool)
            .await
            .unwrap();
        saga_scheduler::recover_startup(&pool).await.unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            let calls = &calls;
            async move { undo(pool, &intent, &operation, calls).await }
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let pool = test_pool().await;
        let directory = tempfile::tempdir().unwrap();
        let operation = app(&pool, &directory, "unknown-undo", "process", "succeeded", true).await;
        fail(&pool).await;
        request(&pool, KEY, "run-1").await.unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |intent, operation| {
            let pool = &pool;
            async move {
                let args = saga::arguments(pool, KEY, &operation).await?;
                let mut op =
                    Operation::enter_compensation(pool.clone(), "run-1", &intent, "process", &args, &json!({})).await?;
                op.mark_dispatched().await?;
                op.finish(None, "unknown", None).await?;
                bail!("Lost receipt")
            }
        })
        .await
        .unwrap();
        saga_scheduler::recover_startup(&pool).await.unwrap();
        ready(&pool).await;
        process_plan(&pool, KEY, "run-1", |_, _| async {
            panic!("Unknown cleanup must not be resent")
        })
        .await
        .unwrap();
        assert_eq!(
            saga_scheduler::inspect(&pool, "run-1").await.unwrap().unwrap().status,
            "blocked"
        );
        assert!(!operation.is_empty());
    }
}
