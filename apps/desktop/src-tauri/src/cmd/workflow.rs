use crate::{
    cmd::{CmdResult, StringifyErr},
    config::Config,
    module::workflow::{self, WorkflowDsl, WorkflowPlan, WorkflowRunResult},
};
use adk_rust::graph::State;
use serde_json::Value;
use tauri::ipc::Channel;

/// Validate and compile the exact `{ nodes, edges }` document emitted by React
/// Flow. The returned plan is useful for a pre-run graph preview.
#[tauri::command]
pub async fn workflow_compile(dsl: Value) -> CmdResult<WorkflowPlan> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, None).await.stringify_err()?;
    Ok(compiled.plan().clone())
}

/// Execute the compiled ADK graph and stream ordered node/model events to the
/// calling webview. `initial_state` feeds selector fields such as `approved`
/// and `route`; it must be a JSON object.
#[tauri::command]
pub async fn workflow_run(
    dsl: Value,
    initial_state: Value,
    thread_id: Option<String>,
    resume: Option<bool>,
    on_event: Channel<adk_rust::graph::StreamEvent>,
) -> CmdResult<WorkflowRunResult> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let state: State = serde_json::from_value(initial_state).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, Some(on_event.clone()))
        .await
        .stringify_err()?;
    compiled
        .run_stream(
            state,
            thread_id.as_deref().unwrap_or("workflow-run"),
            resume.unwrap_or(false),
            |event| {
                // The webview may go away while a workflow is still running.
                // The workflow should complete cleanly even if it has nobody
                // left to receive its progress events.
                let _ = on_event.send(event);
            },
        )
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn workflow_resolve_tool_approval(request_id: String, fingerprint: String, approved: bool) -> CmdResult<()> {
    workflow::resolve_tool_approval(&request_id, &fingerprint, approved)
        .await
        .stringify_err()
}

/// Persist one human-review decision before resuming the workflow checkpoint.
/// The requested node determines the only state key this command may write.
#[tauri::command]
pub async fn workflow_resolve_human_review(
    dsl: Value,
    thread_id: String,
    node_id: String,
    approved: bool,
) -> CmdResult<()> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let approval_key = workflow::human_review_approval_key(&dsl, &node_id).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, None).await.stringify_err()?;
    compiled
        .update_state(&thread_id, [(approval_key, Value::Bool(approved))])
        .await
        .stringify_err()
}
