use crate::{
    cmd::{CmdResult, StringifyErr},
    module::run_history::{
        AppendRunEvents, CreatePendingAction, CreateRunRecord, FinalizeRunRecord, PendingAction, RunHistoryPage,
        RunHistoryQuery, RunHistoryStore, RunRecord, RunRecordSummary,
    },
};

#[tauri::command]
pub async fn run_history_create(record: CreateRunRecord) -> CmdResult {
    RunHistoryStore::create(record).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_append_events(id: String, request: AppendRunEvents) -> CmdResult {
    RunHistoryStore::append_events(&id, request).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_finalize(id: String, record: FinalizeRunRecord) -> CmdResult {
    RunHistoryStore::finalize(&id, record).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_mark_running(id: String) -> CmdResult {
    RunHistoryStore::mark_running(&id).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list(query: RunHistoryQuery) -> CmdResult<RunHistoryPage> {
    RunHistoryStore::list(query).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_inspect(id: String) -> CmdResult<RunRecord> {
    RunHistoryStore::inspect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list_active() -> CmdResult<Vec<RunRecordSummary>> {
    RunHistoryStore::list_active().await.stringify_err()
}

#[tauri::command]
pub async fn run_history_create_pending_action(action: CreatePendingAction) -> CmdResult {
    RunHistoryStore::create_pending_action(action).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_list_pending_actions() -> CmdResult<Vec<PendingAction>> {
    RunHistoryStore::list_pending_actions().await.stringify_err()
}

#[tauri::command]
pub async fn run_history_claim_next_pending_action(claimant_id: String) -> CmdResult<Option<PendingAction>> {
    RunHistoryStore::claim_next_pending_action(&claimant_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn run_history_release_pending_action(id: String, claimant_id: String) -> CmdResult {
    RunHistoryStore::release_pending_action(&id, &claimant_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn run_history_resolve_pending_action(
    id: String,
    claimant_id: Option<String>,
    resolution: serde_json::Value,
) -> CmdResult<PendingAction> {
    RunHistoryStore::resolve_pending_action(&id, claimant_id.as_deref(), resolution)
        .await
        .stringify_err()
}
