//! Provider-neutral messages, validated workflow calls and streaming receipts.
use super::tools::{Capability, EXECUTE_WORKFLOW};
use adk_rust::prelude::{Content, LlmResponse, Part};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantRequest {
    pub contents: Vec<Content>,
    pub capabilities: Vec<Capability>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCall {
    pub workflow_id: String,
    pub input: Value,
    pub tool_name: String,
    pub call_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantReply {
    pub content: Content,
    pub text: String,
    pub call: Option<WorkflowCall>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AssistantStreamEvent {
    TextDelta {
        text: String,
    },
    TextReplace {
        text: String,
    },
    // Public approach summaries are distinct from provider-returned thinking.
    Activity {
        summary: String,
    },
    Reasoning {
        id: String,
        text: String,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
        complete: bool,
    },
}

pub(super) struct ReplyStream {
    content: Content,
    finished: bool,
    reasoning_id: String,
    reasoning: String,
    reasoning_started: Option<std::time::Instant>,
    reasoning_duration_ms: Option<u64>,
    reasoning_dirty: bool,
}

impl ReplyStream {
    pub(super) fn new() -> Self {
        Self {
            content: Content::new("model"),
            finished: false,
            reasoning_id: uuid::Uuid::new_v4().to_string(),
            reasoning: String::new(),
            reasoning_started: None,
            reasoning_duration_ms: None,
            reasoning_dirty: false,
        }
    }

    pub(super) fn push(&mut self, response: LlmResponse) -> Result<Option<AssistantStreamEvent>> {
        if response.error_code.is_some() || response.error_message.is_some() {
            bail!("{}", response.error_message.or(response.error_code).unwrap_or_default());
        }
        if response.interrupted {
            bail!("assistant response was interrupted");
        }
        self.finished |= !response.partial;
        let replace = !response.partial
            && response
                .provider_metadata
                .as_ref()
                .and_then(|metadata| metadata.get("content_complete"))
                .and_then(Value::as_bool)
                == Some(true);
        let Some(content) = response.content else {
            return Ok(None);
        };
        let text = content
            .parts
            .iter()
            .filter_map(|part| match part {
                Part::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<String>();
        let thinking = content
            .parts
            .iter()
            .filter_map(|part| match part {
                Part::Thinking { thinking, .. } => Some(thinking.as_str()),
                _ => None,
            })
            .collect::<String>();
        if !thinking.is_empty() {
            self.reasoning_started.get_or_insert_with(std::time::Instant::now);
            // Authoritative provider snapshots replace deltas, including thinking.
            if replace {
                self.reasoning = thinking;
            } else {
                self.reasoning.push_str(&thinking);
            }
            self.reasoning_dirty = true;
        }
        if !text.is_empty()
            || !response.partial
            || content
                .parts
                .iter()
                .any(|part| matches!(part, Part::FunctionCall { .. }))
        {
            self.complete_reasoning();
        }
        // Some adapters finish with an authoritative snapshot containing the
        // same text and signed tool calls already streamed as deltas.
        if replace {
            self.content = content;
            Ok(Some(AssistantStreamEvent::TextReplace { text }))
        } else {
            self.content.parts.extend(content.parts);
            Ok((!text.is_empty()).then_some(AssistantStreamEvent::TextDelta { text }))
        }
    }

    pub(super) fn complete_reasoning(&mut self) {
        if self.reasoning_duration_ms.is_none()
            && let Some(started) = self.reasoning_started
        {
            self.reasoning_duration_ms = Some(started.elapsed().as_millis() as u64);
            self.reasoning_dirty = true;
        }
    }

    pub(super) fn take_reasoning_event(&mut self) -> Option<AssistantStreamEvent> {
        if !std::mem::take(&mut self.reasoning_dirty) {
            return None;
        }
        Some(AssistantStreamEvent::Reasoning {
            id: self.reasoning_id.clone(),
            text: self.reasoning.clone(),
            duration_ms: self
                .reasoning_duration_ms
                .unwrap_or_else(|| self.reasoning_started.unwrap().elapsed().as_millis() as u64),
            complete: self.reasoning_duration_ms.is_some(),
        })
    }

    pub(super) fn finish_content(self) -> Result<Content> {
        if !self.finished {
            bail!("assistant stream ended before the response completed");
        }
        Ok(self.content)
    }

    #[cfg(test)]
    pub(super) fn finish(self, capabilities: &[Capability]) -> Result<AssistantReply> {
        parse_reply(self.finish_content()?, capabilities)
    }
}

pub(super) fn parse_reply(content: Content, capabilities: &[Capability]) -> Result<AssistantReply> {
    let mut text = String::new();
    let mut call = None;
    for part in &content.parts {
        match part {
            Part::Text { text: value } => text.push_str(value),
            Part::FunctionCall { name, args, id, .. } => {
                if call.is_some() {
                    bail!("assistant must call one workflow at a time");
                }
                if name != EXECUTE_WORKFLOW {
                    bail!("assistant selected an unavailable tool");
                }
                let workflow_id = args
                    .get("workflow_id")
                    .and_then(Value::as_str)
                    .context("workflow_id is required")?;
                let capability = capabilities
                    .iter()
                    .find(|cap| cap.id == workflow_id)
                    .context("assistant selected an unavailable workflow")?;
                let input = args
                    .get("input")
                    .filter(|input| input.is_object())
                    .context("workflow input must be an object")?;
                call = Some(WorkflowCall {
                    workflow_id: capability.id.clone(),
                    input: input.clone(),
                    tool_name: name.clone(),
                    call_id: id.clone(),
                });
            },
            _ => {},
        }
    }
    if text.trim().is_empty() && call.is_none() {
        bail!("model returned no answer or workflow call");
    }
    Ok(AssistantReply { content, text, call })
}

/// Older sessions stored tool results as `user`; Gemini drops those parts.
/// Normalize by payload so saved conversations can resume without rerunning tools.
pub(super) fn normalize_assistant_contents(mut contents: Vec<Content>) -> Result<Vec<Content>> {
    if contents.is_empty() || contents.len() > 200 {
        bail!("conversation must contain 1–200 messages; start a new conversation when full");
    }
    for content in &mut contents {
        if !matches!(content.role.as_str(), "user" | "model" | "tool" | "function") {
            bail!("invalid conversation role");
        }
        let tool_result = !content.parts.is_empty()
            && content
                .parts
                .iter()
                .all(|part| matches!(part, Part::FunctionResponse { .. }));
        if tool_result {
            content.role = "function".into();
        } else if matches!(content.role.as_str(), "tool" | "function") {
            bail!("tool result message has no function response");
        }
    }
    Ok(contents)
}
