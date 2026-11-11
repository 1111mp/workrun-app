use crate::{
    cmd::{CmdResult, StringifyErr},
    module::schedule::{AppScheduleRequest, ScheduleStore, ScheduleSummary, WorkflowScheduleRequest},
};
use serde_json::Value;

#[tauri::command]
pub async fn schedule_update(change: Value, team_token: Option<String>) -> CmdResult<Value> {
    crate::module::schedule_agent::ScheduleTaskManager::active()
        .stringify_err()?
        .update(change, team_token.as_deref())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn schedule_set_team_session(server_url: String, token: Option<String>) -> CmdResult<()> {
    crate::module::schedule::set_team_session(server_url.clone(), token.clone());
    crate::module::team_model::set_session(server_url, token)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn app_schedule_list(app_id: String) -> CmdResult<Vec<ScheduleSummary>> {
    ScheduleStore::list_for_app(&app_id).await.stringify_err()
}

#[tauri::command]
pub async fn app_schedule_save(request: AppScheduleRequest) -> CmdResult<ScheduleSummary> {
    ScheduleStore::save_app(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_schedule_list(workflow_id: String) -> CmdResult<Vec<ScheduleSummary>> {
    ScheduleStore::list_for_workflow(&workflow_id).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_schedule_save(request: WorkflowScheduleRequest) -> CmdResult<ScheduleSummary> {
    ScheduleStore::save_workflow(request).await.stringify_err()
}

#[tauri::command]
pub async fn schedule_set_enabled(id: String, enabled: bool) -> CmdResult {
    ScheduleStore::set_enabled(&id, enabled).await.stringify_err()
}

#[tauri::command]
pub async fn schedule_delete(id: String) -> CmdResult {
    ScheduleStore::delete(&id).await.stringify_err()
}
