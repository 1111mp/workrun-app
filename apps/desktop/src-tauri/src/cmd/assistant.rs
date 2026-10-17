//! Tauri boundary for native-owned assistant sessions.
use crate::{
    cmd::{CmdResult, StringifyErr},
    core::db::DBManager,
    utils::dirs::active_workspace_id,
};
use anyhow::Result;
use serde_json::{Value, json};
use sqlx::Row;

#[tauri::command]
pub async fn assistant_turn_start(request: crate::module::assistant::session::TurnRequest) -> CmdResult<Value> {
    crate::module::assistant::session::start(request).await.stringify_err()
}

#[cfg(test)]
async fn save_session_in_pool(pool: &sqlx::SqlitePool, workspace: &str, session: &Value) -> Result<()> {
    crate::module::assistant::session::save(pool, workspace, session).await
}

#[tauri::command]
pub async fn assistant_session_save(session: Value) -> CmdResult {
    crate::module::assistant::session::renderer_save(session)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn assistant_session_list() -> CmdResult<Vec<Value>> {
    async {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, json_extract(session_json, '$.title') AS title, updated_at FROM assistant_sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 50")
            .bind(active_workspace_id()).fetch_all(&pool).await?;
        rows.into_iter().map(|row| Ok(json!({"id": row.try_get::<String, _>("id")?, "title": row.try_get::<String, _>("title")?, "updatedAt": row.try_get::<String, _>("updated_at")?}))).collect::<Result<Vec<_>>>()
    }.await.stringify_err()
}

#[tauri::command]
pub async fn assistant_session_get(id: String) -> CmdResult<Value> {
    let pool = DBManager::global().pool().stringify_err()?;
    crate::module::assistant::session::get(&pool, &active_workspace_id(), &id)
        .await
        .stringify_err()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn sessions_are_durable_and_cannot_be_overwritten_from_another_workspace() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../resources/migrations/20261016100000_assistant_sessions.up.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let session = json!({"id": id, "title": "Report", "messages": [{"role": "user", "text": "Hello"}]});
        save_session_in_pool(&pool, "personal", &session).await.unwrap();
        let saved: String =
            sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id = ? AND workspace_id = ?")
                .bind(&id)
                .bind("personal")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&saved).unwrap(), session);
        assert!(save_session_in_pool(&pool, "team:other", &session).await.is_err());
        let hidden: Option<String> =
            sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id = ? AND workspace_id = ?")
                .bind(&id)
                .bind("team:other")
                .fetch_optional(&pool)
                .await
                .unwrap();
        assert!(hidden.is_none());
    }
}
