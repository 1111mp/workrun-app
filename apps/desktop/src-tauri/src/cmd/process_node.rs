use crate::{
    cmd::{CmdResult, StringifyErr},
    config::IProcessNode,
    feat::{self, ProjectPythonStreamRunResult},
    module::{process_node::ProcessNode, python_runtime::PythonOutputChunk},
};
use tauri::{AppHandle, ipc::Channel};

/// List every Process Node in the source-owned catalog and its local state.
#[tauri::command]
pub async fn get_process_nodes() -> CmdResult<Vec<ProcessNode>> {
    feat::get_process_nodes().await.stringify_err()
}

/// List Tool Apps available for attachment to an Agent node.
#[tauri::command]
pub async fn process_node_tool_list() -> CmdResult<Vec<crate::module::tool_registry::ToolDefinition>> {
    feat::process_node_tool_list().await.stringify_err()
}

/// Read one catalog Process Node by id and its local installation state.
#[tauri::command]
pub async fn get_process_node(id: String) -> CmdResult<ProcessNode> {
    feat::process_node_inspect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_open_project(id: String) -> CmdResult<()> {
    feat::process_node_open_project(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_default_root() -> CmdResult<String> {
    feat::process_node_default_root().stringify_err()
}

#[tauri::command]
pub async fn process_node_project_version(id: String) -> CmdResult<Option<String>> {
    feat::process_node_project_version(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_set_project_version(id: String, version: String) -> CmdResult<()> {
    feat::process_node_set_project_version(&id, &version)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn process_node_source_archive(id: String) -> CmdResult<feat::ProcessNodeSourceArchive> {
    feat::process_node_source_archive(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_install_archive(
    request: feat::InstallProcessNodeArchiveRequest,
    progress: Channel<feat::ProcessNodeInstallProgress>,
) -> CmdResult<ProcessNode> {
    feat::install_process_node_archive(request, progress)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn create_process_node(
    request: feat::CreateProcessNodeRequest,
    progress: Channel<feat::ProcessNodeCreateProgress>,
) -> CmdResult<ProcessNode> {
    feat::create_process_node(request, progress).await.stringify_err()
}

#[tauri::command]
pub async fn update_process_node(definition: IProcessNode) -> CmdResult<ProcessNode> {
    feat::update_process_node(definition).await.stringify_err()
}

#[tauri::command]
pub async fn delete_process_node(id: String, delete_project_files: bool) -> CmdResult {
    feat::delete_process_node(&id, delete_project_files)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn process_node_workflow_references(id: String) -> CmdResult<Vec<feat::ProcessNodeWorkflowReference>> {
    feat::process_node_workflow_references(&id).await.stringify_err()
}

/// Synchronize dependencies and run an installed Process Node's catalog entrypoint.
#[tauri::command]
pub async fn process_node_run(
    app: AppHandle,
    id: String,
    output: Channel<PythonOutputChunk>,
) -> CmdResult<ProjectPythonStreamRunResult> {
    feat::process_node_run(&app, &id, output).await.stringify_err()
}
