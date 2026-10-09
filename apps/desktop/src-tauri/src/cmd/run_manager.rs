use crate::{
    cmd::{CmdResult, StringifyErr},
    module::{
        run_history::{RunHistoryStore, RunRecordSummary},
        run_manager::{self, ResolveWorkflowAction, ResumeWorkflowRun, StartAppRun, StartWorkflowRun},
    },
};
#[tauri::command]
pub async fn workflow_run_start(request: StartWorkflowRun) -> CmdResult {
    run_manager::start_workflow(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_resume(request: ResumeWorkflowRun) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&request.run_id)
        .await
        .stringify_err()?;
    run_manager::resume_workflow(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_recover_interrupted(source_run_id: String) -> Result<RunRecordSummary, String> {
    RunHistoryStore::ensure_active_workspace(&source_run_id)
        .await
        .stringify_err()?;
    run_manager::recover_interrupted_workflow(&source_run_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_run_resolve_action(request: ResolveWorkflowAction) -> CmdResult {
    run_manager::resolve_workflow_action(request).await.stringify_err()
}

#[tauri::command]
pub async fn workflow_run_cancel(run_id: String) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&run_id)
        .await
        .stringify_err()?;
    run_manager::cancel_waiting_workflow(&run_id).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_run_start(request: StartAppRun) -> CmdResult {
    run_manager::start_app(request).await.stringify_err()
}

#[tauri::command]
pub async fn process_node_run_cancel(run_id: String) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&run_id)
        .await
        .stringify_err()?;
    run_manager::cancel_running_app(&run_id).await.stringify_err()
}

#[tauri::command]
pub async fn run_replay(source_run_id: String) -> Result<RunRecordSummary, String> {
    RunHistoryStore::ensure_active_workspace(&source_run_id)
        .await
        .stringify_err()?;
    run_manager::replay_run(&source_run_id).await.stringify_err()
}

#[tauri::command]
pub async fn run_replay_missing_dependencies(
    source_run_id: String,
) -> Result<Vec<run_manager::MissingReplayDependency>, String> {
    RunHistoryStore::ensure_active_workspace(&source_run_id)
        .await
        .stringify_err()?;
    run_manager::replay_missing_dependencies(&source_run_id)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_operation_review(request: crate::module::workflow::operation_review::ReviewRequest) -> CmdResult {
    RunHistoryStore::ensure_active_workspace(&request.run_id)
        .await
        .stringify_err()?;
    run_manager::review_operation(request).await.stringify_err()
}
