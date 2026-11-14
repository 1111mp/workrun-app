//! Scoped ADK adapters. SDK-owned agents borrow Workrun services through requests,
//! without cloning credentials or extending a workspace service's lifetime.
use adk_rust::{AdkError, Content, Llm, LlmRequest, LlmResponse, LlmResponseStream, Tool, ToolContext};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(super) enum Request {
    SpecialistFinished(String, String, Option<String>, oneshot::Sender<anyhow::Result<Value>>),
    Model(String, Box<LlmRequest>, oneshot::Sender<anyhow::Result<Content>>),
    Tool(
        String,
        String,
        Value,
        tracing::Span,
        oneshot::Sender<anyhow::Result<Value>>,
    ),
}

pub(super) struct Model {
    pub agent: String,
    pub name: String,
    pub requests: mpsc::Sender<Request>,
}
#[async_trait::async_trait]
impl Llm for Model {
    fn name(&self) -> &str {
        &self.name
    }
    async fn generate_content(&self, request: LlmRequest, _: bool) -> adk_rust::Result<LlmResponseStream> {
        let (send, receive) = oneshot::channel();
        self.requests
            .send(Request::Model(self.agent.clone(), Box::new(request), send))
            .await
            .map_err(|_| AdkError::agent("Scoped agent invocation ended"))?;
        let content = receive
            .await
            .map_err(|_| AdkError::agent("Scoped model request cancelled"))?
            .map_err(|error| AdkError::agent(error.to_string()))?;
        Ok(Box::pin(futures::stream::once(async move {
            Ok(LlmResponse {
                content: Some(content),
                ..Default::default()
            })
        })))
    }
}

pub(super) struct NativeTool {
    pub agent: String,
    pub declaration: Value,
    pub requests: mpsc::Sender<Request>,
}
#[async_trait::async_trait]
impl Tool for NativeTool {
    fn name(&self) -> &str {
        self.declaration["name"].as_str().unwrap()
    }
    fn description(&self) -> &str {
        self.declaration["description"].as_str().unwrap()
    }
    fn declaration(&self) -> Value {
        self.declaration.clone()
    }
    fn parameters_schema(&self) -> Option<Value> {
        self.declaration.get("parameters").cloned()
    }
    async fn execute(&self, _: Arc<dyn ToolContext>, args: Value) -> adk_rust::Result<Value> {
        let (send, receive) = oneshot::channel();
        self.requests
            .send(Request::Tool(
                self.agent.clone(),
                self.name().into(),
                args,
                tracing::Span::current(),
                send,
            ))
            .await
            .map_err(|_| AdkError::tool("Scoped agent invocation ended"))?;
        receive
            .await
            .map_err(|_| AdkError::tool("Scoped tool request cancelled"))?
            .map_err(|error| AdkError::tool(error.to_string()))
    }
}

