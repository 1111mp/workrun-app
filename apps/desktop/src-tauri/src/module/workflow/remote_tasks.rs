//! Durable remote task identities, separate from graph State and checkpoints.
use super::remote_auth::RemoteAuthentication;
use crate::config::{decrypt_data_with_key, encrypt_data_with_key};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};
use tauri::Emitter;

pub(super) fn notify_changed() {
    if let Some(app_handle) = crate::APP_HANDLE.get() {
        let _ = app_handle.emit("remote-tasks-changed", ());
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteTaskRecord {
    pub id: String,
    pub run_id: String,
    pub node_id: String,
    pub message_id: String,
    pub service_origin: String,
    pub task_id: Option<String>,
    pub status: String,
    pub last_known_state: Option<String>,
    pub result: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
    pub last_checked_at: Option<String>,
}

// Store exact IDs/endpoints privately: an agent can echo a credential in its ID.
// Authentication stores a reference only; current encrypted credentials are resolved
// again for every manual operation, including after an application restart.
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RemoteConnection {
    pub service_url: String,
    pub endpoint: String,
    pub tenant: Option<String>,
    pub authentication: Option<RemoteAuthentication>,
    pub task_id: Option<String>,
}

pub(super) struct RemoteTaskTracker {
    pub id: String,
    pub pool: SqlitePool,
    key: Vec<u8>,
    mark_unknown_on_drop: bool,
    pub connection: RemoteConnection,
}

pub(super) fn task_state(state: &str) -> Result<&'static str> {
    Ok(match state {
        "TASK_STATE_SUBMITTED" => "submitted",
        "TASK_STATE_WORKING" => "working",
        "TASK_STATE_COMPLETED" => "completed",
        "TASK_STATE_FAILED" => "failed",
        "TASK_STATE_CANCELED" => "canceled",
        "TASK_STATE_REJECTED" => "rejected",
        "TASK_STATE_INPUT_REQUIRED" => "input_required",
        "TASK_STATE_AUTH_REQUIRED" => "auth_required",
        _ => bail!("Unsupported A2A task state"),
    })
}

impl RemoteTaskTracker {
    pub async fn begin(
        pool: SqlitePool,
        key: Vec<u8>,
        run_id: &str,
        node_id: &str,
        message_id: &str,
        connection: RemoteConnection,
    ) -> Result<Self> {
        let tracker = Self {
            id: uuid::Uuid::new_v4().to_string(),
            pool,
            key,
            connection,
            mark_unknown_on_drop: true,
        };
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO remote_tasks (id, run_id, node_id, message_id, service_origin, connection_ciphertext, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(&tracker.id).bind(run_id).bind(node_id).bind(message_id)
            .bind(tauri_plugin_http::reqwest::Url::parse(&tracker.connection.service_url)?.origin().ascii_serialization())
            .bind(tracker.encrypt()?).bind(&now).bind(&now).execute(&tracker.pool).await?;
        notify_changed();
        Ok(tracker)
    }

    pub async fn attach_operation(&self, operation_id: &str) -> Result<()> {
        sqlx::query("UPDATE workflow_operations SET adapter_record_id = ? WHERE id = ? AND adapter_record_id IS NULL")
            .bind(&self.id)
            .bind(operation_id)
            .execute(&self.pool)
            .await?;
        notify_changed();
        Ok(())
    }

    fn encrypt(&self) -> Result<String> {
        encrypt_data_with_key(&serde_json::to_string(&self.connection)?, &self.key)
            .map_err(|_| anyhow::anyhow!("Cannot encrypt remote task connection"))
    }

    pub async fn load(pool: SqlitePool, key: Vec<u8>, id: &str) -> Result<Self> {
        let encrypted: String = sqlx::query_scalar("SELECT connection_ciphertext FROM remote_tasks WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await?
            .context("Remote task record not found")?;
        let decrypted = decrypt_data_with_key(&encrypted, &key)
            .map_err(|_| anyhow::anyhow!("Cannot decrypt remote task connection"))?;
        Ok(Self {
            id: id.to_string(),
            pool,
            key,
            connection: serde_json::from_str(&decrypted)?,
            mark_unknown_on_drop: false,
        })
    }

    pub async fn observe(
        &mut self,
        task_id: Option<&str>,
        state: Option<&str>,
        display_id: Option<String>,
    ) -> Result<()> {
        if let Some(id) = task_id {
            if self.connection.task_id.as_deref().is_some_and(|old| old != id) {
                bail!("A2A response changed task ID");
            }
            self.connection.task_id = Some(id.to_string());
        }
        let status = state.map(task_state).transpose()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE remote_tasks SET connection_ciphertext = ?, task_id = COALESCE(?, task_id), status = COALESCE(?, status), last_known_state = COALESCE(?, last_known_state), updated_at = ?, last_checked_at = ? WHERE id = ?")
            .bind(self.encrypt()?).bind(display_id).bind(status).bind(state).bind(&now).bind(&now).bind(&self.id).execute(&self.pool).await?;
        notify_changed();
        Ok(())
    }

    pub async fn save_result(&self, result: &Value) -> Result<()> {
        sqlx::query("UPDATE remote_tasks SET result_json = ?, status = 'completed', updated_at = ? WHERE id = ?")
            .bind(result.to_string())
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&self.id)
            .execute(&self.pool)
            .await?;
        notify_changed();
        Ok(())
    }
}

/// Adapter facts and the common reusable output commit before graph State.
pub(super) async fn complete_operation(
    pool: &SqlitePool,
    operation: &mut super::operations::Operation,
    result: &Value,
) -> Result<()> {
    let mut tx = pool.begin().await?;
    operation.persist_outcome(&mut tx, Some(result), "succeeded").await?;
    sqlx::query("UPDATE remote_tasks SET status = 'completed', result_json = ?, updated_at = ? WHERE id = (SELECT adapter_record_id FROM workflow_operations WHERE id = ?)")
        .bind(serde_json::json!({"response":result["response"], "artifacts":result["artifacts"]}).to_string())
        .bind(chrono::Utc::now().to_rfc3339()).bind(&operation.id).execute(&mut *tx).await?;
    tx.commit().await?;
    operation.committed();
    notify_changed();
    Ok(())
}

impl Drop for RemoteTaskTracker {
    fn drop(&mut self) {
        // A lost local future says nothing about remote execution. Never send
        // CancelTask here: the run termination handler requests cancellation.
        if !self.mark_unknown_on_drop {
            return;
        }
        let pool = self.pool.clone();
        let id = self.id.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = sqlx::query("UPDATE remote_tasks SET status = 'unknown', updated_at = ? WHERE id = ? AND status IN ('unknown', 'submitted', 'working')")
                    .bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await;
                notify_changed();
            });
        }
    }
}

