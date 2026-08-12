use crate::{
    cmd::{CmdResult, StringifyErr},
    feat::ProjectPythonStreamRunResult,
    module::{
        process_node::{ProcessNode, ProcessNodeRegistry},
        python_runtime::PythonOutputChunk,
    },
};
use tauri::{AppHandle, ipc::Channel};

/// List every Process Node in the source-owned catalog and its local state.
#[tauri::command]
pub async fn process_node_list() -> CmdResult<Vec<ProcessNode>> {
    ProcessNodeRegistry::list().await.stringify_err()
}

/// Read one catalog Process Node by id and its local installation state.
#[tauri::command]
pub async fn process_node_inspect(id: String) -> CmdResult<ProcessNode> {
    ProcessNodeRegistry::inspect(&id).await.stringify_err()
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