use adk_rust::{Agent, Event, EventStream, InvocationContext};
use futures::StreamExt;
/// A specialist is a bounded task, so completion returns to its coordinator.
/// This adapter emits an SDK transfer event; it never invokes the parent itself.
pub(super) struct ReturningAgent {
    pub inner: Arc<dyn Agent>,
    pub requests: mpsc::Sender<Request>,
}
#[async_trait::async_trait]
impl Agent for ReturningAgent {
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
        let agent = self.name().to_string();
        Ok(Box::pin(async_stream::stream! {
            let mut final_text = String::new();
            let mut failure = None;
            while let Some(event) = stream.next().await {
                match event {
                    Ok(mut event) => {
                        if let Some(content) = &event.llm_response.content
                            && !content.parts.iter().any(|part| matches!(part, adk_rust::Part::FunctionCall { .. })) {
                            let text = crate::module::assistant::model::content_text(content);
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
            if requests.send(Request::SpecialistFinished(agent.clone(), final_text, failure, send)).await.is_err() { return; }
            match receive.await {
                Ok(Ok(outcome)) => {
                    let mut result = Event::new(context.invocation_id());
                    result.author = agent.clone();
                    result.llm_response.content = Some(adk_rust::Content::new("model").with_text(outcome.to_string()));
                    yield Ok(result);
                    let mut transfer = Event::new(context.invocation_id());
                    transfer.author = agent.clone();
                    transfer.actions.transfer_to_agent = Some("task_agent".into());
                    yield Ok(transfer);
                },
                _ => { yield Err(adk_rust::AdkError::agent("Specialist outcome could not be recorded")); },
            }
        }))
    }
}

#[cfg(test)]
mod telemetry_tests {
    use super::*;
    use futures::StreamExt;
    use serde_json::json;
    use tracing::{Instrument, instrument::WithSubscriber};
    struct Fixture(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl Llm for Fixture {
        fn name(&self) -> &str {
            "fixture-native-adk"
        }
        async fn generate_content(&self, _: LlmRequest, stream: bool) -> adk_rust::Result<LlmResponseStream> {
            let step = self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let content = match step {
                0 => Content::new("model").with_text(r#"{"route":"task"}"#),
                1 => Content {
                    role: "model".into(),
                    parts: vec![adk_rust::Part::FunctionCall {
                        name: "report_progress".into(),
                        args: json!({"summary":"Verification progress"}),
                        id: Some("fixture-call".into()),
                        thought_signature: None,
                    }],
                },
                _ => Content::new("model").with_text("Tool verification complete"),
            };
            let span = adk_telemetry::llm_generate_span("fixture", self.name(), stream);
            let response = LlmResponse {
                content: Some(content),
                usage_metadata: Some(adk_rust::UsageMetadata {
                    prompt_token_count: 10,
                    candidates_token_count: 5,
                    total_token_count: 15,
                    ..Default::default()
                }),
                ..Default::default()
            };
            Ok(Box::pin(futures::stream::iter(vec![Ok(response)]).map(
                move |response| {
                    let _entered = span.enter();
                    adk_telemetry::record_llm_usage(&adk_telemetry::LlmUsage {
                        input_tokens: 10,
                        output_tokens: 5,
                        total_tokens: 15,
                        ..Default::default()
                    });
                    response
                },
            )))
        }
    }
    #[tokio::test]
    #[ignore = "local Langfuse required; scripted provider and harmless report_progress tool"]
    async fn export_homepage_tool_roundtrip() {
        let subscriber = crate::core::telemetry::subscriber("http://127.0.0.1:4317").unwrap();
        crate::core::telemetry::test_capture(true);
        let session = uuid::Uuid::new_v4().to_string();
        println!("homepage_probe={session}");
        let origin = crate::module::model_usage::CallContext {
            workspace_id: "personal".into(),
            session_kind: Some("assistant".into()),
            session_id: Some(session.clone()),
            turn_id: Some(session.clone()),
            purpose: "conversation".into(),
            ..Default::default()
        };
        async {
            let root=tracing::info_span!("workrun.homepage.probe","otel.name"="对话","langfuse.observation.type"="agent","langfuse.session.id"=%session);
            crate::module::model_usage::scope(origin,async {
                let workspace=tempfile::tempdir().unwrap();
                let runtime=crate::module::assistant::AssistantRuntime::load(workspace.path()).unwrap();
                let request=serde_json::from_value(json!({"contents":[{"role":"user","parts":[{"text":"Verify a harmless progress tool"}]}],"capabilities":[],"context":{"sessionId":session}})).unwrap();
                let model=Fixture(std::sync::atomic::AtomicUsize::new(0));
                let reply=runtime.run(&model,&crate::config::ModelProvider::Gemini,request,&|_|Ok(())).await.unwrap();
                assert_eq!(reply.text,"Tool verification complete");
                assert_eq!(model.0.load(std::sync::atomic::Ordering::Relaxed),3);
            }).instrument(root).await;
        }.with_subscriber(subscriber).await;
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        crate::core::telemetry::test_capture(false);
    }
}
