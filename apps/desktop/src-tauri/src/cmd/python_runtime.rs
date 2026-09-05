use crate::{
    cmd::{CmdResult, StringifyErr},
    feat,
    module::python_runtime,
};
use tauri::AppHandle;

/// Verify that the `uv` binary distributed with Workrun can be executed.
#[tauri::command]
pub async fn uv_version(app: AppHandle) -> CmdResult<String> {
    python_runtime::PythonRuntime::uv_version(&app).await.stringify_err()
}

/// Install (if needed) and resolve a Workrun-managed Python interpreter.
#[tauri::command]
pub async fn ensure_python(app: AppHandle, version: String) -> CmdResult<python_runtime::ManagedPython> {
    python_runtime::PythonRuntime::ensure_python(&app, &version)
        .await
        .stringify_err()
}

/// Create or reuse a project-local `.venv` with a Workrun-managed Python.
#[tauri::command]
pub async fn ensure_venv(
    app: AppHandle,
    project_path: String,
    version: String,
) -> CmdResult<python_runtime::ManagedVenv> {
    python_runtime::PythonRuntime::ensure_venv(&app, project_path.as_ref(), &version)
        .await
        .stringify_err()
}

/// Synchronize a uv project's dependencies into its project-local `.venv`.
#[tauri::command]
pub async fn sync_dependencies(
    project_path: String,
    version: String,
) -> CmdResult<python_runtime::DependencySyncResult> {
    python_runtime::PythonRuntime::sync_dependencies(project_path.as_ref(), &version)
        .await
        .stringify_err()
}

/// Prepare a uv project and run a script with its synchronized `.venv`.
#[tauri::command]
pub async fn run_project_python(request: feat::RunProjectPythonRequest) -> CmdResult<feat::ProjectPythonRunResult> {
    feat::run_project_python(request).await.stringify_err()
}
