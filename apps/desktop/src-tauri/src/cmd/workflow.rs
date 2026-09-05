use crate::{
    cmd::{CmdResult, StringifyErr},
    config::Config,
    module::workflow::{self, ToolConfirmationDecisionRequest, WorkflowDsl, WorkflowPlan, WorkflowRunResult},
};
use adk_rust::graph::State;
use serde_json::Value;
use std::collections::HashMap;
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
    tool_confirmation: Option<ToolConfirmationDecisionRequest>,
    on_event: Channel<adk_rust::graph::StreamEvent>,
) -> CmdResult<WorkflowRunResult> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let state: State = serde_json::from_value(initial_state).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, Some(on_event.clone()))
        .await
        .stringify_err()?;
    let mut result = compiled
        .run_stream(
            state,
            thread_id.as_deref().unwrap_or("workflow-run"),
            resume.unwrap_or(false),
            tool_confirmation,
            |event| {
                // The webview may go away while a workflow is still running.
                // The workflow should complete cleanly even if it has nobody
                // left to receive its progress events.
                let _ = on_event.send(workflow::redact_event_for_transport(event));
            },
        )
        .await
        .stringify_err()?;
    result.state = workflow::redact_state_for_transport(&result.state);
    Ok(result)
}

/// Persist one human-review decision before resuming the workflow checkpoint.
/// The requested node determines the only state key this command may write.
#[tauri::command]
pub async fn workflow_resolve_human_review(
    dsl: Value,
    thread_id: String,
    node_id: String,
    approved: bool,
    edits: HashMap<String, String>,
    workflow_context: Option<workflow::SubworkflowContext>,
) -> CmdResult<()> {
    workflow::resolve_human_review_checkpoint(dsl, thread_id, node_id, approved, edits, workflow_context)
        .await
        .stringify_err()
}

/// Persist a validated option selection before resuming the workflow checkpoint.
#[tauri::command]
pub async fn workflow_resolve_ask_user_question(
    dsl: Value,
    thread_id: String,
    node_id: String,
    option_id: String,
    workflow_context: Option<workflow::SubworkflowContext>,
) -> CmdResult<()> {
    workflow::resolve_ask_user_question_checkpoint(dsl, thread_id, node_id, option_id, workflow_context)
        .await
        .stringify_err()
}
