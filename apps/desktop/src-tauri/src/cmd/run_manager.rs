use crate::{
    cmd::{CmdResult, StringifyErr},
    module::run_manager::{self, ResolveWorkflowAction, ResumeWorkflowRun, StartAppRun, StartWorkflowRun},
};
use tauri::AppHandle;

#[tauri::command]
pub async fn workflow_run_start(request: StartWorkflowRun) -> CmdResult {
    run_manager::start_workflow(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_resume(request: ResumeWorkflowRun) -> CmdResult {
    run_manager::resume_workflow(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_resolve_action(request: ResolveWorkflowAction) -> CmdResult {
    run_manager::resolve_workflow_action(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_cancel(run_id: String) -> CmdResult {
    run_manager::cancel_waiting_workflow(&run_id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_run_start(request: StartAppRun) -> CmdResult {
    run_manager::start_app(request).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_run_cancel(run_id: String) -> CmdResult {
    run_manager::cancel_running_app(&run_id).await.stringify_err()
}
