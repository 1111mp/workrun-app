//! Shared provider adaptation and streaming; no agent-role policy.
use super::protocol::{AssistantStreamEvent, ReplyStream};
use crate::config::ModelProvider;
use adk_rust::prelude::{Content, Llm, LlmRequest, Part};
use anyhow::Result;
use futures::StreamExt;

pub(super) fn content_text(content: &Content) -> String {
    content
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

pub(super) fn instructed(provider: &ModelProvider, instruction: &str, history: &[Content]) -> Vec<Content> {
    // ADK 2.3 Gemini ignores role=system entirely. Its own LlmAgent uses a user
    // preamble. Keep that compatibility at this boundary, not in saved history.
    let role = if *provider == ModelProvider::Gemini {
        "user"
    } else {
        "system"
    };
    let mut contents = vec![Content::new(role).with_text(instruction)];
    contents.extend_from_slice(history);
    contents
}

pub(super) async fn generate(
    model: &dyn Llm,
    mut request: LlmRequest,
    emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
) -> Result<Content> {
    // ADK normalizes function schemas, but forwards response_schema verbatim.
    // Apply the same provider adapter to structured intent output (Gemini's
    // response Schema rejects JSON Schema's additionalProperties keyword).
    if let Some(config) = &mut request.config
        && let Some(schema) = config.response_schema.take()
    {
        config.response_schema = Some(model.schema_adapter().normalize_schema(schema));
    }
    let mut stream = model.generate_content(request, true).await?;
    let mut reply = ReplyStream::new();
    while let Some(response) = stream.next().await {
        let event = response
            .map_err(anyhow::Error::from)
            .and_then(|response| reply.push(response));
        if event.is_err() {
            reply.complete_reasoning();
        }
        if let Some(reasoning) = reply.take_reasoning_event() {
            emit(reasoning)?;
        }
        if let Some(event) = event? {
            emit(event)?;
        }
    }
    reply.complete_reasoning();
    if let Some(reasoning) = reply.take_reasoning_event() {
        emit(reasoning)?;
    }
    reply.finish_content()
}
