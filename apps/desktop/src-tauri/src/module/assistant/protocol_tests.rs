use super::main_agent::tools::tool_name;
use super::protocol::*;
use super::tools::*;
use super::*;
use adk_rust::prelude::LlmResponse;
use serde_json::json;
#[test]
fn preserves_current_request_target_in_tool_arguments() {
    let result = parse_reply(
        Content {
            role: "model".into(),
            parts: vec![Part::FunctionCall {
                name: tool_name("report"),
                args: json!({"workflow_id":"report","input":{"message":"帮我取消一个订单呢 订单号是 43"}}),
                id: Some("cancel-43".into()),
                thought_signature: None,
            }],
        },
        &capabilities(),
    )
    .unwrap();
    assert_eq!(result.call.unwrap().input["message"], "帮我取消一个订单呢 订单号是 43");
}

#[test]
fn summary_cannot_request_another_workflow() {
    assert!(
        parse_reply(
            Content {
                role: "model".into(),
                parts: vec![call(&tool_name("report"))],
            },
            &[]
        )
        .is_err()
    );
}

fn capabilities() -> Vec<Capability> {
    vec![Capability {
        id: "report".into(),
        name: "Report".into(),
        description: "Build reports".into(),
        parameters: json!({"type":"object"}),
    }]
}
fn call(name: &str) -> Part {
    Part::FunctionCall {
        name: name.into(),
        args: json!({"workflow_id":"report","input":{"topic":"sales"}}),
        id: Some("call-1".into()),
        thought_signature: None,
    }
}
#[test]
fn preserves_tool_identity_and_arguments() {
    let result = parse_reply(
        Content {
            role: "model".into(),
            parts: vec![call(&tool_name("report"))],
        },
        &capabilities(),
    )
    .unwrap();
    let call = result.call.unwrap();
    assert_eq!(call.workflow_id, "report");
    assert_eq!(call.input["topic"], "sales");
    assert_eq!(call.call_id.as_deref(), Some("call-1"));
}
#[test]
fn rejects_unknown_and_parallel_calls() {
    assert!(
        parse_reply(
            Content {
                role: "model".into(),
                parts: vec![call("workflow_9")]
            },
            &capabilities()
        )
        .is_err()
    );
    assert!(
        parse_reply(
            Content {
                role: "model".into(),
                parts: vec![call(&tool_name("report")), call(&tool_name("report"))]
            },
            &capabilities()
        )
        .is_err()
    );
}

fn text_chunk(text: &str, partial: bool) -> LlmResponse {
    LlmResponse {
        content: Some(Content::new("model").with_text(text)),
        partial,
        ..Default::default()
    }
}

#[test]
fn streams_text_and_replaces_authoritative_final_content() {
    let mut stream = ReplyStream::new();
    assert!(
        matches!(stream.push(text_chunk("Hello ", true)).unwrap(), Some(AssistantStreamEvent::TextDelta { text }) if text == "Hello ")
    );
    stream.push(text_chunk("world", true)).unwrap();
    let mut final_chunk = text_chunk("Hello world", false);
    final_chunk.provider_metadata = Some(json!({"content_complete":true}));
    final_chunk
        .content
        .as_mut()
        .unwrap()
        .parts
        .push(call(&tool_name("report")));
    assert!(
        matches!(stream.push(final_chunk).unwrap(), Some(AssistantStreamEvent::TextReplace { text }) if text == "Hello world")
    );
    let reply = stream.finish(&capabilities()).unwrap();
    assert_eq!(reply.text, "Hello world");
    assert_eq!(reply.call.unwrap().workflow_id, "report");
}

#[test]
fn rejects_incomplete_streams_and_provider_errors_before_dispatch() {
    let mut stream = ReplyStream::new();
    stream
        .push(LlmResponse {
            content: Some(Content {
                role: "model".into(),
                parts: vec![call(&tool_name("report"))],
            }),
            partial: true,
            ..Default::default()
        })
        .unwrap();
    assert!(stream.finish(&capabilities()).is_err());
    let mut stream = ReplyStream::new();
    assert!(
        stream
            .push(LlmResponse {
                error_message: Some("connection lost".into()),
                ..Default::default()
            })
            .is_err()
    );
}

