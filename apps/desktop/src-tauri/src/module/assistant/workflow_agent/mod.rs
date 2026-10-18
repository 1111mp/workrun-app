//! Workflow specialist registered in the coordinator's SDK agent tree.
use adk_rust::prelude::LlmAgentBuilder;
pub(in crate::module::assistant) mod authoring;
pub(in crate::module::assistant) mod skills;
pub(in crate::module::assistant) mod tools;
use super::{model::content_text, sdk};
use adk_rust::{Agent, Event, EventStream, IncludeContents, InvocationContext, ToolExecutionStrategy};
use anyhow::{Context, Result, ensure};
use futures::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};
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

pub(super) fn task_declaration() -> Value {
    json!({"name":"prepare_workflow_task","description":"Prepare the task contract for a subsequent transfer_to_agent to workflow_author. This tool only records the contract; it does not call another agent. Use only when the user requested/accepted workflow creation, modification or automation. Ordinary one-off tasks should use direct tools. Describe the goal, outputs, criteria and known assumptions; let the specialist choose nodes. The workflow specialist uses this contract after the SDK transfers control. target_id identifies an existing workflow to revise; omit/null for creation.","parameters":{"type":"object","properties":{"goal":{"type":"string","maxLength":6000},"expected_outputs":{"type":"array","items":{"type":"string"}},"acceptance_criteria":{"type":"array","items":{"type":"string"}},"assumptions":{"type":"array","items":{"type":"string"}},"target_id":{"type":["string","null"]}},"required":["goal","expected_outputs","acceptance_criteria"],"additionalProperties":false}})
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
    json!({"goal":goal,"expected_outputs":["A saved reusable Workflow implementing the requested outcome"],"acceptance_criteria":["Native validation passes and unresolved task assumptions are identified"],"assumptions":[]})
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
        catalog.read("workflow-authoring")?,
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
    Ok(Arc::new(WorkflowAgent {
        inner: Arc::new(builder.build()?),
        requests,
    }))
}

/// A specialist is a bounded task, so completion returns to its coordinator.
/// This adapter emits an SDK transfer event; it never invokes the parent itself.
struct WorkflowAgent {
    inner: Arc<dyn Agent>,
    requests: mpsc::Sender<sdk::Request>,
}
#[async_trait::async_trait]
impl Agent for WorkflowAgent {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn sub_agents(&self) -> &[Arc<dyn Agent>] {
        self.inner.sub_agents()
    }
    async fn run(&self, context: Arc<dyn InvocationContext>) -> adk_rust::Result<EventStream> {
        let mut stream = self.inner.run(context.clone()).await?;
        let requests = self.requests.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut final_text = String::new();
            let mut failure = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(mut event) => {
                        if let Some(content) = &event.llm_response.content
                            && !content.parts.iter().any(|part| matches!(part, adk_rust::Part::FunctionCall { .. })) {
                            let text = content_text(content);
                            if !text.trim().is_empty() { final_text = text; }
                        }
                        // Completion below publishes the validated native outcome
                        // before control returns, including explicit model handoffs.
                        if event.actions.transfer_to_agent.take().is_some() { break; }
                        yield Ok(event);
                    },
                    Err(error) => { failure = Some(error.to_string()); break; },
                }
            }
            let (send, receive) = oneshot::channel();
            if requests.send(sdk::Request::WorkflowFinished(final_text, failure, send)).await.is_err() { return; }
            match receive.await {
                Ok(Ok(outcome)) => {
                    let mut result = Event::new(context.invocation_id());
                    result.author = "workflow_author".into();
                    result.llm_response.content = Some(adk_rust::Content::new("model").with_text(outcome.to_string()));
                    yield Ok(result);
                    let mut transfer = Event::new(context.invocation_id());
                    transfer.author = "workflow_author".into();
                    transfer.actions.transfer_to_agent = Some("main_agent".into());
                    yield Ok(transfer);
                },
                _ => { yield Err(adk_rust::AdkError::agent("Workflow outcome could not be recorded")); },
            }
        }))
    }
}
