use crate::{
    cmd::{CmdResult, StringifyErr},
    core::db::DBManager,
    utils::dirs::active_workspace_id,
};
use serde_json::Value;

#[tauri::command]
pub async fn model_usage_session(kind: String, id: String) -> CmdResult<Value> {
    async {
        let workspace = active_workspace_id();
        let pool = DBManager::global().pool()?;
        let exists: bool = match kind.as_str() {
            "assistant" => {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assistant_sessions WHERE workspace_id=? AND id=?)")
                    .bind(&workspace)
                    .bind(&id)
                    .fetch_one(&pool)
                    .await?
            },
            "workflow_chat" => {
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM chat_sessions WHERE workspace_id=? AND id=?)")
                    .bind(&workspace)
                    .bind(&id)
                    .fetch_one(&pool)
                    .await?
            },
            _ => anyhow::bail!("Unknown session kind"),
        };
        anyhow::ensure!(exists, "Session not found in this workspace");
        let usage = crate::module::model_usage::session_usage(&pool, &workspace, &kind, &id).await?;
        anyhow::ensure!(
            workspace == active_workspace_id(),
            "Workspace changed while reading usage"
        );
        Ok(usage)
    }
    .await
    .stringify_err()
}
