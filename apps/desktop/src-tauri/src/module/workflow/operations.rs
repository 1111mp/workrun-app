//! Common durable execution gate. Adapter facts remain in their own records.
use anyhow::{Context, Result, bail};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};

pub(super) fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}

#[derive(Clone, Copy, serde::Serialize)]
pub(super) struct ExecutionCapabilities {
    pub reuse_result: bool,
    pub reconcile_existing: bool,
}

#[derive(PartialEq, Eq)]
pub(super) enum ExecutionAction {
    Submit,
    Reconcile,
    Reuse,
}

pub(super) struct Operation {
    pub id: String,
    pub adapter_record_id: Option<String>,
    pub result: Option<Value>,
    pub can_submit: bool,
    pool: SqlitePool,
    attempt_id: String,
    adapter: String,
    saga_key: Option<Vec<u8>>,
    finished: bool,
}

impl Operation {
    /// The unique path and conditional claim serialize recovery without keeping
    /// a SQLite transaction open across external I/O.
    pub async fn enter(
        pool: SqlitePool,
        execution_id: &str,
        path: &str,
        run_id: &str,
        adapter: &str,
        input: &Value,
        snapshot: &Value,
    ) -> Result<Self> {
        Self::enter_with_purpose(pool, execution_id, path, run_id, adapter, input, snapshot, false).await
    }

