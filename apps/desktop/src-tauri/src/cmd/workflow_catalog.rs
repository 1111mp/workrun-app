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
pub async fn update_workflow(
    id: String,
    document: Value,
    expected_revision_id: Option<String>,
) -> CmdResult<IWorkflow> {
    feat::update_workflow(&id, document, expected_revision_id.as_deref())
        .await
        .stringify_err()
}
#[tauri::command]
pub async fn delete_workflow(id: String) -> CmdResult<()> {
    feat::delete_workflow(&id).await.stringify_err()
}

#[tauri::command]
pub async fn get_workflow_revision(id: String) -> CmdResult<feat::WorkflowRevision> {
    feat::get_workflow_revision(&id).await.stringify_err()
}

#[tauri::command]
pub async fn get_workflow_edit_draft(workflow_id: Option<String>) -> CmdResult<Option<feat::WorkflowEditDraft>> {
    feat::get_workflow_edit_draft(workflow_id).await.stringify_err()
}

#[tauri::command]
pub async fn save_workflow_edit_draft(
    workflow_id: Option<String>,
    document: Value,
    base_revision_id: Option<String>,
) -> CmdResult<feat::WorkflowEditDraft> {
    feat::save_workflow_edit_draft(workflow_id, document, base_revision_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn import_workflow_edit_draft(
    workflow_id: Option<String>,
    document: Value,
    base_document: Value,
    saved_at: String,
) -> CmdResult<feat::WorkflowEditDraft> {
    feat::import_workflow_edit_draft(workflow_id, document, base_document, saved_at)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn remove_workflow_edit_draft(workflow_id: Option<String>) -> CmdResult<()> {
    feat::remove_workflow_edit_draft(workflow_id).await.stringify_err()
}
