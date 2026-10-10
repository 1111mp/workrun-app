use crate::{
    cmd::{CmdResult, StringifyErr},
    module::deeplink::{DeeplinkManager, DeeplinkUpdate, ExecutionRequest},
};

#[tauri::command]
pub async fn deeplink_snapshot() -> CmdResult<DeeplinkUpdate> {
    DeeplinkManager::global().snapshot().await.stringify_err()
}

#[tauri::command]
pub fn deeplink_dismiss(id: String) {
    DeeplinkManager::global().dismiss(&id);
}

#[tauri::command]
pub async fn deeplink_submit(id: String, execution: ExecutionRequest) -> CmdResult<String> {
    DeeplinkManager::global().submit(id, execution).await.stringify_err()
}
