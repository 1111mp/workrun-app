use crate::{
    cmd::{CmdResult, StringifyErr},
    module::schedule::{AppScheduleRequest, ScheduleStore, ScheduleSummary},
};

#[tauri::command]
pub async fn app_schedule_list(app_id: String) -> CmdResult<Vec<ScheduleSummary>> {
    ScheduleStore::list_for_app(&app_id).await.stringify_err()
}

#[tauri::command]
pub async fn app_schedule_save(request: AppScheduleRequest) -> CmdResult<ScheduleSummary> {
    ScheduleStore::save_app(request).await.stringify_err()
}

#[tauri::command]
pub async fn schedule_set_enabled(id: String, enabled: bool) -> CmdResult {
    ScheduleStore::set_enabled(&id, enabled).await.stringify_err()
}

#[tauri::command]
pub async fn schedule_delete(id: String) -> CmdResult {
    ScheduleStore::delete(&id).await.stringify_err()
}
