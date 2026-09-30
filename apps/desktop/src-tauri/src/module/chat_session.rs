use crate::core::db::DBManager;
use crate::module::run_history::RunStatus;
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use sqlx::{Row, Sqlite, Transaction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub workflow_id: String,
    pub status: String,
    pub active_run_id: Option<String>,
    pub state: Value,
    pub summary: String,
    pub created_at: String,
    pub updated_at: String,
    pub latest_turn_status: Option<String>,
    pub latest_turn_message: Option<String>,
    pub latest_turn_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_snapshot: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub id: String,
    pub run_id: String,
    pub sequence: i64,
    pub user_message: String,
    pub status: String,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// Durable chat metadata deliberately lives outside graph checkpoints: a graph
/// checkpoint represents one execution, while a session spans many executions.
pub struct ChatSessionStore;

fn is_active_turn_status(status: Option<&str>) -> bool {
    matches!(status, Some("queued" | "running" | "waiting_for_input"))
}

impl ChatSessionStore {
    pub(crate) async fn ensure_turn_available(
        transaction: &mut Transaction<'_, Sqlite>,
        session_id: &str,
    ) -> Result<()> {
        let row = sqlx::query("SELECT active_run_id FROM chat_sessions WHERE id = ? AND status = 'active'")
            .bind(session_id)
            .fetch_optional(&mut **transaction)
            .await?
            .context("chat session was not found or archived")?;
        let active_run_id: Option<String> = row.try_get("active_run_id")?;
        let Some(active_run_id) = active_run_id else {
            return Ok(());
        };
        let status: Option<String> = sqlx::query_scalar("SELECT status FROM run_records WHERE id = ?")
            .bind(&active_run_id)
            .fetch_optional(&mut **transaction)
            .await?;
        if is_active_turn_status(status.as_deref()) {
            bail!("chat session already has an active turn");
        }
        // A crash or an older finalizer can leave a terminal run attached to
        // the session. Recover that stale lock here, under the send lock, so
        // one historic failure cannot permanently block the conversation.
        sqlx::query("UPDATE chat_sessions SET active_run_id = NULL WHERE id = ? AND active_run_id = ?")
            .bind(session_id)
            .bind(active_run_id)
            .execute(&mut **transaction)
            .await?;
        Ok(())
    }

    pub async fn create(id: &str, workflow_id: &str, workflow_snapshot: Value) -> Result<ChatSession> {
        if id.trim().is_empty() || workflow_id.trim().is_empty() || !workflow_snapshot.is_object() {
            bail!("chat session id, workflow id, and workflow snapshot are required");
        }
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO chat_sessions (id, workflow_id, workflow_snapshot_json, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
            .bind(id).bind(workflow_id).bind(workflow_snapshot.to_string()).bind(&now).bind(&now)
            .execute(&pool).await?;
        Self::get(id).await
    }

    pub async fn update_workflow_snapshot(id: &str, workflow_snapshot: Value) -> Result<()> {
        if !workflow_snapshot.is_object() {
            bail!("chat session workflow snapshot must be an object");
        }
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE chat_sessions SET workflow_snapshot_json = ?, updated_at = ? WHERE id = ? AND status = 'active'",
        )
        .bind(workflow_snapshot.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("chat session was not found or archived");
        }
        Ok(())
    }

    pub async fn get(id: &str) -> Result<ChatSession> {
        let pool = DBManager::global().pool()?;
        let row = sqlx::query("SELECT id, workflow_id, status, active_run_id, state_json, summary, created_at, updated_at, workflow_snapshot_json, (SELECT status FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_status, (SELECT user_message FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_message, (SELECT COALESCE(completed_at, created_at) FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_at FROM chat_sessions WHERE id = ?")
            .bind(id).fetch_optional(&pool).await?
            .context("chat session was not found")?;
        Ok(ChatSession {
            id: row.try_get("id")?,
            workflow_id: row.try_get("workflow_id")?,
            status: row.try_get("status")?,
            active_run_id: row.try_get("active_run_id")?,
            state: serde_json::from_str(&row.try_get::<String, _>("state_json")?)?,
            summary: row.try_get("summary")?,
            created_at: row.try_get("created_at")?,
            updated_at: row.try_get("updated_at")?,
            latest_turn_status: row.try_get("latest_turn_status")?,
            latest_turn_message: row.try_get("latest_turn_message")?,
            latest_turn_at: row.try_get("latest_turn_at")?,
            workflow_snapshot: Some(serde_json::from_str(
                &row.try_get::<String, _>("workflow_snapshot_json")?,
            )?),
        })
    }

    pub async fn begin_turn(session_id: &str, turn_id: &str, run_id: &str, message: &str) -> Result<()> {
        if turn_id.trim().is_empty() || run_id.trim().is_empty() || message.trim().is_empty() {
            bail!("chat turn id, run id, and message are required");
        }
        let pool = DBManager::global().pool()?;
        // A renderer-side disabled button is insufficient: this transaction
        // serializes sends from multiple windows or future API clients.
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
        Self::ensure_turn_available(&mut transaction, session_id).await?;
        let sequence: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence), -1) + 1 FROM chat_turns WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&mut *transaction)
                .await?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO chat_turns (id, session_id, run_id, sequence, user_message, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)")
            .bind(turn_id).bind(session_id).bind(run_id).bind(sequence).bind(message).bind(&now).execute(&mut *transaction).await?;
        sqlx::query("UPDATE chat_sessions SET active_run_id = ?, updated_at = ? WHERE id = ?")
            .bind(run_id)
            .bind(&now)
            .bind(session_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn finish_turn(run_id: &str, status: RunStatus) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
        let session_id: Option<String> = sqlx::query_scalar("SELECT session_id FROM chat_turns WHERE run_id = ?")
            .bind(run_id)
            .fetch_optional(&mut *transaction)
            .await?;
        let Some(session_id) = session_id else {
            transaction.commit().await?;
            return Ok(());
        };
        sqlx::query("UPDATE chat_turns SET status = ?, completed_at = ? WHERE run_id = ?")
            .bind(status.as_str())
            .bind(&now)
            .bind(run_id)
            .execute(&mut *transaction)
            .await?;
        // The session lock belongs to a currently executable turn. A terminal
        // run must release it even when it failed, otherwise the chat deadlocks.
        sqlx::query("UPDATE chat_sessions SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?")
            .bind(&now)
            .bind(session_id)
            .bind(run_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn set_turn_status(run_id: &str, status: RunStatus) -> Result<()> {
        let pool = DBManager::global().pool()?;
        sqlx::query("UPDATE chat_turns SET status = ? WHERE run_id = ?")
            .bind(status.as_str())
            .bind(run_id)
            .execute(&pool)
            .await?;
        Ok(())
    }

    pub async fn merge_state(id: &str, updates: &serde_json::Map<String, Value>) -> Result<()> {
        if updates.is_empty() {
            return Ok(());
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
        let current: String = sqlx::query_scalar("SELECT state_json FROM chat_sessions WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?
            .context("chat session was not found")?;
        let mut state = serde_json::from_str::<Value>(&current)?
            .as_object()
            .cloned()
            .context("chat session state must be an object")?;
        state.extend(updates.clone());
        sqlx::query("UPDATE chat_sessions SET state_json = ?, updated_at = ? WHERE id = ?")
            .bind(Value::Object(state).to_string())
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_turns(session_id: &str) -> Result<Vec<ChatTurn>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, run_id, sequence, user_message, status, created_at, completed_at FROM chat_turns WHERE session_id = ? ORDER BY sequence ASC")
            .bind(session_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(ChatTurn {
                    id: row.try_get("id")?,
                    run_id: row.try_get("run_id")?,
                    sequence: row.try_get("sequence")?,
                    user_message: row.try_get("user_message")?,
                    status: row.try_get("status")?,
                    created_at: row.try_get("created_at")?,
                    completed_at: row.try_get("completed_at")?,
                })
            })
            .collect()
    }

    pub async fn list(workflow_id: &str) -> Result<Vec<ChatSession>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, workflow_id, status, active_run_id, state_json, summary, created_at, updated_at, (SELECT status FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_status, (SELECT user_message FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_message, (SELECT COALESCE(completed_at, created_at) FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_at FROM chat_sessions WHERE workflow_id = ? AND status = 'active' ORDER BY COALESCE((SELECT COALESCE(completed_at, created_at) FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1), created_at) DESC, id DESC")
            .bind(workflow_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(ChatSession {
                    id: row.try_get("id")?,
                    workflow_id: row.try_get("workflow_id")?,
                    status: row.try_get("status")?,
                    active_run_id: row.try_get("active_run_id")?,
                    state: serde_json::from_str(&row.try_get::<String, _>("state_json")?)?,
                    summary: row.try_get("summary")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    latest_turn_status: row.try_get("latest_turn_status")?,
                    latest_turn_message: row.try_get("latest_turn_message")?,
                    latest_turn_at: row.try_get("latest_turn_at")?,
                    // The picker needs only summary data. Keep the immutable
                    // execution recipe on the explicit get path.
                    workflow_snapshot: None,
                })
            })
            .collect()
    }

    /// History must include archived conversations: archiving only removes a
    /// session from the live picker, never from its durable execution record.
    pub async fn list_history(workflow_id: &str) -> Result<Vec<ChatSession>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, workflow_id, status, active_run_id, state_json, summary, created_at, updated_at, (SELECT status FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_status, (SELECT user_message FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_message, (SELECT COALESCE(completed_at, created_at) FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1) AS latest_turn_at FROM chat_sessions WHERE workflow_id = ? ORDER BY COALESCE((SELECT COALESCE(completed_at, created_at) FROM chat_turns WHERE session_id = chat_sessions.id ORDER BY sequence DESC LIMIT 1), created_at) DESC, id DESC")
            .bind(workflow_id)
            .fetch_all(&pool)
            .await?;
        rows.into_iter()
            .map(|row| {
                Ok(ChatSession {
                    id: row.try_get("id")?,
                    workflow_id: row.try_get("workflow_id")?,
                    status: row.try_get("status")?,
                    active_run_id: row.try_get("active_run_id")?,
                    state: serde_json::from_str(&row.try_get::<String, _>("state_json")?)?,
                    summary: row.try_get("summary")?,
                    created_at: row.try_get("created_at")?,
                    updated_at: row.try_get("updated_at")?,
                    latest_turn_status: row.try_get("latest_turn_status")?,
                    latest_turn_message: row.try_get("latest_turn_message")?,
                    latest_turn_at: row.try_get("latest_turn_at")?,
                    workflow_snapshot: None,
                })
            })
            .collect()
    }

    pub async fn archive(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query("UPDATE chat_sessions SET status = 'archived', updated_at = ? WHERE id = ? AND active_run_id IS NULL AND status = 'active'")
            .bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await?;
        if result.rows_affected() == 0 {
            bail!("only inactive active chat sessions can be archived");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ChatSessionStore, is_active_turn_status};
    use sqlx::{Row, sqlite::SqlitePoolOptions};

    async fn chat_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, status TEXT NOT NULL, active_run_id TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        pool
    }

    #[test]
    fn retains_locks_for_non_terminal_runs() {
        for status in ["queued", "running", "waiting_for_input"] {
            assert!(is_active_turn_status(Some(status)));
        }
    }

    #[test]
    fn releases_locks_for_terminal_or_missing_runs() {
        for status in [
            None,
            Some("completed"),
            Some("failed"),
            Some("cancelled"),
            Some("interrupted"),
        ] {
            assert!(!is_active_turn_status(status));
        }
    }

    #[tokio::test]
    async fn clears_a_terminal_lock_without_reordering_existing_turns() {
        let pool = chat_pool().await;
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('failed-run', 'failed')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chat_sessions (id, status, active_run_id) VALUES ('session-1', 'active', 'failed-run')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        ChatSessionStore::ensure_turn_available(&mut transaction, "session-1")
            .await
            .unwrap();
        transaction.commit().await.unwrap();

        let row = sqlx::query("SELECT active_run_id FROM chat_sessions WHERE id = 'session-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.try_get::<Option<String>, _>("active_run_id").unwrap(), None);
    }

    #[tokio::test]
    async fn retains_a_lock_while_a_turn_is_running() {
        let pool = chat_pool().await;
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('running-run', 'running')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO chat_sessions (id, status, active_run_id) VALUES ('session-1', 'active', 'running-run')",
        )
        .execute(&pool)
        .await
        .unwrap();

        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await.unwrap();
        let error = ChatSessionStore::ensure_turn_available(&mut transaction, "session-1")
            .await
            .unwrap_err();
        transaction.rollback().await.unwrap();

        assert!(error.to_string().contains("already has an active turn"));
    }
}
