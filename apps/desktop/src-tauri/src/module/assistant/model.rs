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

/// Tool-round narration is progress, not a prefix of the eventual answer.
pub(super) async fn generate_answer(
    model: &dyn Llm,
    request: LlmRequest,
    emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
) -> Result<Content> {
    // A function call can arrive after text, so classify the complete response
    // before exposing its text. Thinking and explicit progress remain live.
    let content = generate(model, request, &|event| match event {
        AssistantStreamEvent::TextDelta { .. } | AssistantStreamEvent::TextReplace { .. } => Ok(()),
        event => emit(event),
    })
    .await?;
    let text = content_text(&content);
    if !text.trim().is_empty() {
        if content
            .parts
            .iter()
            .any(|part| matches!(part, Part::FunctionCall { .. }))
        {
            emit(AssistantStreamEvent::Activity { summary: text })?;
        } else {
            emit(AssistantStreamEvent::TextReplace { text })?;
        }
    }
    Ok(content)
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
    super::execution_context::project(&mut request.contents);
    // ADK normalizes function schemas, but forwards response_schema verbatim.
    // Apply the same provider adapter to structured intent output (Gemini's
    // response Schema rejects JSON Schema's additionalProperties keyword).
    if let Some(config) = &mut request.config
        && let Some(schema) = config.response_schema.take()
    {
        config.response_schema = Some(model.schema_adapter().normalize_schema(schema));
    }
    // Stream deltas are adjacent text parts, not separate paragraphs. Some
    // adapters join parts with newlines when replaying history, corrupting
    // Markdown and identifiers. Compact only adjacent text, preserving all
    // explicit whitespace and non-text parts (including signed tool calls).
    for content in &mut request.contents {
        let mut parts = Vec::with_capacity(content.parts.len());
        for part in std::mem::take(&mut content.parts) {
            match (parts.last_mut(), part) {
                (Some(Part::Text { text }), Part::Text { text: next }) => text.push_str(&next),
                (_, part) => parts.push(part),
            }
        }
        content.parts = parts;
    }
    // Some provider adapters map one Content to one wire tool message. A
    // multi-response envelope would retain only its last tool_call_id.
    request.contents = request
        .contents
        .into_iter()
        .flat_map(|content| {
            if matches!(content.role.as_str(), "function" | "tool")
                && content.parts.len() > 1
                && content
                    .parts
                    .iter()
                    .all(|part| matches!(part, Part::FunctionResponse { .. }))
            {
                content
                    .parts
                    .into_iter()
                    .map(|part| Content {
                        role: content.role.clone(),
                        parts: vec![part],
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![content]
            }
        })
        .collect();
    let (_, mut stream) =
        crate::module::model_usage::observe(model, request, true, crate::module::model_usage::current()).await?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn duplicate_read_views_survive_wire_splitting_without_changing_calls() {
        let calls = Content {
            role: "model".into(),
            parts: ["read-1", "read-2"]
                .map(|id| Part::FunctionCall {
                    name: "get_workflow_reference".into(),
                    args: json!({"topic":"state"}),
                    id: Some(id.into()),
                    thought_signature: Some("provider-signature".into()),
                })
                .to_vec(),
        };
        let result = json!({"content":"state contract".repeat(500)});
        let replies: Content = serde_json::from_value(json!({"role":"function","parts":[
            {"functionResponse":{"name":"get_workflow_reference","response":result},"id":"read-1"},
            {"functionResponse":{"name":"get_workflow_reference","response":result},"id":"read-2"}
        ]}))
        .unwrap();
        let model = crate::module::assistant::tests::ScriptedModel::new(vec![Content::new("model").with_text("ok")]);
        generate(&model, LlmRequest::new("test", vec![calls.clone(), replies]), &|_| {
            Ok(())
        })
        .await
        .unwrap();
        let requests = model.requests.lock().unwrap();
        let wire = serde_json::to_value(&requests[0].contents).unwrap();
        assert_eq!(wire[0], serde_json::to_value(calls).unwrap());
        assert_eq!(wire[1]["parts"][0]["id"], "read-1");
        assert_eq!(
            wire[1]["parts"][0]["functionResponse"]["response"]["duplicateOfToolCallId"],
            "read-2"
        );
        assert_eq!(wire[2]["parts"][0]["id"], "read-2");
        assert_eq!(wire[2]["parts"][0]["functionResponse"]["response"], result);
    }

    #[tokio::test]
    async fn replayed_stream_fragments_preserve_markdown_whitespace_and_tool_boundaries() {
        let fragments = [
            "##",
            " Result",
            "\n\n",
            "**",
            "job-",
            "42",
            "**",
            "\n\n",
            "| Key | Value |\n",
            "| --- | --- |\n",
            "| Total | ",
            "12",
            ".50 |\n",
        ];
        let expected = fragments.concat();
        let mut history = Content::new("model");
        for text in fragments {
            history = history.with_text(text);
        }
        let call: Part = serde_json::from_value(json!({
            "name":"lookup", "args":{}, "id":"call-1", "thought_signature":"signed"
        }))
        .unwrap();
        history.parts.push(call.clone());
        history.parts.push(Part::Text { text: "after".into() });
        let model = crate::module::assistant::tests::ScriptedModel::new(vec![Content::new("model").with_text("done")]);
        generate(
            &model,
            LlmRequest {
                model: "test".into(),
                contents: vec![history],
                config: None,
                tools: Default::default(),
                previous_response_id: None,
            },
            &|_| Ok(()),
        )
        .await
        .unwrap();
        let requests = model.requests.lock().unwrap();
        let parts = &requests[0].contents[0].parts;
        assert_eq!(parts.len(), 3);
        assert_eq!(serde_json::to_value(&parts[0]).unwrap(), json!({"text":expected}));
        assert_eq!(
            serde_json::to_value(&parts[1]).unwrap(),
            serde_json::to_value(call).unwrap()
        );
        assert_eq!(serde_json::to_value(&parts[2]).unwrap(), json!({"text":"after"}));
    }

    #[tokio::test]
    async fn provider_requests_preserve_each_batched_tool_reply_and_signed_call() {
        let calls: Content = serde_json::from_value(json!({"role":"model","parts":[
            {"name":"lookup","args":{},"id":"call-a","thought_signature":"signature-a"},
            {"name":"inspect","args":{},"id":"call-b","thought_signature":"signature-b"}
        ]}))
        .unwrap();
        let replies: Content = serde_json::from_value(json!({"role":"function","parts":[
            {"functionResponse":{"name":"lookup","response":{"value":7}},"id":"call-a"},
            {"functionResponse":{"name":"inspect","response":{"error":"unavailable"}},"id":"call-b"}
        ]}))
        .unwrap();
        let expected_parts = replies.parts.clone();
        let model = crate::module::assistant::tests::ScriptedModel::new(vec![Content::new("model").with_text("done")]);
        generate(
            &model,
            LlmRequest {
                model: "test".into(),
                contents: vec![calls.clone(), replies],
                config: None,
                tools: Default::default(),
                previous_response_id: None,
            },
            &|_| Ok(()),
        )
        .await
        .unwrap();
        let requests = model.requests.lock().unwrap();
        let contents = &requests[0].contents;
        assert_eq!(
            serde_json::to_value(&contents[0]).unwrap(),
            serde_json::to_value(calls).unwrap()
        );
        assert_eq!(contents.len(), 3);
        for (reply, expected) in contents[1..].iter().zip(expected_parts) {
            assert_eq!(reply.role, "function");
            assert_eq!(reply.parts.len(), 1);
            assert_eq!(
                serde_json::to_value(&reply.parts[0]).unwrap(),
                serde_json::to_value(expected).unwrap()
            );
        }
    }
    #[tokio::test]
    async fn provider_boundary_uses_delivery_views_but_explicit_inspection_keeps_stored_details() {
        let raw = "internal-process".repeat(3000);
        let history: Vec<Content> = serde_json::from_value(json!([
            {"role":"model","parts":[{"name":"execute_capability","args":{},"id":"call-original","thought_signature":"authentic"}]},
            {"role":"function","parts":[{"functionResponse":{"name":"execute_capability","response":{
                "runId":"native-run","status":"completed","output":{"answer":42},"result":raw
            }},"id":"call-original"}]},
            {"role":"function","parts":[{"functionResponse":{"name":"inspect_execution","response":[{"stored":raw}]},"id":"inspect-call"}]}
        ])).unwrap();
        let original = serde_json::to_value(&history).unwrap();
        let model = crate::module::assistant::tests::ScriptedModel::new(vec![Content::new("model").with_text("done")]);
        generate(&model, LlmRequest::new("test", history.clone()), &|_| Ok(()))
            .await
            .unwrap();
        let requests = model.requests.lock().unwrap();
        let sent = serde_json::to_value(&requests[0].contents).unwrap();
        assert_eq!(sent[0], original[0]);
        assert_eq!(sent[1]["parts"][0]["id"], "call-original");
        assert!(
            sent[1]["parts"][0]["functionResponse"]["response"]
                .get("result")
                .is_none()
        );
        assert_eq!(
            sent[1]["parts"][0]["functionResponse"]["response"]["output"]["answer"],
            42
        );
        assert_eq!(sent[2], original[2]);
        assert_eq!(serde_json::to_value(history).unwrap(), original);
    }
}
