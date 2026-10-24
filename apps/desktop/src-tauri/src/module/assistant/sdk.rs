//! Scoped ADK adapters. SDK-owned agents borrow Workrun services through requests,
//! without cloning credentials or extending a workspace service's lifetime.
use adk_rust::{AdkError, Content, Llm, LlmRequest, LlmResponse, LlmResponseStream, Tool, ToolContext};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(super) enum Request {
    SpecialistFinished(String, String, Option<String>, oneshot::Sender<anyhow::Result<Value>>),
    Model(String, Box<LlmRequest>, oneshot::Sender<anyhow::Result<Content>>),
    Tool(String, String, Value, oneshot::Sender<anyhow::Result<Value>>),
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
            .send(Request::Tool(self.agent.clone(), self.name().into(), args, send))
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
                    transfer.actions.transfer_to_agent = Some("main_agent".into());
                    yield Ok(transfer);
                },
                _ => { yield Err(adk_rust::AdkError::agent("Specialist outcome could not be recorded")); },
            }
        }))
    }
}
