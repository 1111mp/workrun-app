//! Workflow specialist registered in the coordinator's SDK agent tree.
use adk_rust::prelude::LlmAgentBuilder;
pub(in crate::module::assistant) mod authoring;
pub(in crate::module::assistant) mod skills;
pub(in crate::module::assistant) mod tools;
use super::sdk;
use adk_rust::{Agent, IncludeContents, ToolExecutionStrategy};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::mpsc;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Task {
    goal: String,
    expected_outputs: Vec<String>,
    acceptance_criteria: Vec<String>,
    #[serde(default)]
    assumptions: Vec<String>,
    target_id: Option<String>,
}

pub(super) fn validate_request(args: &Value) -> Result<()> {
    let task: Task = serde_json::from_value(args.clone())?;
    ensure!(
        !task.goal.trim().is_empty() && task.goal.len() <= 6000,
        "Delegation needs a bounded goal"
    );
    ensure!(
        !task.expected_outputs.is_empty() && !task.acceptance_criteria.is_empty(),
        "Specify intended outputs and acceptance criteria"
    );
    for values in [&task.expected_outputs, &task.acceptance_criteria, &task.assumptions] {
        ensure!(
            values.len() <= 30
                && values
                    .iter()
                    .all(|value| !value.trim().is_empty() && value.len() <= 2000),
            "Invalid task contract entries"
        );
    }
    if let Some(id) = &task.target_id {
        uuid::Uuid::parse_str(id).context("Revision target must be a workflow UUID")?;
    }
    Ok(())
}

pub(super) fn initial_task(goal: &str) -> Value {
    json!({"goal":goal,"expected_outputs":["An existing Workflow meeting the requested outcome, or a reviewable proposal only when creation/revision is needed"],"acceptance_criteria":["Compare existing capability contracts before proposing a new definition; preserve the requested scope"],"assumptions":[]})
}

pub(super) fn build(
    model_name: &str,
    requests: mpsc::Sender<sdk::Request>,
    max_steps: usize,
) -> Result<Arc<dyn Agent>> {
    let catalog = skills::catalog();
    let instruction = format!(
        "{}\n\n{}\n\nSkills: {}",
        super::resources::read("workflow_agent/AGENT.md")?,
        catalog.mandatory_instructions()?,
        catalog.summaries()
    );
    let mut builder = LlmAgentBuilder::new("workflow_author")
        .description("Design, validate and save reusable Workrun workflows for an authorized user request")
        .instruction(instruction)
        .model(Arc::new(sdk::Model {
            agent: "workflow_author".into(),
            name: model_name.into(),
            requests: requests.clone(),
        }))
        // The SDK still owns one shared session, but the specialist starts from
        // the current user message and explicit task contract, not parent prose.
        .include_contents(IncludeContents::None)
        .max_iterations(max_steps as u32)
        .tool_execution_strategy(ToolExecutionStrategy::Sequential)
        .disallow_transfer_to_peers(true);
    for declaration in tools::declarations().into_values() {
        builder = builder.tool(Arc::new(sdk::NativeTool {
            agent: "workflow_author".into(),
            declaration,
            requests: requests.clone(),
        }));
    }
    Ok(Arc::new(sdk::ReturningAgent {
        inner: Arc::new(builder.build()?),
        requests,
    }))
}
