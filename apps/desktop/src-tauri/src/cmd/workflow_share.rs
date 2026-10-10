use crate::{
    cmd::{CmdResult, StringifyErr},
    feat,
};
use std::{collections::BTreeMap, path::PathBuf};
use tauri::AppHandle;

#[tauri::command]
pub async fn workflow_share_mcp_tools() -> CmdResult<Vec<crate::module::tool_registry::ToolDefinition>> {
    feat::workflow_share_mcp_tools().await.stringify_err()
}

#[tauri::command]
pub async fn workflow_share_export_preview(app: AppHandle, id: String) -> CmdResult<feat::WorkflowSharePreview> {
    feat::workflow_share_export_preview(id, app.package_info().version.to_string())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_share_export(
    app: AppHandle,
    id: String,
    destination: PathBuf,
    format: feat::AppShareFormat,
    fingerprint: String,
) -> CmdResult<()> {
    feat::workflow_share_export(
        id,
        destination,
        format,
        fingerprint,
        app.package_info().version.to_string(),
    )
    .await
    .stringify_err()
}

#[tauri::command]
pub async fn workflow_share_import_preview(path: PathBuf) -> CmdResult<feat::WorkflowSharePreview> {
    feat::workflow_share_import_preview(path).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_share_import(
    path: PathBuf,
    fingerprint: String,
    name: String,
    bindings: BTreeMap<String, String>,
) -> CmdResult<feat::WorkflowShareImportResult> {
    feat::workflow_share_import(path, fingerprint, name, bindings)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_share_configuration_preview(app: AppHandle, id: String) -> CmdResult<feat::WorkflowSharePreview> {
    feat::workflow_share_configuration_preview(id, app.package_info().version.to_string())
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_share_configure(
    app: AppHandle,
    id: String,
    fingerprint: String,
    bindings: BTreeMap<String, String>,
) -> CmdResult<crate::config::IWorkflow> {
    feat::workflow_share_configure(id, fingerprint, bindings, app.package_info().version.to_string())
        .await
        .stringify_err()
}
