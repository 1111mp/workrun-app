use crate::{
    cmd::{CmdResult, StringifyErr},
    module::python_runtime,
};
use tauri::AppHandle;

/// Verify that the `uv` binary distributed with Workrun can be executed.
#[tauri::command]
pub async fn uv_version(app: AppHandle) -> CmdResult<String> {
    python_runtime::uv_version(&app).await.stringify_err()
}
