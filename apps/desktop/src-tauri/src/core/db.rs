use crate::{
    logging, singleton,
    utils::{dirs, logging::Type},
};
use anyhow::{Result, anyhow};
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions};
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
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(sqlx::sqlite::SqliteSynchronous::Full)
            .create_if_missing(true);
        let db_pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(options)
            .await?;

        logging!(info, Type::Setup, "Successfully connected to the client database");

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
