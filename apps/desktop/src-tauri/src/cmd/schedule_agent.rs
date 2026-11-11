//! Commands for the independent task center and scheduling conversations.
use super::{CmdResult, StringifyErr};
use crate::module::schedule_agent::{ScheduleAgent, ScheduleModelSelection, Turn};
use serde_json::Value;
use tauri::ipc::Channel;
#[tauri::command]
pub async fn schedule_list() -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .list_tasks()
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_detail(id: String) -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .task_detail(&id)
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_create(
    schedule_id: Option<String>,
    selection: Option<ScheduleModelSelection>,
) -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .create(schedule_id, selection)
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_get(id: String) -> CmdResult<Value> {
    ScheduleAgent::active().stringify_err()?.get(&id).await.stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_list() -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .sessions()
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_turn(request: Turn, channel: Channel<Value>) -> CmdResult<Value> {
    let owner = crate::module::team_model::owner_for(&crate::utils::dirs::active_workspace_id()).stringify_err()?;
    let agent = ScheduleAgent::active().stringify_err()?;
    crate::module::team_model::with_owner(owner, agent.turn(request, channel))
        .await
        .stringify_err()
}
#[tauri::command]
pub fn schedule_agent_stop(id: String) -> CmdResult {
    ScheduleAgent::active().map(|agent| agent.stop(&id)).stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_propose(session_id: String, args: Value, team_token: Option<String>) -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .propose(&session_id, args, team_token.as_deref())
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_decide(
    session_id: String,
    proposal_id: String,
    approve: bool,
    team_token: Option<String>,
) -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .decide(&session_id, &proposal_id, approve, team_token.as_deref())
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn schedule_agent_reply_receipt(session_id: String, channel: Channel<Value>) -> CmdResult<Value> {
    let owner = crate::module::team_model::owner_for(&crate::utils::dirs::active_workspace_id()).stringify_err()?;
    let agent = ScheduleAgent::active().stringify_err()?;
    crate::module::team_model::with_owner(owner, agent.reply_receipt(&session_id, channel))
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn schedule_agent_delete(id: String) -> CmdResult {
    ScheduleAgent::active()
        .stringify_err()?
        .delete_session(&id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn schedule_agent_set_model(session_id: String, selection: ScheduleModelSelection) -> CmdResult<Value> {
    ScheduleAgent::active()
        .stringify_err()?
        .set_model(&session_id, selection)
        .await
        .stringify_err()
}
