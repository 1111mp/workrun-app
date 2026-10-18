use crate::{
    cmd::{CmdResult, StringifyErr},
    module::run_history::{
        AppendRunEvents, CreatePendingAction, CreateRunRecord, FinalizeRunRecord, PendingAction, RunHistoryPage,
        RunHistoryQuery, RunHistoryStore, RunHistoryTimelinePage, RunHistoryTimelineQuery, RunObservability,
        RunObservabilityQuery, RunRecord, RunRecordSummary,
    },
};

#[tauri::command]
pub async fn run_history_create(record: CreateRunRecord) -> CmdResult {
    RunHistoryStore::create(record).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_append_events(id: String, request: AppendRunEvents) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&id).await.stringify_err()?;
    RunHistoryStore::append_events(&id, request).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_finalize(id: String, record: FinalizeRunRecord) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&id).await.stringify_err()?;
    RunHistoryStore::finalize(&id, record).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_mark_running(id: String) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&id).await.stringify_err()?;
    RunHistoryStore::mark_running(&id).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list(query: RunHistoryQuery) -> CmdResult<RunHistoryPage> {
    RunHistoryStore::list(query).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list_timeline(query: RunHistoryTimelineQuery) -> CmdResult<RunHistoryTimelinePage> {
    RunHistoryStore::list_timeline(query).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_inspect(id: String) -> CmdResult<RunRecord> {
    RunHistoryStore::ensure_active_workspace(&id).await.stringify_err()?;
    RunHistoryStore::inspect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list_active() -> CmdResult<Vec<RunRecordSummary>> {
    RunHistoryStore::list_active().await.stringify_err()
}

#[tauri::command]
pub async fn run_history_observability(query: RunObservabilityQuery) -> CmdResult<RunObservability> {
    RunHistoryStore::observability(query).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_create_pending_action(action: CreatePendingAction) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&action.run_id)
        .await
        .stringify_err()?;
    RunHistoryStore::create_pending_action(action).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list_pending_actions(run_id: Option<String>) -> CmdResult<Vec<PendingAction>> {
    RunHistoryStore::list_pending_actions(run_id.as_deref())
        .await
        .stringify_err()
}

/// Stop tracking an interrupted run without deleting its history or executing
/// cancellation/compensation against an external operation with unknown state.
#[tauri::command]
pub async fn run_history_dismiss_recovery(id: String) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&id).await.stringify_err()?;
    crate::module::run_manager::dismiss_interrupted_run(&id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn run_history_delete(id: String) -> CmdResult {
    RunHistoryStore::delete(&id).await.stringify_err()
}
