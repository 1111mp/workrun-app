//! Read/discuss/propose only. Workflow configuration is a separate specialist.
pub(super) mod plans;
mod skills;
pub(super) mod tools;
use super::sdk;
use adk_rust::{Agent, IncludeContents, ToolExecutionStrategy, prelude::LlmAgentBuilder};
use anyhow::Result;
use std::sync::Arc;
use tokio::sync::mpsc;
pub(super) fn build(model: &str, requests: mpsc::Sender<sdk::Request>, steps: usize) -> Result<Arc<dyn Agent>> {
    let catalog = skills::catalog();
    // One compact native inventory lets the planner select candidates together
    // instead of spending a model turn discovering each executor category.
    let capabilities = crate::module::workflow::contracts::NODE_TYPES
        .iter()
        .map(|kind| {
            let contract = crate::module::workflow::contracts::node_contract(kind)?;
            Ok(format!(
                "{}: {}",
                kind,
                contract["planning"]["capability"].as_str().unwrap()
            ))
        })
        .collect::<anyhow::Result<Vec<_>>>()?
        .join("\n");
    let mut builder=LlmAgentBuilder::new("workflow_planner")
        .description("Find a suitable existing workflow first, or propose a new/revised definition when needed; cannot create or execute workflows")
        .instruction(format!("{}\n\n{}\n\nNative node capabilities (selection inventory; read selected semantics together if feasibility is unresolved):\n{}",super::resources::read("planning_agent/AGENT.md")?,catalog.read("workflow-planning")?,capabilities))
        .model(Arc::new(sdk::Model{agent:"workflow_planner".into(),name:model.into(),requests:requests.clone()}))
        .include_contents(IncludeContents::None).max_iterations(steps as u32)
        .tool_execution_strategy(ToolExecutionStrategy::Sequential).disallow_transfer_to_peers(true);
    for declaration in tools::declarations().into_values() {
        builder = builder.tool(Arc::new(sdk::NativeTool {
            agent: "workflow_planner".into(),
            declaration,
            requests: requests.clone(),
        }));
    }
    Ok(Arc::new(sdk::ReturningAgent {
        inner: Arc::new(builder.build()?),
        requests,
    }))
}
