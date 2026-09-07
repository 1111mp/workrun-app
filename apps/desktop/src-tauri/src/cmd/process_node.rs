use crate::{
    cmd::{CmdResult, StringifyErr},
    feat::ProjectPythonStreamRunResult,
    module::{
        process_node::{
            CreateProcessNodeRequest, ProcessNode, ProcessNodeCreateProgress, ProcessNodeDefinition,
            ProcessNodeRegistry, ProcessNodeWorkflowReference,
        },
        python_runtime::PythonOutputChunk,
    },
};
use tauri::{AppHandle, ipc::Channel};

/// List every Process Node in the source-owned catalog and its local state.
#[tauri::command]
pub async fn process_node_list() -> CmdResult<Vec<ProcessNode>> {
    ProcessNodeRegistry::list().await.stringify_err()
}

/// List Tool Apps available for attachment to an Agent node.
#[tauri::command]
pub async fn process_node_tool_list() -> CmdResult<Vec<crate::module::tool_registry::ToolDefinition>> {
    ProcessNodeRegistry::list_tool_definitions().await.stringify_err()
}

/// Read one catalog Process Node by id and its local installation state.
#[tauri::command]
pub async fn process_node_inspect(id: String) -> CmdResult<ProcessNode> {
    ProcessNodeRegistry::inspect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_open_project(id: String) -> CmdResult<()> {
    ProcessNodeRegistry::open_project(&id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_default_root() -> CmdResult<String> {
    ProcessNodeRegistry::root_dir()
        .map(|path| path.to_string_lossy().into_owned())
        .stringify_err()
}

#[tauri::command]
pub async fn process_node_create(
    request: CreateProcessNodeRequest,
    progress: Channel<ProcessNodeCreateProgress>,
) -> CmdResult<ProcessNode> {
    ProcessNodeRegistry::create(request, progress).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_update(definition: ProcessNodeDefinition) -> CmdResult<ProcessNode> {
    ProcessNodeRegistry::update(definition).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_delete(id: String, delete_project_files: bool) -> CmdResult {
    ProcessNodeRegistry::delete(&id, delete_project_files)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn process_node_workflow_references(id: String) -> CmdResult<Vec<ProcessNodeWorkflowReference>> {
    ProcessNodeRegistry::workflow_references(&id).await.stringify_err()
}

/// Synchronize dependencies and run an installed Process Node's catalog entrypoint.
#[tauri::command]
pub async fn process_node_run(
    app: AppHandle,
    id: String,
    output: Channel<PythonOutputChunk>,
) -> CmdResult<ProjectPythonStreamRunResult> {
    ProcessNodeRegistry::run(&app, &id, output).await.stringify_err()
}
