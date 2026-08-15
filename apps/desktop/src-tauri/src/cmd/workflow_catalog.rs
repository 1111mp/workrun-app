use crate::{
    cmd::{CmdResult, StringifyErr},
    module::workflow_catalog::{StoredWorkflow, WorkflowCatalogStore},
};
use serde_json::Value;

#[tauri::command]
pub async fn workflow_catalog_list() -> CmdResult<Vec<StoredWorkflow>> {
    WorkflowCatalogStore::list().await.stringify_err()
}

#[tauri::command]
pub async fn workflow_catalog_create(document: Value) -> CmdResult<StoredWorkflow> {
    WorkflowCatalogStore::create(document).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_catalog_inspect(id: String) -> CmdResult<StoredWorkflow> {
    WorkflowCatalogStore::inspect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_catalog_update(id: String, document: Value) -> CmdResult<StoredWorkflow> {
    WorkflowCatalogStore::update(&id, document).await.stringify_err()
}
