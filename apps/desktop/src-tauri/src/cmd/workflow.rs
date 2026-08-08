use crate::{
    cmd::{CmdResult, StringifyErr},
    config::Config,
    module::workflow::{self, WorkflowDsl, WorkflowPlan, WorkflowRunResult},
};
use adk_rust::graph::State;
use serde_json::Value;

/// Validate and compile the exact `{ nodes, edges }` document emitted by React
/// Flow. The returned plan is useful for a pre-run graph preview.
#[tauri::command]
pub async fn workflow_compile(dsl: Value) -> CmdResult<WorkflowPlan> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config).stringify_err()?;
    Ok(compiled.plan().clone())
}

/// Execute the compiled ADK graph. `initial_state` feeds selector fields such
/// as `approved` and `route`; it must be a JSON object.
#[tauri::command]
pub async fn workflow_run(dsl: Value, initial_state: Value, thread_id: Option<String>) -> CmdResult<WorkflowRunResult> {
    let dsl: WorkflowDsl = serde_json::from_value(dsl).stringify_err()?;
    let state: State = serde_json::from_value(initial_state).stringify_err()?;
    let config = Config::workrun().await.latest_arc();
    let compiled = workflow::compile(dsl, &config).stringify_err()?;
    compiled
        .run(state, thread_id.as_deref().unwrap_or("workflow-run"))
        .await
        .stringify_err()
}
