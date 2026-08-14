use crate::module::{
    ipc::IpcServer,
    python_runtime::{
        DependencySyncResult, PythonExecutionResult, PythonOutputChunk, PythonRuntime, StreamingPythonExecutionResult,
    },
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::ipc::Channel;

fn default_python_version() -> String {
    "3.12".to_string()
}

/// Input for the complete project Python preparation and execution workflow.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunProjectPythonRequest {
    pub project_path: PathBuf,
    pub script_path: PathBuf,
    #[serde(default = "default_python_version")]
    pub python_version: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Result of preparing a uv project and executing one Python script in it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPythonRunResult {
    pub sync: DependencySyncResult,
    pub execution: PythonExecutionResult,
}

/// Final result of a project run whose standard streams were sent to a channel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectPythonStreamRunResult {
    pub sync: DependencySyncResult,
    pub execution: StreamingPythonExecutionResult,
}

/// Prepare a project's managed Python environment, synchronize dependencies,
/// then run the requested script from that environment.
pub async fn run_project_python(app: &AppHandle, request: RunProjectPythonRequest) -> Result<ProjectPythonRunResult> {
    let sync = PythonRuntime::sync_dependencies(app, &request.project_path, &request.python_version).await?;
    let ipc = IpcServer::global().create_session().await?;
    let execution = PythonRuntime::run_python_with_env(
        &sync.environment,
        &request.script_path,
        &request.args,
        &[
            ("WORKRUN_IPC_ENDPOINT".into(), ipc.endpoint.clone()),
            ("WORKRUN_IPC_TOKEN".into(), ipc.token.clone()),
            ("WORKRUN_RUN_ID".into(), ipc.id.clone()),
        ],
        None,
    )
    .await;
    ipc.close().await;
    let execution = execution?;

    Ok(ProjectPythonRunResult { sync, execution })
}

/// Prepare and run a project while forwarding stdout and stderr to the caller.
pub async fn run_project_python_streaming(
    app: &AppHandle,
    request: RunProjectPythonRequest,
    output: Channel<PythonOutputChunk>,
) -> Result<ProjectPythonStreamRunResult> {
    let sync = PythonRuntime::sync_dependencies(app, &request.project_path, &request.python_version).await?;
    let ipc = IpcServer::global().create_session().await?;
    let execution = PythonRuntime::run_python_streaming_with_env(
        &sync.environment,
        &request.script_path,
        &request.args,
        &[
            ("WORKRUN_IPC_ENDPOINT".into(), ipc.endpoint.clone()),
            ("WORKRUN_IPC_TOKEN".into(), ipc.token.clone()),
            ("WORKRUN_RUN_ID".into(), ipc.id.clone()),
        ],
        &output,
    )
    .await;
    ipc.close().await;
    let execution = execution?;

    Ok(ProjectPythonStreamRunResult { sync, execution })
}
