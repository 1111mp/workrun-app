use crate::{
    logging, singleton,
    utils::{dirs, logging::Type},
};
use anyhow::{Result, anyhow};
use sqlx::{
    migrate,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions},
};
use std::{str::FromStr as _, sync::OnceLock};

pub struct DBManager {
    db_pool: OnceLock<sqlx::SqlitePool>,
}

impl Default for DBManager {
    fn default() -> Self {
        Self {
            db_pool: OnceLock::new(),
        }
    }
}

singleton!(DBManager, DBMANAGER);

impl DBManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn init(&self) -> Result<()> {
        logging!(info, Type::Setup, "starting database initialization...");

        let db_url = Self::db_url().await?;
        let options = SqliteConnectOptions::from_str(&db_url)?
            .foreign_keys(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Full)
            .create_if_missing(true);
        let db_pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        logging!(info, Type::Setup, "Successfully connected to the client database");

        // Run migrations
        let migration_dir = dirs::db_migration_dir()?;
        let mut migrator = migrate::Migrator::new(migration_dir).await?;
        migrator.dangerous_set_table_name("_workrun_sqlx_migrations");
        migrator.run(&db_pool).await?;

        // A native restart invalidates every renderer-owned claim before the
        // associated run and action are recovered below.
        sqlx::query(
            "UPDATE run_pending_actions SET claimed_by = NULL, claimed_at = NULL WHERE status = 'pending' AND claimed_by IS NOT NULL",
        )
        .execute(&db_pool)
        .await?;

        Self::mark_incomplete_runs_interrupted(&db_pool).await?;

        logging!(info, Type::Setup, "Successfully applied database migrations");

        self.db_pool
            .set(db_pool)
            .map_err(|_| anyhow!("database already initialized"))?;

        Ok(())
    }

    pub async fn db_url() -> Result<String> {
        let db_dir = dirs::app_db_dir()?;
        if !db_dir.exists() {
            tokio::fs::create_dir_all(&db_dir).await?;
        }

        let db_path = db_dir.join("sqlite.db");
        Ok(format!("sqlite://{}", db_path.display()))
    }

    async fn mark_incomplete_runs_interrupted(pool: &sqlx::SqlitePool) -> Result<()> {
        // A native restart destroys running execution sessions and their paused
        // checkpoints. Do not auto-run queued work after restart: the history
        // entry remains the user's durable recipe, but only an explicit replay
        // can create a new execution from it.
        let recovered_at = chrono::Utc::now().to_rfc3339();
        let active_runs = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status IN ('running', 'waiting_for_input')",
        )
        .bind(&recovered_at)
        .bind("Execution ended when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        let queued_runs = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status = 'queued'",
        )
        .bind(&recovered_at)
        .bind("Execution did not start before Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        // Evaluation batches cannot survive a native restart: a queued batch
        // may have crashed before it created its first workflow Run. Close by
        // batch status, not only by Run linkage, so no history entry waits
        // forever for a coordinator that no longer exists.
        sqlx::query(
            "UPDATE evaluation_case_results SET execution_status = 'failed', verdict = 'error', failure_reason = ?, updated_at = ? WHERE execution_status = 'running' AND evaluation_run_id IN (SELECT id FROM evaluation_runs WHERE status IN ('queued', 'running'))",
        )
        .bind("Evaluation execution ended when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE evaluation_case_results SET execution_status = 'cancelled', verdict = 'skipped', failure_reason = ?, updated_at = ? WHERE execution_status = 'queued' AND evaluation_run_id IN (SELECT id FROM evaluation_runs WHERE status IN ('queued', 'running'))",
        )
        .bind("Evaluation batch stopped when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE evaluation_runs SET status = 'failed', ended_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), failed_cases = (SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id AND verdict IN ('failed', 'error')), error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
        )
        .bind(&recovered_at)
        .bind(&recovered_at)
        .bind("Evaluation batch stopped when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        // A pending action only has meaning while its native session is alive.
        // Expire it with the recovered run so the global attention queue cannot
        // offer a decision that can no longer be applied.
        sqlx::query(
            "UPDATE run_pending_actions SET status = 'expired' WHERE status = 'pending' AND run_id IN (SELECT id FROM run_records WHERE status = 'interrupted' AND error = 'Execution ended when Workrun restarted.')",
        )
        .execute(pool)
        .await?;
        let interrupted = active_runs.rows_affected() + queued_runs.rows_affected();
        if interrupted > 0 {
            logging!(
                info,
                Type::Setup,
                "Marked {} incomplete run(s) as interrupted",
                interrupted
            );
        }
        Ok(())
    }

    pub fn pool(&self) -> Result<sqlx::SqlitePool> {
        self.db_pool
            .get()
            .cloned()
            .ok_or_else(|| anyhow!("database is not initialized"))
    }
}


#[cfg(test)]
mod tests {
    use super::DBManager;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn restart_interrupts_active_and_queued_runs() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, ended_at TEXT, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE evaluation_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, failed_cases INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE evaluation_case_results (id TEXT PRIMARY KEY, evaluation_run_id TEXT NOT NULL, workflow_run_id TEXT, execution_status TEXT NOT NULL, verdict TEXT NOT NULL, failure_reason TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-1', 'waiting_for_input')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-2', 'queued')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, status, started_at) VALUES ('evaluation-1', 'running', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, status, started_at) VALUES ('evaluation-2', 'queued', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, workflow_run_id, execution_status, verdict) VALUES ('case-1', 'evaluation-1', 'run-1', 'running', 'pending'), ('case-2', 'evaluation-1', NULL, 'queued', 'pending')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, workflow_run_id, execution_status, verdict) VALUES ('case-3', 'evaluation-2', NULL, 'queued', 'pending')")
            .execute(&pool)
            .await
            .unwrap();
        for (id, kind) in [
            ("question", "ask_user_question"),
            ("review", "human_review"),
            ("approval", "tool_approval"),
        ] {
            sqlx::query("INSERT INTO run_pending_actions (id, run_id, kind, status) VALUES (?, 'run-1', ?, 'pending')")
                .bind(id)
                .bind(kind)
                .execute(&pool)
                .await
                .unwrap();
        }

        DBManager::mark_incomplete_runs_interrupted(&pool).await.unwrap();

        let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let expired: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_pending_actions WHERE run_id = 'run-1' AND status = 'expired'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "interrupted");
        assert_eq!(expired, 3);
        let queued_status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(queued_status, "interrupted");
        let queued_error: String = sqlx::query_scalar("SELECT error FROM run_records WHERE id = 'run-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(queued_error, "Execution did not start before Workrun restarted.");
        let evaluation_status: String = sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = 'evaluation-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let failed_cases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = 'evaluation-1' AND verdict IN ('error', 'skipped')")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(evaluation_status, "failed");
        assert_eq!(failed_cases, 2);
        let queued_evaluation_status: String = sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = 'evaluation-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let queued_case: (String, String) = sqlx::query_as("SELECT execution_status, verdict FROM evaluation_case_results WHERE id = 'case-3'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(queued_evaluation_status, "failed");
        assert_eq!(queued_case, ("cancelled".to_string(), "skipped".to_string()));
    }
}
