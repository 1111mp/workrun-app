//! Scoped ADK adapters. SDK-owned agents borrow Workrun services through requests,
//! without cloning credentials or extending a workspace service's lifetime.
use adk_rust::{AdkError, Content, Llm, LlmRequest, LlmResponse, LlmResponseStream, Tool, ToolContext};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, oneshot};

pub(super) enum Request {
    WorkflowFinished(String, Option<String>, oneshot::Sender<anyhow::Result<Value>>),
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