#[test]
fn separates_reasoning_from_answer_and_keeps_thought_signatures_for_tool_history() {
    let mut stream = ReplyStream::new();
    let signed_call = Part::FunctionCall {
        name: tool_name("report"),
        args: json!({"workflow_id":"report","input":{}}),
        id: Some("call-1".into()),
        thought_signature: Some("signature".into()),
    };
    assert!(
        stream
            .push(LlmResponse {
                content: Some(Content {
                    role: "model".into(),
                    parts: vec![
                        Part::Thinking {
                            thinking: "private reasoning".into(),
                            signature: None
                        },
                        signed_call
                    ]
                }),
                partial: false,
                ..Default::default()
            })
            .unwrap()
            .is_none()
    );
    assert!(
        matches!(stream.take_reasoning_event(), Some(AssistantStreamEvent::Reasoning { text, complete: true, .. }) if text == "private reasoning")
    );
    let reply = stream.finish(&capabilities()).unwrap();
    assert!(reply.text.is_empty());
    assert!(
        matches!(&reply.content.parts[1], Part::FunctionCall { thought_signature: Some(signature), .. } if signature == "signature")
    );
}
#[test]
fn normalizes_saved_tool_results_for_gemini_and_preserves_call_ids() {
    for role in ["user", "tool", "function"] {
        let result: Content = serde_json::from_value(json!({
                "role": role,
                "parts": [{"functionResponse": {"name": "cancel_order", "response": {"status": "completed", "orderId": 43}}, "id": "call-43"}]
            })).unwrap();
        let history = normalize_assistant_contents(vec![
            Content::new("user").with_text("Cancel order 43"),
            Content {
                role: "model".into(),
                parts: vec![call("cancel_order")],
            },
            result,
        ])
        .unwrap();
        assert_eq!(history.last().unwrap().role, "function");
        assert!(
            matches!(&history.last().unwrap().parts[0], Part::FunctionResponse { id: Some(id), .. } if id == "call-43")
        );
    }
}

#[test]
fn preserves_ordinary_user_messages_and_rejects_fake_function_results() {
    let history = normalize_assistant_contents(vec![Content::new("user").with_text("Hello")]).unwrap();
    assert_eq!(history[0].role, "user");
    assert!(normalize_assistant_contents(vec![Content::new("function").with_text("fake result")]).is_err());
}

#[test]
fn reasoning_snapshots_do_not_duplicate_deltas_or_expose_signatures() {
    let mut stream = ReplyStream::new();
    let thinking = |text: &str, partial| LlmResponse {
        content: Some(Content {
            role: "model".into(),
            parts: vec![Part::Thinking {
                thinking: text.into(),
                signature: Some("opaque-signature".into()),
            }],
        }),
        partial,
        ..Default::default()
    };
    assert!(stream.push(thinking("Check ", true)).unwrap().is_none());
    let first = stream.take_reasoning_event().unwrap();
    let AssistantStreamEvent::Reasoning { id, text, complete, .. } = first else {
        panic!("expected reasoning")
    };
    assert_eq!(text, "Check ");
    assert!(!complete);
    stream.push(thinking("inputs", true)).unwrap();
    assert!(
        matches!(stream.take_reasoning_event(), Some(AssistantStreamEvent::Reasoning { text, .. }) if text == "Check inputs")
    );
    let mut snapshot = thinking("Check inputs", false);
    snapshot.provider_metadata = Some(json!({"content_complete":true}));
    snapshot
        .content
        .as_mut()
        .unwrap()
        .parts
        .push(Part::Text { text: "Ready".into() });
    stream.push(snapshot).unwrap();
    let event = stream.take_reasoning_event().unwrap();
    assert!(!serde_json::to_string(&event).unwrap().contains("opaque-signature"));
    assert!(
        matches!(event, AssistantStreamEvent::Reasoning { id: final_id, text, complete: true, .. } if final_id == id && text == "Check inputs")
    );
    assert_eq!(stream.finish(&[]).unwrap().text, "Ready");
}