pub(crate) async fn list_remote_tasks(pool: &SqlitePool, run_id: &str) -> Result<Vec<RemoteTaskRecord>> {
    let rows = sqlx::query("SELECT * FROM remote_tasks WHERE run_id = ? OR id IN (SELECT o.adapter_record_id FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id = o.id WHERE a.run_id = ?) ORDER BY created_at, id")
        .bind(run_id)
        .bind(run_id)
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(record_from_row).collect()
}

fn record_from_row(row: sqlx::sqlite::SqliteRow) -> Result<RemoteTaskRecord> {
    Ok(RemoteTaskRecord {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        node_id: row.try_get("node_id")?,
        message_id: row.try_get("message_id")?,
        service_origin: row.try_get("service_origin")?,
        task_id: row.try_get("task_id")?,
        status: row.try_get("status")?,
        last_known_state: row.try_get("last_known_state")?,
        result: row
            .try_get::<Option<String>, _>("result_json")?
            .map(|text| serde_json::from_str(&text))
            .transpose()?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
        last_checked_at: row.try_get("last_checked_at")?,
    })
}

pub(crate) async fn remote_task_warnings(pool: &SqlitePool, workflow_id: &str) -> Result<Vec<RemoteTaskRecord>> {
    let rows = sqlx::query("SELECT t.id, t.run_id, t.node_id, t.message_id, t.service_origin, t.task_id, t.status, t.last_known_state, NULL AS result_json, t.created_at, t.updated_at, t.last_checked_at FROM remote_tasks t JOIN run_records r ON r.id = t.run_id WHERE r.target_type = 'workflow' AND r.target_id = ? AND r.status IN ('failed', 'cancelled', 'interrupted') AND (t.status IN ('unknown', 'submitted', 'working', 'input_required', 'auth_required') OR t.status = 'completed') ORDER BY t.created_at DESC, t.id DESC")
        .bind(workflow_id).fetch_all(pool).await?;
    rows.into_iter().map(record_from_row).collect()
}

