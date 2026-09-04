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
        // A run cannot survive a desktop process restart: its local runtime and
        // in-memory event stream are gone, so make the incomplete record honest.
        let recovered_at = chrono::Utc::now().to_rfc3339();
        let recovered = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status = 'running'",
        )
        .bind(&recovered_at)
        .bind("Execution ended when Workrun restarted.")
        .bind(&recovered_at)
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
