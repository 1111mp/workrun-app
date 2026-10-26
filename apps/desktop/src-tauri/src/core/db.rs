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

fn app_migrator() -> migrate::Migrator {
    let mut migrator = sqlx::migrate!("resources/migrations");
    migrator.dangerous_set_table_name("_workrun_sqlx_migrations");
    migrator
}

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

        // Compile the schema with this binary; development resource directories
        // can retain SQL files that were removed during a baseline consolidation.
        app_migrator().run(&db_pool).await?;

        // No request from a previous process can still be running after restart.
        sqlx::query("UPDATE model_calls SET status='interrupted', record_json=json_set(record_json, '$.status', 'interrupted') WHERE status='running'")
            .execute(&db_pool).await?;

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

    pub fn pool(&self) -> Result<sqlx::SqlitePool> {
        self.db_pool
            .get()
            .cloned()
            .ok_or_else(|| anyhow!("database is not initialized"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn consolidated_migrations_initialize_revert_and_reapply_without_legacy_steps() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().in_memory(true).foreign_keys(true))
            .await
            .unwrap();
        let migrator = app_migrator();
        migrator.run(&pool).await.unwrap();
        let versions: Vec<i64> = sqlx::query_scalar("SELECT version FROM _workrun_sqlx_migrations ORDER BY version")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(versions, vec![20260904083536, 20261005100000, 20261016100000]);
        assert!(
            sqlx::query("SELECT state_json,title,model_id,status,created_at FROM assistant_sessions")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
        migrator.undo(&pool, 20261005100000).await.unwrap();
        assert!(
            sqlx::query("SELECT * FROM assistant_sessions")
                .fetch_all(&pool)
                .await
                .is_err()
        );
        assert!(sqlx::query("SELECT * FROM run_records").fetch_all(&pool).await.is_ok());
        migrator.run(&pool).await.unwrap();
        assert!(
            sqlx::query("SELECT * FROM assistant_messages")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
        assert!(
            sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
