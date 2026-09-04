use crate::{
    cmd::{CmdResult, StringifyErr},
    module::run_history::{
        AppendRunEvents, CreateRunRecord, FinalizeRunRecord, RunHistoryPage, RunHistoryQuery, RunHistoryStore,
        RunRecord,
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
pub async fn run_history_list(query: RunHistoryQuery) -> CmdResult<RunHistoryPage> {
    RunHistoryStore::list(query).await.stringify_err()
}

#[tauri::command]
pub async fn run_history_inspect(id: String) -> CmdResult<RunRecord> {
    RunHistoryStore::inspect(&id).await.stringify_err()
}
