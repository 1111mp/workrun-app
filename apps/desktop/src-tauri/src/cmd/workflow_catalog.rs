use crate::{
    cmd::{CmdResult, StringifyErr},
    config::IWorkflow,
    feat,
};
use serde_json::Value;

#[tauri::command]
pub async fn get_workflows() -> CmdResult<Vec<IWorkflow>> {
    feat::get_workflows().await.stringify_err()
}

#[tauri::command]
pub async fn create_workflow(document: Value) -> CmdResult<IWorkflow> {
    feat::create_workflow(document).await.stringify_err()
}

#[tauri::command]
pub async fn get_workflow(id: String) -> CmdResult<IWorkflow> {
    feat::get_workflow(&id).await.stringify_err()
}

#[tauri::command]
pub async fn update_workflow(id: String, document: Value) -> CmdResult<IWorkflow> {
    feat::update_workflow(&id, document).await.stringify_err()
}
