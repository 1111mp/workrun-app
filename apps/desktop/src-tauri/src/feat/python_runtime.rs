use crate::module::python_runtime::{DependencySyncResult, PythonExecutionResult, PythonRuntime};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

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

/// Prepare a project's managed Python environment, synchronize dependencies,
/// then run the requested script from that environment.
pub async fn run_project_python(app: &AppHandle, request: RunProjectPythonRequest) -> Result<ProjectPythonRunResult> {
    let sync = PythonRuntime::sync_dependencies(app, &request.project_path, &request.python_version).await?;
    let execution = PythonRuntime::run_python(&sync.environment, &request.script_path, &request.args).await?;

    Ok(ProjectPythonRunResult { sync, execution })
}
