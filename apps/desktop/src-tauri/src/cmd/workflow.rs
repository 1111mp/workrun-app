use crate::{
    cmd::{CmdResult, StringifyErr},
    config::Config,
    module::workflow::{self, ToolConfirmationDecisionRequest, WorkflowDsl, WorkflowPlan, WorkflowRunResult},
};
use adk_rust::graph::State;
use serde_json::Value;
use std::collections::HashMap;
use tauri::ipc::Channel;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubworkflowContext {
    workflow_id: String,
    thread_id: String,
    path: Vec<String>,
}

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
    workflow_context: Option<SubworkflowContext>,
) -> CmdResult<()> {
    let (dsl, thread_id) = match workflow_context {
        Some(context) => {
            let parent_node_id = context
                .path
                .first()
                .ok_or("subworkflow context is missing its parent node")?;
            let mut dsl = workflow::subworkflow_dsl(&context.workflow_id).await.stringify_err()?;
            workflow::inject_subworkflow_context(&mut dsl, &context.thread_id, parent_node_id);
            (dsl, context.thread_id)
        },
        None => (serde_json::from_value(dsl).stringify_err()?, thread_id),
    };
    let approval_key = workflow::human_review_approval_key(&dsl, &node_id).stringify_err()?;
    let editable_key = workflow::human_review_editable_key(&dsl, &node_id).stringify_err()?;
    if edits.len() > usize::from(editable_key.is_some()) || edits.keys().any(|key| Some(key) != editable_key.as_ref()) {
        return Err("review edits do not match the configured editable key".into());
    }
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, None).await.stringify_err()?;
    let mut updates = vec![(approval_key, Value::Bool(approved))];
    if let Some(editable_key) = editable_key
        && let Some(value) = edits.get(&editable_key)
    {
        updates.push((editable_key, Value::String(value.clone())));
    }
    compiled.update_state(&thread_id, updates).await.stringify_err()
}

/// Persist a validated option selection before resuming the workflow checkpoint.
#[tauri::command]
pub async fn workflow_resolve_ask_user_question(
    dsl: Value,
    thread_id: String,
    node_id: String,
    option_id: String,
    workflow_context: Option<SubworkflowContext>,
) -> CmdResult<()> {
    let (dsl, thread_id) = match workflow_context {
        Some(context) => {
            let parent_node_id = context
                .path
                .first()
                .ok_or("subworkflow context is missing its parent node")?;
            let mut dsl = workflow::subworkflow_dsl(&context.workflow_id).await.stringify_err()?;
            workflow::inject_subworkflow_context(&mut dsl, &context.thread_id, parent_node_id);
            (dsl, context.thread_id)
        },
        None => (serde_json::from_value(dsl).stringify_err()?, thread_id),
    };
    let answer_key = workflow::ask_user_question_answer_key(&dsl, &node_id).stringify_err()?;
    let option_id = workflow::ask_user_question_option_id(&dsl, &node_id, &option_id).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config, None).await.stringify_err()?;
    compiled
        .update_state(&thread_id, [(answer_key, Value::String(option_id))])
        .await
        .stringify_err()
}
