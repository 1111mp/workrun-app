//! Local, append-only execution history for Workflow and App runs.

use crate::core::db::DBManager;
use anyhow::{Context, Result, bail};
use serde_json::Value;
use sqlx::{QueryBuilder, Row, Sqlite};

mod types;

pub use types::*;

pub struct RunHistoryStore;

mod pending_actions;
mod queries;
mod queue;
mod records;

#[cfg(test)]
use pending_actions::claim_next_pending_action_from_pool;
#[cfg(test)]
use queue::claim_next_queued_run_from_pool;
#[cfg(test)]
use records::finish_execution_in_pool;

#[cfg(test)]
mod tests {
    use super::{
        RunStatus, claim_next_pending_action_from_pool, claim_next_queued_run_from_pool, finish_execution_in_pool,
    };
    use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

    async fn pending_action_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            // An in-memory SQLite database belongs to one connection. Keeping
            // it single-connection still exercises the transaction boundary
            // while avoiding a second, empty in-memory database.
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT, resolved_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, status, started_at) VALUES ('run-1', 'waiting_for_input', '2026-09-05T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (id, created_at) in [
            ("action-1", "2026-09-05T00:00:01Z"),
            ("action-2", "2026-09-05T00:00:02Z"),
        ] {
            sqlx::query(
                "INSERT INTO run_pending_actions (id, run_id, kind, payload_json, status, created_at) VALUES (?, 'run-1', 'tool_approval', '{}', 'pending', ?)",
            )
            .bind(id)
            .bind(created_at)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    async fn queued_run_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, target_type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (id, target_type, created_at) in [
            ("run-1", "app", "2026-09-05T00:00:01Z"),
            ("run-2", "workflow", "2026-09-05T00:00:02Z"),
        ] {
            sqlx::query("INSERT INTO run_records (id, target_type, status, created_at) VALUES (?, ?, 'queued', ?)")
                .bind(id)
                .bind(target_type)
                .bind(created_at)
                .execute(&pool)
                .await
                .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn claims_queued_runs_in_creation_order_once() {
        let pool = queued_run_pool().await;
        assert_eq!(
            claim_next_queued_run_from_pool(&pool, true).await.unwrap().as_deref(),
            Some("run-1")
        );
        assert_eq!(
            claim_next_queued_run_from_pool(&pool, true).await.unwrap().as_deref(),
            Some("run-2")
        );
        assert!(claim_next_queued_run_from_pool(&pool, true).await.unwrap().is_none());
        let running: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_records WHERE status = 'running'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(running, 2);
    }

    #[tokio::test]
    async fn skips_apps_when_the_app_worker_limit_is_exhausted() {
        let pool = queued_run_pool().await;
        assert_eq!(
            claim_next_queued_run_from_pool(&pool, false).await.unwrap().as_deref(),
            Some("run-2")
        );
    }

    #[tokio::test]
    async fn concurrent_coordinators_claim_distinct_oldest_actions() {
        let pool = pending_action_pool().await;
        let (first, second) = tokio::join!(
            claim_next_pending_action_from_pool(&pool, "drawer-a"),
            claim_next_pending_action_from_pool(&pool, "drawer-b"),
        );
        let mut claimed = [first.unwrap().unwrap().id, second.unwrap().unwrap().id];
        claimed.sort();
        assert_eq!(claimed, ["action-1", "action-2"]);
    }

    #[tokio::test]
    async fn reclaims_the_action_already_owned_by_the_reloaded_coordinator() {
        let pool = pending_action_pool().await;
        assert_eq!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .unwrap()
                .id,
            "action-1"
        );

        assert_eq!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .unwrap()
                .id,
            "action-1"
        );
    }

    #[tokio::test]
    async fn terminal_run_actions_are_expired_and_cannot_be_claimed() {
        let pool = pending_action_pool().await;

        finish_execution_in_pool(
            &pool,
            "run-1",
            RunStatus::Failed,
            Some("event persistence failed".to_string()),
        )
        .await
        .unwrap();

        assert!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .is_none()
        );
        let expired: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_pending_actions WHERE run_id = 'run-1' AND status = 'expired'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(expired, 2);
    }

    #[tokio::test]
    async fn finishing_a_run_updates_the_requested_record() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, resolved_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, status, started_at) VALUES ('run-1', 'running', '2026-09-05T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        finish_execution_in_pool(&pool, "run-1", RunStatus::Completed, None)
            .await
            .unwrap();

        let row = sqlx::query("SELECT status, ended_at FROM run_records WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("status"), "completed");
        assert!(row.get::<Option<String>, _>("ended_at").is_some());
    }
}