    pub(super) async fn enter_compensation(
        pool: SqlitePool,
        run_id: &str,
        intent_id: &str,
        adapter: &str,
        input: &Value,
        snapshot: &Value,
    ) -> Result<Self> {
        Self::enter_with_purpose(
            pool,
            &format!("compensation:{run_id}"),
            intent_id,
            run_id,
            adapter,
            input,
            snapshot,
            true,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn enter_with_purpose(
        pool: SqlitePool,
        execution_id: &str,
        path: &str,
        run_id: &str,
        adapter: &str,
        input: &Value,
        snapshot: &Value,
        compensation: bool,
    ) -> Result<Self> {
        let now = chrono::Utc::now().to_rfc3339();
        let input_digest = digest(input);
        let snapshot_digest = digest(snapshot);
        let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
        if !compensation {
            super::saga_scheduler::ensure_continuable(&mut tx, run_id).await?;
        }
        let purpose = if compensation { "compensation" } else { "execution" };
        let inserted = sqlx::query("INSERT OR IGNORE INTO workflow_operations (id, execution_id, execution_path, adapter, input_digest, snapshot_digest, status, created_at, updated_at, purpose, dependencies_recorded) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, 1)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(execution_id).bind(path).bind(adapter)
            .bind(&input_digest).bind(&snapshot_digest).bind(&now).bind(&now).bind(purpose).execute(&mut *tx).await?.rows_affected();
        let row = sqlx::query("SELECT * FROM workflow_operations WHERE execution_id = ? AND execution_path = ?")
            .bind(execution_id)
            .bind(path)
            .fetch_one(&mut *tx)
            .await?;
        if row.get::<String, _>("input_digest") != input_digest
            || row.get::<String, _>("snapshot_digest") != snapshot_digest
            || row.get::<String, _>("adapter") != adapter
        {
            bail!("Operation input or execution configuration changed; recovery requires the original snapshot");
        }
        let id: String = row.try_get("id")?;
        if row.get::<String, _>("purpose") != purpose {
            bail!("Operation purpose changed");
        }
        if inserted == 1 && !compensation && adapter != "subworkflow" {
            // Persist a conservative happens-before order, including tool calls
            // and child leaves. Parallel calls still in flight have no edge;
            // their later join depends on every completed leaf. Containers do
            // not own effects and must never create parent/child cycles.
            sqlx::query("INSERT INTO workflow_operation_dependencies (operation_id,predecessor_id) SELECT ?,id FROM workflow_operations WHERE execution_id=? AND id!=? AND purpose='execution' AND adapter!='subworkflow' AND status='succeeded' AND dispatched_at IS NOT NULL")
                .bind(&id).bind(execution_id).bind(&id).execute(&mut *tx).await?;
        }
        let no_effect: bool = row.try_get("confirmed_no_effect")?;
        let status: String = row.try_get("status")?;
        let result: Option<String> = row.try_get("result_json")?;
        let adapter_record_id: Option<String> = row.try_get("adapter_record_id")?;
        if status == "running" {
            bail!("Operation is already executing; reconcile after it stops");
        }
        if status == "failed" && !no_effect && row.try_get::<Option<String>, _>("dispatched_at")?.is_some() {
            bail!("Operation definitively failed; business retry is not enabled for this adapter");
        }
        if status == "succeeded" && result.is_none() {
            bail!("Successful operation has no durable result");
        }
        let action = if result.is_some() {
            "reuse"
        } else if no_effect || row.try_get::<Option<String>, _>("dispatched_at")?.is_none() {
            "submit"
        } else {
            "reconcile"
        };
        let changed = sqlx::query(
            "UPDATE workflow_operations SET status = 'running', updated_at = ? WHERE id = ? AND status = ?",
        )
        .bind(&now)
        .bind(&id)
        .bind(&status)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if changed != 1 {
            bail!("Operation was claimed by another execution");
        }
        let attempt_id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO workflow_operation_attempts (id, operation_id, run_id, sequence, action, status, started_at) SELECT ?, ?, ?, COALESCE(MAX(sequence), 0) + 1, ?, 'running', ? FROM workflow_operation_attempts WHERE operation_id = ?")
            .bind(&attempt_id).bind(&id).bind(run_id).bind(action).bind(&now).bind(&id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(Self {
            id,
            adapter_record_id,
            result: result.map(|r| serde_json::from_str(&r)).transpose()?,
            pool,
            attempt_id,
            adapter: adapter.to_owned(),
            saga_key: None,
            can_submit: action == "submit",
            finished: false,
        })
    }

    pub async fn mark_dispatched(&self) -> Result<()> {
        // Persist before send, including the ambiguous crash just before I/O.
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let needs_approval: bool = sqlx::query_scalar("SELECT approval_required FROM workflow_operations WHERE id=?")
            .bind(&self.id)
            .fetch_one(&mut *tx)
            .await?;
        if needs_approval {
            let consumed=sqlx::query("UPDATE workflow_compensation_approvals SET status='consumed',consumed_at=? WHERE operation_id=? AND status='granted'")
                .bind(chrono::Utc::now().to_rfc3339()).bind(&self.id).execute(&mut *tx).await?.rows_affected();
            if consumed != 1 {
                bail!("Compensation approval is missing or already consumed");
            }
        }
        let changed = sqlx::query("UPDATE workflow_operations SET confirmed_no_effect=0, dispatched_at = COALESCE(dispatched_at, ?) WHERE id = ? AND (purpose='compensation' OR NOT EXISTS(SELECT 1 FROM workflow_operation_attempts a JOIN workflow_abandonments b ON b.run_id=a.run_id WHERE a.operation_id=workflow_operations.id)) AND (compensation_required = 0 OR EXISTS(SELECT 1 FROM workflow_compensation_intents WHERE operation_id = workflow_operations.id))")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&self.id)
            .execute(&mut *tx)
            .await?.rows_affected();
        if changed != 1 {
            bail!("Workflow was abandoned or compensation intent is missing; external dispatch blocked");
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn prepare_compensation(&mut self, key: &[u8], input: &Value, snapshot: &Value) -> Result<()> {
        let declaration = super::saga::execution_declaration(snapshot, self.adapter == "subworkflow")?;
        super::saga::prepare(&self.pool, key, &self.id, &declaration, input, snapshot).await?;
        self.saga_key = Some(key.to_vec());
        Ok(())
    }

    /// A missing local resource invalidates this reuse attempt, not the saved
    /// external success. Preserve that fact so recovery never submits again.
    pub async fn fail_reuse(&mut self, error: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE workflow_operations SET status = 'succeeded', updated_at = ? WHERE id = ? AND result_json IS NOT NULL")
            .bind(&now).bind(&self.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE workflow_operation_attempts SET status = 'failed', error_summary = ?, ended_at = ? WHERE id = ? AND status = 'running'")
            .bind(error).bind(&now).bind(&self.attempt_id).execute(&mut *tx).await?;
        tx.commit().await?;
        self.finished = true;
        Ok(())
    }

    pub async fn record_retryability(&self, retryable: bool) -> Result<()> {
        sqlx::query("UPDATE workflow_operations SET last_error_retryable = ? WHERE id = ?")
            .bind(retryable)
            .bind(&self.id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub fn action(&self, capabilities: ExecutionCapabilities) -> Result<ExecutionAction> {
        if self.result.is_some() {
            if !capabilities.reuse_result {
                bail!("Adapter cannot reuse saved results");
            }
            return Ok(ExecutionAction::Reuse);
        }
        if self.can_submit {
            return Ok(ExecutionAction::Submit);
        }
        if !capabilities.reconcile_existing {
            bail!("Adapter requires manual reconciliation");
        }
        // An unknown outcome never authorizes a new business submission.
        Ok(ExecutionAction::Reconcile)
    }

    pub async fn finish(&mut self, result: Option<&Value>, status: &str, error: Option<&str>) -> Result<()> {
        if !matches!(status, "succeeded" | "failed" | "unknown") {
            bail!("Invalid operation outcome");
        }
        if status == "succeeded" {
            result.context("Cannot commit success without a result")?;
        }
        let mut tx = self.pool.begin().await?;
        self.persist_outcome(&mut tx, result, status).await?;
        sqlx::query("UPDATE workflow_operation_attempts SET error_summary = ? WHERE id = ?")
            .bind(error)
            .bind(&self.attempt_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        self.finished = true;
        Ok(())
    }
    pub async fn persist_outcome(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
        result: Option<&Value>,
        status: &str,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE workflow_operations SET status = CASE WHEN ? != 'succeeded' AND (dispatched_at IS NULL OR confirmed_no_effect=1) THEN 'pending' ELSE ? END, result_json = COALESCE(?, result_json), last_error_retryable = CASE WHEN ? = 'succeeded' THEN NULL ELSE last_error_retryable END, updated_at = ? WHERE id = ?")
            .bind(status).bind(status).bind(result.map(Value::to_string)).bind(status).bind(&now).bind(&self.id).execute(&mut **tx).await?;
        sqlx::query(
            "UPDATE workflow_operation_attempts SET status = ?, ended_at = ? WHERE id = ? AND status = 'running'",
        )
        .bind(status)
        .bind(&now)
        .bind(&self.attempt_id)
        .execute(&mut **tx)
        .await?;
        if let (Some(key), Some(result)) = (&self.saga_key, result) {
            super::saga::capture_outcome(tx, key, &self.id, result).await?;
        }
        Ok(())
    }

    pub fn committed(&mut self) {
        self.finished = true;
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        let pool = self.pool.clone();
        let id = self.id.clone();
        let attempt = self.attempt_id.clone();
        // Drop is best effort; startup reconciliation closes the same window
        // after a hard exit. Losing a future never proves external failure.
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let now = chrono::Utc::now().to_rfc3339();
                let Ok(mut tx) = pool.begin().await else { return };
                let _ = sqlx::query("UPDATE workflow_operations SET status = CASE WHEN result_json IS NOT NULL THEN 'succeeded' WHEN dispatched_at IS NULL OR confirmed_no_effect=1 THEN 'pending' ELSE 'unknown' END, updated_at = ? WHERE id = ? AND status = 'running'")
                    .bind(&now).bind(id).execute(&mut *tx).await;
                let _ = sqlx::query("UPDATE workflow_operation_attempts SET status = 'unknown', ended_at = ? WHERE id = ? AND status = 'running'")
                    .bind(now).bind(attempt).execute(&mut *tx).await;
                let _ = tx.commit().await;
            });
        }
    }
}

pub(crate) async fn recover_interrupted(pool: &SqlitePool) -> Result<()> {
    let mut tx = pool.begin().await?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE workflow_operations SET status = CASE WHEN result_json IS NOT NULL THEN 'succeeded' WHEN dispatched_at IS NULL OR confirmed_no_effect=1 THEN 'pending' ELSE 'unknown' END, updated_at = ? WHERE status = 'running'")
        .bind(&now).execute(&mut *tx).await?;
    sqlx::query("UPDATE workflow_operation_attempts SET status = 'unknown', ended_at = ? WHERE status = 'running'")
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Validate a checkpoint's operation without claiming or submitting anything.
pub(crate) async fn validate_recovery(
    pool: &SqlitePool,
    execution_id: &str,
    path: &str,
    automatic: bool,
) -> Result<()> {
    let row = sqlx::query("SELECT o.status, o.result_json, o.dispatched_at, o.last_error_retryable, o.confirmed_no_effect, t.task_id, t.result_json AS remote_result FROM workflow_operations o LEFT JOIN remote_tasks t ON t.id = o.adapter_record_id WHERE o.execution_id = ? AND o.execution_path = ?")
        .bind(execution_id).bind(path).fetch_optional(pool).await?;
    let Some(row) = row else { return Ok(()) }; // The node has never submitted.
    if row.try_get::<Option<String>, _>("result_json")?.is_some()
        || row.try_get::<Option<String>, _>("remote_result")?.is_some()
    {
        return Ok(());
    }
    if row.try_get::<bool, _>("confirmed_no_effect")? {
        return Ok(());
    }
    let status: String = row.try_get("status")?;
    if status == "running" {
        bail!("The previous operation is still stopping; retry shortly");
    }
    if row.try_get::<Option<String>, _>("dispatched_at")?.is_none() {
        if automatic && row.try_get::<Option<bool>, _>("last_error_retryable")? == Some(false) {
            bail!("The last adapter error requires manual recovery");
        }
        return Ok(());
    }
    if status == "failed" {
        bail!("Remote operation definitively failed; this adapter has no safe business resubmission contract");
    }
    if row.try_get::<Option<String>, _>("task_id")?.is_none() {
        bail!("Result pending confirmation: no remote task ID was saved; automatic resubmission is disabled");
    }
    if automatic && row.try_get::<Option<bool>, _>("last_error_retryable")? == Some(false) {
        bail!("The last adapter error requires manual recovery");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn stable_identity_reuses_output_and_retains_attempts_across_runs() {
        let pool = super::super::remote_tasks::test_pool().await;
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-2', 'running')")
            .execute(&pool)
            .await
            .unwrap();
        let input = json!({"file":"fixture"});
        let snapshot = json!({"version":1});
        let mut first = Operation::enter(
            pool.clone(),
            "business-1",
            "root/node/0",
            "run-1",
            "remote_agent",
            &input,
            &snapshot,
        )
        .await
        .unwrap();
        assert!(first.can_submit);
        let id = first.id.clone();
        assert!(
            Operation::enter(
                pool.clone(),
                "business-1",
                "root/node/0",
                "run-2",
                "remote_agent",
                &input,
                &snapshot
            )
            .await
            .is_err()
        );
        let output = json!({"response":"published", "artifacts":[]});
        first.finish(Some(&output), "succeeded", None).await.unwrap();
        let mut resumed = Operation::enter(
            pool.clone(),
            "business-1",
            "root/node/0",
            "run-2",
            "remote_agent",
            &input,
            &snapshot,
        )
        .await
        .unwrap();
        assert_eq!(resumed.id, id);
        assert_eq!(resumed.result, Some(output.clone()));
        assert!(!resumed.can_submit);
        resumed.finish(Some(&output), "succeeded", None).await.unwrap();
        let history: Vec<(i64, String, String)> = sqlx::query_as(
            "SELECT sequence, action, status FROM workflow_operation_attempts WHERE operation_id = ? ORDER BY sequence",
        )
        .bind(&id)
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            history,
            vec![
                (1, "submit".into(), "succeeded".into()),
                (2, "reuse".into(), "succeeded".into())
            ]
        );
        assert!(
            Operation::enter(
                pool.clone(),
                "business-1",
                "root/node/0",
                "run-2",
                "remote_agent",
                &json!({"file":"changed"}),
                &snapshot
            )
            .await
            .is_err()
        );
        let mut new_business = Operation::enter(
            pool,
            "business-2",
            "root/node/0",
            "run-2",
            "remote_agent",
            &input,
            &snapshot,
        )
        .await
        .unwrap();
        assert_ne!(new_business.id, id);
        new_business.finish(None, "unknown", None).await.unwrap();
    }

    #[tokio::test]
    async fn preflight_failure_is_retryable_but_dispatch_without_task_id_is_unknown() {
        let pool = super::super::remote_tasks::test_pool().await;
        let mut first = Operation::enter(
            pool.clone(),
            "business",
            "root/remote/0",
            "run-1",
            "remote_agent",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        let id = first.id.clone();
        first
            .finish(None, "failed", Some("discovery unavailable"))
            .await
            .unwrap();
        first.record_retryability(false).await.unwrap();
        assert!(
            validate_recovery(&pool, "business", "root/remote/0", true)
                .await
                .is_err()
        );
        validate_recovery(&pool, "business", "root/remote/0", false)
            .await
            .unwrap();
        let mut next = Operation::enter(
            pool.clone(),
            "business",
            "root/remote/0",
            "run-1",
            "remote_agent",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        assert!(next.can_submit);
        assert_eq!(id, next.id);
        next.mark_dispatched().await.unwrap();
        next.finish(None, "unknown", Some("submission timed out"))
            .await
            .unwrap();
        assert!(
            validate_recovery(&pool, "business", "root/remote/0", false)
                .await
                .unwrap_err()
                .to_string()
                .contains("no remote task ID")
        );
        let history: Vec<String> =
            sqlx::query_scalar("SELECT status FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(history, vec!["failed", "unknown"]);
    }

    #[tokio::test]
    async fn startup_closes_interrupted_attempt_without_allowing_resubmission() {
        let pool = super::super::remote_tasks::test_pool().await;
        let mut first = Operation::enter(
            pool.clone(),
            "business",
            "root/node/0",
            "run-1",
            "remote_agent",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        // Simulate process death: no Drop cleanup runs before startup recovery.
        first.mark_dispatched().await.unwrap();
        first.finished = true;
        recover_interrupted(&pool).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operation_attempts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
        let mut recovered = Operation::enter(
            pool.clone(),
            "business",
            "root/node/0",
            "run-1",
            "remote_agent",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(recovered.id, first.id);
        assert!(!recovered.can_submit);
        recovered.finish(None, "unknown", None).await.unwrap();
        // A later loop iteration and another subworkflow invocation are distinct.
        for path in ["root/node/1", "root/child-2/node/0"] {
            let mut op = Operation::enter(
                pool.clone(),
                "business",
                path,
                "run-1",
                "remote_agent",
                &json!({}),
                &json!({}),
            )
            .await
            .unwrap();
            assert_ne!(op.id, first.id);
            assert!(op.can_submit);
            op.finish(None, "failed", None).await.unwrap();
        }
    }
}