pub(crate) async fn mark_remote_tasks_interrupted(pool: &SqlitePool) -> Result<()> {
    sqlx::query("UPDATE remote_tasks SET status = 'unknown', updated_at = ? WHERE status IN ('submitted', 'working')")
        .bind(chrono::Utc::now().to_rfc3339())
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
pub(super) async fn test_pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, target_type TEXT NOT NULL DEFAULT 'workflow', target_id TEXT NOT NULL DEFAULT 'workflow-1', started_at TEXT NOT NULL DEFAULT '2026-10-07T00:00:00Z', ended_at TEXT, error TEXT, output_view_json TEXT DEFAULT '{}', runtime_json TEXT DEFAULT '{}', updated_at TEXT, created_at TEXT DEFAULT '2026-10-07T00:00:00Z', duration_ms INTEGER, last_sequence INTEGER DEFAULT 0)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-1', 'running')")
        .execute(&pool)
        .await
        .unwrap();
    // The adapter migration also adds workspace ownership to conversations.
    sqlx::query("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, workflow_id TEXT, updated_at TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261005100000_remote_tasks.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn persists_private_identity_and_unknown_outcome_across_reload() {
        let pool = test_pool().await;
        let connection = RemoteConnection {
            service_url: "https://agent.example".into(),
            endpoint: "https://agent.example/rpc".into(),
            tenant: Some("team".into()),
            authentication: Some(RemoteAuthentication::Bearer {
                credential_id: "credential".into(),
            }),
            task_id: None,
        };
        let mut tracker =
            RemoteTaskTracker::begin(pool.clone(), vec![42; 32], "run-1", "remote", "message", connection)
                .await
                .unwrap();
        let id = tracker.id.clone();
        tracker
            .observe(
                Some("private-task-id"),
                Some("TASK_STATE_WORKING"),
                Some("[REDACTED]".into()),
            )
            .await
            .unwrap();
        drop(tracker);
        for _ in 0..20 {
            if list_remote_tasks(&pool, "run-1").await.unwrap()[0].status == "unknown" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        let record = list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        assert_eq!(record.status, "unknown");
        assert_eq!(record.last_known_state.as_deref(), Some("TASK_STATE_WORKING"));
        assert!(!serde_json::to_string(&record).unwrap().contains("private-task-id"));
        let encrypted: String = sqlx::query_scalar("SELECT connection_ciphertext FROM remote_tasks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!encrypted.contains("private-task-id"));
        let mut reloaded = RemoteTaskTracker::load(pool.clone(), vec![42; 32], &id).await.unwrap();
        assert_eq!(reloaded.connection.task_id.as_deref(), Some("private-task-id"));
        assert!(RemoteTaskTracker::load(pool.clone(), vec![7; 32], &id).await.is_err());
        assert!(
            reloaded
                .observe(Some("different-task"), Some("TASK_STATE_COMPLETED"), None)
                .await
                .is_err()
        );
        reloaded
            .observe(
                Some("private-task-id"),
                Some("TASK_STATE_COMPLETED"),
                Some("[REDACTED]".into()),
            )
            .await
            .unwrap();
        reloaded
            .save_result(&json!({"response":"done","artifacts":[]}))
            .await
            .unwrap();
        drop(reloaded);
        let record = list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        assert_eq!(record.status, "completed");
        assert_eq!(record.result.unwrap()["response"], "done");
        let run_status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(run_status, "running");
    }

    #[tokio::test]
    async fn records_submission_before_a_task_id_exists_and_keeps_terminal_failures() {
        let pool = test_pool().await;
        let tracker = RemoteTaskTracker::begin(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "remote",
            "message",
            RemoteConnection {
                service_url: "https://agent.example".into(),
                endpoint: "https://agent.example/rpc".into(),
                tenant: None,
                authentication: None,
                task_id: None,
            },
        )
        .await
        .unwrap();
        let id = tracker.id.clone();
        drop(tracker);
        let record = list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        assert_eq!(record.message_id, "message");
        assert!(record.task_id.is_none());
        assert_eq!(record.status, "unknown");
        let mut tracker = RemoteTaskTracker::load(pool.clone(), vec![42; 32], &id).await.unwrap();
        tracker
            .observe(Some("task"), Some("TASK_STATE_FAILED"), Some("task".into()))
            .await
            .unwrap();
        drop(tracker);
        assert_eq!(list_remote_tasks(&pool, "run-1").await.unwrap()[0].status, "failed");
    }
    #[tokio::test]
    async fn restart_preserves_last_state_and_warnings_stay_with_their_workflow() {
        let pool = test_pool().await;
        let mut tracker = RemoteTaskTracker::begin(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "remote",
            "message",
            RemoteConnection {
                service_url: "https://agent.example".into(),
                endpoint: "https://agent.example/rpc".into(),
                tenant: None,
                authentication: None,
                task_id: None,
            },
        )
        .await
        .unwrap();
        tracker
            .observe(Some("task"), Some("TASK_STATE_WORKING"), Some("task".into()))
            .await
            .unwrap();
        mark_remote_tasks_interrupted(&pool).await.unwrap();
        let record = list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        assert_eq!(record.status, "unknown");
        assert_eq!(record.last_known_state.as_deref(), Some("TASK_STATE_WORKING"));
        assert!(remote_task_warnings(&pool, "workflow-1").await.unwrap().is_empty());
        sqlx::query("UPDATE run_records SET status = 'interrupted'")
            .execute(&pool)
            .await
            .unwrap();
        assert_eq!(remote_task_warnings(&pool, "workflow-1").await.unwrap().len(), 1);
        assert!(remote_task_warnings(&pool, "workflow-2").await.unwrap().is_empty());
        tracker
            .observe(Some("task"), Some("TASK_STATE_COMPLETED"), Some("task".into()))
            .await
            .unwrap();
        tracker
            .save_result(&json!({"response":"done", "artifacts":[]}))
            .await
            .unwrap();
        // A failed local run can repeat even completed remote work with a collected result.
        assert_eq!(remote_task_warnings(&pool, "workflow-1").await.unwrap().len(), 1);
        tracker
            .observe(Some("task"), Some("TASK_STATE_CANCELED"), Some("task".into()))
            .await
            .unwrap();
        assert!(remote_task_warnings(&pool, "workflow-1").await.unwrap().is_empty());
    }
}
