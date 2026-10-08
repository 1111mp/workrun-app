//! Durable task attempts and recovery jobs; event cursors are never reset.
use super::*;
use serde::Serialize;

pub(crate) async fn enqueue_recovery_in_pool(pool: &sqlx::SqlitePool, id: &str, mut runtime: Value) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    crate::module::workflow::saga_scheduler::ensure_continuable(&mut tx, id).await?;
    if let Some(runtime) = runtime.as_object_mut() {
        runtime.remove("processCleanupConsidered");
    }
    let now = chrono::Utc::now().to_rfc3339();
    if let Some(session_id) = runtime.get("chatSessionId").and_then(Value::as_str) {
        let active: Option<String> = sqlx::query_scalar("SELECT active_run_id FROM chat_sessions WHERE id = ?")
            .bind(session_id)
            .fetch_one(&mut *tx)
            .await?;
        let latest: Option<String> =
            sqlx::query_scalar("SELECT run_id FROM chat_turns WHERE session_id = ? ORDER BY sequence DESC LIMIT 1")
                .bind(session_id)
                .fetch_optional(&mut *tx)
                .await?;
        if active.as_deref().is_some_and(|other| other != id) || latest.as_deref() != Some(id) {
            bail!("Only the latest inactive conversation turn can be continued");
        }
        sqlx::query("UPDATE chat_sessions SET active_run_id = ?, updated_at = ? WHERE id = ?")
            .bind(id)
            .bind(&now)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        sqlx::query("UPDATE chat_turns SET status = 'queued', completed_at = NULL WHERE run_id = ?")
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    let changed = sqlx::query("UPDATE run_records SET status = 'queued', ended_at = NULL, error = NULL, duration_ms = NULL, runtime_json = ?, updated_at = ? WHERE id = ? AND target_type = 'workflow' AND status IN ('failed','interrupted')")
        .bind(runtime.to_string()).bind(&now).bind(id).execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        bail!("workflow is no longer available for recovery: {id}");
    }
    sqlx::query("UPDATE run_recovery_jobs SET status = 'done', updated_at = ? WHERE run_id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn begin_attempt(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, id: &str) -> Result<()> {
    sqlx::query("INSERT INTO run_attempts (id, run_id, sequence, status, started_at) SELECT ?, ?, COALESCE(MAX(sequence), 0) + 1, 'running', ? FROM run_attempts WHERE run_id = ?")
        .bind(uuid::Uuid::new_v4().to_string()).bind(id).bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn complete_attempt(pool: &sqlx::SqlitePool, id: &str) -> Result<()> {
    sqlx::query("UPDATE run_attempts SET status = (SELECT status FROM run_records WHERE id = ?), ended_at = ?, error = (SELECT error FROM run_records WHERE id = ?), output_view_json = (SELECT output_view_json FROM run_records WHERE id = ?) WHERE run_id = ? AND status = 'running'")
        .bind(id).bind(chrono::Utc::now().to_rfc3339()).bind(id).bind(id).bind(id).execute(pool).await?;
    Ok(())
}

pub(crate) async fn schedule(pool: &sqlx::SqlitePool, id: &str, error: Option<&str>) -> Result<()> {
    let now = chrono::Utc::now();
    let attempts: i64 =
        sqlx::query_scalar("SELECT COALESCE((SELECT attempts FROM run_recovery_jobs WHERE run_id = ?), 0)")
            .bind(id)
            .fetch_one(pool)
            .await?;
    let delay = 10 * (1_i64 << attempts.min(5));
    sqlx::query("INSERT INTO run_recovery_jobs (run_id, status, next_check_at, last_error, updated_at) VALUES (?, 'pending', ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET status = CASE WHEN attempts >= 5 THEN 'blocked' ELSE 'pending' END, next_check_at = excluded.next_check_at, last_error = excluded.last_error, updated_at = excluded.updated_at")
        .bind(id).bind((now + chrono::Duration::seconds(delay)).to_rfc3339()).bind(error).bind(now.to_rfc3339()).execute(pool).await?;
    Ok(())
}

pub(crate) async fn claim_recovery(pool: &sqlx::SqlitePool) -> Result<Option<String>> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let now = chrono::Utc::now().to_rfc3339();
    let id: Option<String> = sqlx::query_scalar("SELECT j.run_id FROM run_recovery_jobs j JOIN run_records r ON r.id = j.run_id WHERE j.status = 'pending' AND j.attempts < 5 AND j.next_check_at <= ? AND r.status IN ('failed','interrupted') AND NOT EXISTS(SELECT 1 FROM workflow_abandonments b WHERE b.run_id=r.id) ORDER BY j.next_check_at LIMIT 1")
        .bind(&now).fetch_optional(&mut *tx).await?;
    if let Some(id) = &id {
        sqlx::query(
            "UPDATE run_recovery_jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE run_id = ?",
        )
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(id)
}

pub(crate) async fn recover_startup(pool: &sqlx::SqlitePool) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE run_attempts SET status = COALESCE((SELECT CASE WHEN status IN ('queued','running') THEN 'interrupted' ELSE status END FROM run_records WHERE id = run_attempts.run_id), 'interrupted'), ended_at = ?, error = COALESCE((SELECT error FROM run_records WHERE id = run_attempts.run_id), 'Workrun exited during this attempt'), output_view_json = (SELECT output_view_json FROM run_records WHERE id = run_attempts.run_id) WHERE status = 'running'")
        .bind(&now).execute(&mut *tx).await?;
    sqlx::query("UPDATE run_recovery_jobs SET status = CASE WHEN attempts >= 5 THEN 'blocked' ELSE 'pending' END, updated_at = ? WHERE status = 'running'")
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    // Only journaled Remote operations are candidates. The worker validates the
    // checkpoint frontier before executing; unjournaled adapters stay manual.
    sqlx::query("INSERT INTO run_recovery_jobs (run_id, status, next_check_at, updated_at) SELECT DISTINCT a.run_id, 'pending', ?, ? FROM workflow_operation_attempts a JOIN workflow_operations o ON o.id = a.operation_id JOIN run_records r ON r.id = a.run_id WHERE r.status = 'interrupted' AND o.adapter = 'remote_agent' ON CONFLICT(run_id) DO UPDATE SET status = CASE WHEN attempts >= 5 THEN 'blocked' ELSE 'pending' END, next_check_at = excluded.next_check_at, updated_at = excluded.updated_at WHERE run_recovery_jobs.status != 'blocked'")
        .bind(&now).bind(&now).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn block_job(pool: &sqlx::SqlitePool, id: &str, error: &str) -> Result<()> {
    sqlx::query("UPDATE run_recovery_jobs SET status = 'blocked', last_error = ?, updated_at = ? WHERE run_id = ? AND status = 'running'")
        .bind(error)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

impl RunHistoryStore {
    pub async fn enqueue_recovery(id: &str, runtime: Value) -> Result<()> {
        enqueue_recovery_in_pool(&DBManager::global().pool()?, id, runtime).await
    }
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttempt {
    pub sequence: i64,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct OperationAttempt {
    pub sequence: i64,
    pub action: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub error_summary: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationHistory {
    pub id: String,
    pub path: String,
    pub adapter: String,
    pub status: String,
    pub purpose: String,
    pub dispatched: bool,
    pub confirmed_no_effect: bool,
    pub review: Option<crate::module::workflow::operation_review::ReviewSummary>,
    pub approval: Option<crate::module::workflow::operation_review::Approval>,
    pub attempts: Vec<OperationAttempt>,
    pub compensation: Option<crate::module::workflow::saga::Summary>,
}
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryJob {
    pub status: String,
    pub attempts: i64,
    pub next_check_at: String,
    pub last_error: Option<String>,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionHistory {
    pub attempts: Vec<TaskAttempt>,
    pub operations: Vec<OperationHistory>,
    pub recovery: Option<RecoveryJob>,
    pub compensation: Option<crate::module::workflow::saga_scheduler::Abandonment>,
}

pub(crate) async fn inspect_history(pool: &sqlx::SqlitePool, id: &str) -> Result<ExecutionHistory> {
    let attempts = sqlx::query_as(
        "SELECT sequence, status, started_at, ended_at, error FROM run_attempts WHERE run_id = ? ORDER BY sequence",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let mut operations = Vec::new();
    let rows = sqlx::query("SELECT DISTINCT o.id, o.execution_path, o.adapter, o.status,o.purpose,o.dispatched_at,o.confirmed_no_effect FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id = o.id WHERE a.run_id = ? ORDER BY o.created_at, o.id")
        .bind(id).fetch_all(pool).await?;
    for row in rows {
        let operation_id: String = row.try_get("id")?;
        let attempts = sqlx::query_as("SELECT sequence, action, status, started_at, ended_at, error_summary FROM workflow_operation_attempts WHERE operation_id = ? ORDER BY sequence")
            .bind(&operation_id).fetch_all(pool).await?;
        let compensation = crate::module::workflow::saga::inspect(pool, &operation_id).await?;
        operations.push(OperationHistory {
            review: crate::module::workflow::operation_review::inspect_review(pool, &operation_id).await?,
            approval: crate::module::workflow::operation_review::inspect_approval(pool, &operation_id).await?,
            dispatched: row.try_get::<Option<String>, _>("dispatched_at")?.is_some(),
            confirmed_no_effect: row.try_get("confirmed_no_effect")?,
            id: operation_id,
            compensation,
            path: row.try_get("execution_path")?,
            adapter: row.try_get("adapter")?,
            status: row.try_get("status")?,
            purpose: row.try_get("purpose")?,
            attempts,
        });
    }
    let recovery =
        sqlx::query_as("SELECT status, attempts, next_check_at, last_error FROM run_recovery_jobs WHERE run_id = ?")
            .bind(id)
            .fetch_optional(pool)
            .await?;
    let compensation = crate::module::workflow::saga_scheduler::inspect(pool, id).await?;
    Ok(ExecutionHistory {
        compensation,
        attempts,
        operations,
        recovery,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE run_records (id TEXT PRIMARY KEY, target_type TEXT DEFAULT 'workflow', status TEXT, started_at TEXT DEFAULT '2026-10-07T00:00:00Z', created_at TEXT DEFAULT '2026-10-07T00:00:00Z', ended_at TEXT, duration_ms INTEGER, error TEXT, runtime_json TEXT DEFAULT '{}', output_view_json TEXT DEFAULT '{}', updated_at TEXT, last_sequence INTEGER DEFAULT 7); INSERT INTO run_records (id, status, error) VALUES ('task-1', 'failed', 'original failure');").execute(&pool).await.unwrap();
        sqlx::raw_sql(include_str!(
            "../../../resources/migrations/20261005100000_remote_tasks.up.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn same_task_recovery_preserves_failure_history_and_cursor() {
        let pool = pool().await;
        let recipe = json!({"threadId":"original-thread", "executionId":"business-1", "resume":true});
        let (first, second) = tokio::join!(
            enqueue_recovery_in_pool(&pool, "task-1", recipe.clone()),
            enqueue_recovery_in_pool(&pool, "task-1", recipe)
        );
        assert_ne!(first.is_ok(), second.is_ok());
        assert_eq!(
            super::super::queue::claim_next_queued_run_from_pool(&pool, false)
                .await
                .unwrap()
                .as_deref(),
            Some("task-1")
        );
        sqlx::query(
            "UPDATE run_records SET status = 'completed', output_view_json = '{\"result\":42}' WHERE id = 'task-1'",
        )
        .execute(&pool)
        .await
        .unwrap();
        complete_attempt(&pool, "task-1").await.unwrap();
        let history = inspect_history(&pool, "task-1").await.unwrap();
        assert_eq!(history.attempts.len(), 2);
        assert_eq!(history.attempts[0].error.as_deref(), Some("original failure"));
        assert_eq!(history.attempts[1].status, "completed");
        let (count, cursor): (i64, i64) = sqlx::query_as("SELECT COUNT(*), MAX(last_sequence) FROM run_records")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!((count, cursor), (1, 7));
    }

    #[tokio::test]
    async fn crash_during_recovered_execution_reopens_its_persisted_job() {
        let pool = pool().await;
        schedule(&pool, "task-1", None).await.unwrap();
        sqlx::raw_sql("UPDATE run_records SET status = 'interrupted' WHERE id = 'task-1'; UPDATE run_recovery_jobs SET status = 'done', attempts = 1; INSERT INTO workflow_operations (id, execution_id, execution_path, adapter, input_digest, snapshot_digest, status, created_at, updated_at) VALUES ('op-1','task-1','root/remote/0','remote_agent','input','snapshot','unknown','now','now'); INSERT INTO workflow_operation_attempts (id,operation_id,run_id,sequence,action,status,started_at) VALUES ('op-attempt-1','op-1','task-1',1,'submit','unknown','now');")
            .execute(&pool).await.unwrap();
        recover_startup(&pool).await.unwrap();
        let history = inspect_history(&pool, "task-1").await.unwrap();
        assert_eq!(history.recovery.unwrap().status, "pending");
        assert_eq!(claim_recovery(&pool).await.unwrap().as_deref(), Some("task-1"));
    }

    #[tokio::test]
    async fn worker_claims_once_and_survives_restart_with_bounded_backoff() {
        let pool = pool().await;
        schedule(&pool, "task-1", Some("query timeout")).await.unwrap();
        assert!(claim_recovery(&pool).await.unwrap().is_none());
        for index in 0..5 {
            sqlx::query("UPDATE run_recovery_jobs SET next_check_at = '2000-01-01T00:00:00Z'")
                .execute(&pool)
                .await
                .unwrap();
            let (a, b) = tokio::join!(claim_recovery(&pool), claim_recovery(&pool));
            assert_eq!(usize::from(a.unwrap().is_some()) + usize::from(b.unwrap().is_some()), 1);
            recover_startup(&pool).await.unwrap();
            let status: String = sqlx::query_scalar("SELECT status FROM run_recovery_jobs")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(status, if index == 4 { "blocked" } else { "pending" });
            schedule(&pool, "task-1", Some("query timeout")).await.unwrap();
        }
        let history = inspect_history(&pool, "task-1").await.unwrap();
        let job = history.recovery.unwrap();
        assert_eq!(job.status, "blocked");
        assert_eq!(job.attempts, 5);
        assert!(claim_recovery(&pool).await.unwrap().is_none());
    }
}
