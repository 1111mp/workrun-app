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
        // A native restart destroys the execution session behind every pause.
        // A persisted checkpoint cannot safely recreate its in-memory channels,
        // so never offer a pre-restart question or approval for continuation.
        let recovered_at = chrono::Utc::now().to_rfc3339();
        let recovered = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status IN ('queued', 'running', 'waiting_for_input')",
        )
        .bind(&recovered_at)
        .bind("Execution ended when Workrun restarted.")
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
        if recovered.rows_affected() > 0 {
            logging!(
                info,
                Type::Setup,
                "Marked {} incomplete run(s) as interrupted",
                recovered.rows_affected()
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
    async fn restart_interrupts_waiting_run_and_expires_every_pending_action() {
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
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-1', 'waiting_for_input')")
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
    }
}
