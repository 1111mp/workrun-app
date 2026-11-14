//! Conversation-only handler with one non-executing escape to task capabilities.
use super::{
    model::{generate_answer, instructed},
    protocol::{AssistantReply, AssistantStreamEvent, parse_reply},
    resources,
};
use crate::config::ModelProvider;
use adk_rust::{Content, Llm, LlmRequest, Part};
use anyhow::{Result, ensure};
use serde_json::json;

pub(super) enum Outcome {
    Answer(Box<AssistantReply>),
    Task,
}
pub(super) async fn respond(
    model: &dyn Llm,
    provider: &ModelProvider,
    history: &[Content],
    workspace_instructions: &str,
    emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
) -> Result<Outcome> {
    let instruction = format!(
        "{}\n\nWorkspace instructions:\n{}",
        resources::read("conversation_agent/AGENT.md")?,
        workspace_instructions
    );
    let handoff = json!({"name":"handoff_to_task","description":"Transfer this same request when actual tools, files, external verification or Workflow work are needed. Does not execute anything.",
        "parameters":{"type":"object","properties":{},"additionalProperties":false}});
    let content = crate::module::model_usage::purpose(
        "conversation",
        generate_answer(
            model,
            LlmRequest {
                model: model.name().into(),
                contents: instructed(provider, &instruction, history),
                tools: [("handoff_to_task".into(), handoff)].into(),
                config: None,
                previous_response_id: None,
            },
            emit,
        ),
    )
    .await?;
    let calls = content
        .parts
        .iter()
        .filter_map(|p| match p {
            Part::FunctionCall { name, .. } => Some(name.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    if calls.is_empty() {
        return Ok(Outcome::Answer(Box::new(parse_reply(content, &[])?)));
    }
    ensure!(
        calls == ["handoff_to_task"],
        "conversation agent selected an unavailable tool"
    );
    Ok(Outcome::Task)
}
