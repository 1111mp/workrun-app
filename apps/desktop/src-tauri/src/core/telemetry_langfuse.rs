//! Attribute adapter for ADK-owned spans. No spans, exporter, queue or database here.
use adk_rust::{Content, LlmRequest, LlmResponse, Part};
use opentelemetry::{Context, KeyValue, trace::TraceContextExt};
use serde_json::{Value, json};
use std::{future::Future, sync::Arc};
use tracing::{
    Subscriber,
    field::{Field, Visit},
};
use tracing_subscriber::{Layer, layer::Context as LayerContext, registry::LookupSpan};

pub(crate) fn encoded(value: &Value) -> String {
    crate::module::workflow::guardrails::redact_json(value).to_string()
}
pub(crate) fn content(content: &Content) -> Value {
    json!({"role":content.role,"parts":content.parts.iter().filter_map(|part|match part {
        Part::Text{text} => Some(json!({"text":text})),
        Part::FunctionCall{name,args,id,..} => Some(json!({"toolCall":{"name":name,"args":args,"id":id.as_deref().map(|s|s.split("__thought__").next().unwrap_or(s))}})),
        Part::FunctionResponse{function_response,..} => Some(json!({"toolResult":{"name":function_response.name,"response":function_response.response}})),
        Part::InlineData{mime_type,data,..}=>Some(json!({"media":{"mimeType":mime_type,"bytes":data.len(),"bodyOmitted":true}})),
        Part::FileData{mime_type,file_uri,..}=>Some(json!({"file":{"mimeType":mime_type,"uri":file_uri}})),
        // Capture visible content, not private reasoning or binary media bodies.
        _=>None,
    }).collect::<Vec<_>>()})
}

/// Public profile only. Never retain session tokens in telemetry context.
#[derive(Clone, Default)]
pub(crate) struct User {
    id: Option<String>,
    name: Option<String>,
    email: Option<String>,
    server: Option<String>,
    mode: Option<&'static str>,
}
impl User {
    pub(crate) fn team(owner: &crate::module::team_model::TeamOwner) -> Self {
        use sha2::{Digest, Sha256};
        Self {
            id: Some(format!(
                "team:{}:{}",
                hex::encode(Sha256::digest(owner.server.as_bytes())),
                owner.user_id
            )),
            name: owner.user_name.clone(),
            email: owner.user_email.clone(),
            server: Some(owner.server.clone()),
            mode: Some("team"),
        }
    }
    pub(crate) fn personal(name: Option<&str>) -> Self {
        Self {
            name: name.filter(|v| !v.trim().is_empty()).map(str::to_owned),
            mode: Some("personal"),
            ..Self::default()
        }
    }
    fn attributes(&self) -> Vec<KeyValue> {
        [
            ("langfuse.user.id", self.id.as_deref()),
            ("langfuse.trace.metadata.userName", self.name.as_deref()),
            ("langfuse.trace.metadata.userEmail", self.email.as_deref()),
            ("langfuse.trace.metadata.server", self.server.as_deref()),
            ("langfuse.trace.metadata.workspaceMode", self.mode),
        ]
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| KeyValue::new(key, value.to_owned())))
        .collect()
    }
}
tokio::task_local! { static USER: User; }
pub(crate) async fn user<T>(identity: User, future: impl Future<Output = T>) -> T {
    USER.scope(identity, future).await
}

#[derive(Clone)]
pub(crate) struct ModelTrace(Arc<ModelData>);
struct ModelData {
    context: crate::module::model_usage::CallContext,
    call_id: String,
    model: String,
    user: User,
    tool_names: std::collections::HashMap<String, String>,
    input: Option<String>,
    native: parking_lot::Mutex<Option<Context>>,
    output: parking_lot::Mutex<Vec<Value>>,
}
tokio::task_local! { static TOOL_NAMES: std::collections::HashMap<String, String>; static MODEL: ModelTrace; static NODE: (String,String); }
pub(crate) async fn node<T>(id: &str, name: &str, future: impl Future<Output = T>) -> T {
    NODE.scope((id.into(), name.into()), future).await
}
/// Scope display aliases to this node's model request; never rewrite the provider request.
pub(crate) async fn tool_names<T>(
    names: &std::collections::HashMap<String, String>,
    future: impl Future<Output = T>,
) -> T {
    TOOL_NAMES.scope(names.clone(), future).await
}
fn display_names(value: &mut Value, names: &std::collections::HashMap<String, String>) {
    // Only visit known protocol fields. Arguments, results and user text are opaque.
    fn rename(value: &mut Value, names: &std::collections::HashMap<String, String>) {
        if let Some(name) = value.get_mut("name")
            && let Some(display) = name.as_str().and_then(|name| names.get(name))
        {
            *name = json!(display);
        }
    }
    if let Some(tools) = value.get_mut("tools").and_then(Value::as_object_mut) {
        *tools = std::mem::take(tools)
            .into_iter()
            .map(|(name, mut schema)| {
                rename(&mut schema, names);
                (names.get(&name).cloned().unwrap_or(name), schema)
            })
            .collect();
    }
    if let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            display_names(message, names);
        }
    }
    if let Some(parts) = value.get_mut("parts").and_then(Value::as_array_mut) {
        for part in parts {
            for key in ["toolCall", "toolResult"] {
                if let Some(tool) = part.get_mut(key) {
                    rename(tool, names);
                }
            }
        }
    }
}
impl ModelTrace {
    pub(crate) fn new(id: &str, request: &LlmRequest, context: &crate::module::model_usage::CallContext) -> Self {
        let mut tool_names = TOOL_NAMES.try_with(Clone::clone).unwrap_or_default();
        let original = tool_names.clone();
        // Keep exported catalog keys unique when business labels are repeated.
        for (name, display) in &mut tool_names {
            if original.values().filter(|value| *value == display).count() > 1
                || request.tools.contains_key(display) && name != display
            {
                *display = format!("{display} [{name}]");
            }
        }
        let input = super::telemetry::capture_content().then(|| {
            let mut value = json!({"messages":request.contents.iter().map(content).collect::<Vec<_>>(),"tools":request.tools,"config":request.config});
            display_names(&mut value, &tool_names);
            encoded(&value)
        });
        Self(Arc::new(ModelData {
            user: USER.try_with(Clone::clone).unwrap_or_default(),
            tool_names,
            context: context.clone(),
            call_id: id.into(),
            model: request.model.clone(),
            input,
            native: Default::default(),
            output: Default::default(),
        }))
    }
    pub(crate) async fn scope<T>(&self, future: impl Future<Output = T>) -> T {
        user(self.0.user.clone(), MODEL.scope(self.clone(), future)).await
    }
    pub(crate) fn response(&self, response: &LlmResponse) {
        if let Some(cx) = self.0.native.lock().as_ref() {
            if response.usage_metadata.is_some() {
                cx.span()
                    .set_attribute(KeyValue::new("langfuse.observation.metadata.usageComplete", true));
            }
            if self.0.input.is_some()
                && let Some(value) = &response.content
            {
                let mut output = self.0.output.lock();
                if response
                    .provider_metadata
                    .as_ref()
                    .and_then(|m| m.get("content_complete"))
                    .and_then(Value::as_bool)
                    == Some(true)
                {
                    output.clear();
                }
                let mut visible = content(value);
                display_names(&mut visible, &self.0.tool_names);
                if let Some(parts) = visible["parts"].as_array() {
                    for part in parts {
                        if let (Some(text), Some(Value::String(last))) = (
                            part.get("text").and_then(Value::as_str),
                            output.last_mut().and_then(|p| p.get_mut("text")),
                        ) {
                            last.push_str(text);
                        } else {
                            output.push(part.clone());
                        }
                    }
                }
            }
        }
    }
    pub(crate) fn finish(&self, status: &str) {
        if let Some(cx) = self.0.native.lock().as_ref() {
            cx.span()
                .set_attribute(KeyValue::new("langfuse.observation.metadata.status", status.to_owned()));
            // Serialize once at the request boundary, not on every token.
            if self.0.input.is_some() {
                cx.span().set_attribute(KeyValue::new(
                    "langfuse.observation.output",
                    encoded(&json!({"role":"model","parts":*self.0.output.lock()})),
                ));
            }
            if status != "completed" {
                cx.span()
                    .set_attribute(KeyValue::new("langfuse.observation.level", "ERROR"));
            }
        }
    }
}
#[derive(Default)]
struct ToolName(Option<String>);
impl Visit for ToolName {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "tool.name" {
            self.0 = Some(value.into());
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "tool.name" {
            self.0 = Some(format!("{value:?}"));
        }
    }
}
#[derive(Default)]
pub(crate) struct NativeAdapter(std::sync::OnceLock<tracing::dispatcher::WeakDispatch>);
impl<S: Subscriber + for<'a> LookupSpan<'a>> Layer<S> for NativeAdapter {
    fn on_register_dispatch(&self, dispatch: &tracing::Dispatch) {
        let _ = self.0.set(dispatch.downgrade());
    }
    fn on_new_span(&self, attrs: &tracing::span::Attributes<'_>, id: &tracing::Id, _: LayerContext<'_, S>) {
        let model = attrs.metadata().name() == "gen_ai.generate";
        let mut tool = ToolName::default();
        attrs.record(&mut tool);
        // Tracing guards callbacks against reentry; use the registered dispatch
        // to access the existing SDK context, rather than the thread default.
        let cx = self
            .0
            .get()
            .and_then(|dispatch| dispatch.upgrade())
            .and_then(|dispatch| tracing_opentelemetry::get_otel_context(id, &dispatch));
        let Some(cx) = cx else {
            return;
        };
        let span = cx.span();
        // Langfuse filters observations directly: stamp every span, including roots/nodes.
        let _ = USER.try_with(|user| span.set_attributes(user.attributes()));
        if !model && tool.0.is_none() {
            return;
        }
        let origin = crate::module::model_usage::current();
        let context = MODEL.try_with(|trace| trace.0.context.clone()).unwrap_or(origin);
        span.set_attribute(KeyValue::new(
            "langfuse.observation.type",
            if model { "generation" } else { "tool" },
        ));
        span.set_attribute(KeyValue::new(
            "langfuse.environment",
            if cfg!(test) {
                "test"
            } else if cfg!(debug_assertions) {
                "development"
            } else {
                "production"
            },
        ));
        span.set_attribute(KeyValue::new(
            "langfuse.observation.metadata.turnId",
            context.turn_id.clone().unwrap_or_default(),
        ));
        span.set_attribute(KeyValue::new(
            "langfuse.session.id",
            context
                .session_id
                .clone()
                .or(context.run_id.clone())
                .unwrap_or_default(),
        ));
        span.set_attribute(KeyValue::new(
            "langfuse.observation.metadata.runId",
            context.run_id.clone().unwrap_or_default(),
        ));
        let node = NODE.try_with(Clone::clone).ok();
        span.set_attribute(KeyValue::new(
            "langfuse.observation.metadata.nodeId",
            node.as_ref()
                .map(|n| n.0.clone())
                .or(context.node_id.clone())
                .unwrap_or_default(),
        ));
        if model {
            let name = node
                .as_ref()
                .map(|n| format!("{} · LLM", n.1))
                .unwrap_or_else(|| format!("LLM · {}", context.purpose));
            span.update_name(name);
            let _ = MODEL.try_with(|trace| {
                span.set_attribute(KeyValue::new("langfuse.observation.model.name", trace.0.model.clone()));
                if trace.0.input.is_some() && !trace.0.tool_names.is_empty() {
                    span.set_attribute(KeyValue::new(
                        "langfuse.observation.metadata.toolNameMapping",
                        encoded(&json!(trace.0.tool_names)),
                    ));
                }
                span.set_attribute(KeyValue::new(
                    "langfuse.observation.metadata.modelProfileId",
                    trace.0.context.model_profile_id.clone().unwrap_or_default(),
                ));
                span.set_attribute(KeyValue::new(
                    "langfuse.observation.metadata.requestBoundary",
                    "sdk_before_provider_adapter",
                ));
                span.set_attribute(KeyValue::new(
                    "langfuse.observation.metadata.callId",
                    trace.0.call_id.clone(),
                ));
                span.set_attribute(KeyValue::new("langfuse.observation.metadata.usageComplete", false));
                if let Some(input) = &trace.0.input {
                    span.set_attribute(KeyValue::new("langfuse.observation.input", input.clone()));
                }
                *trace.0.native.lock() = Some(cx.clone());
            });
        }
    }
}

/// Enrich the SDK tool span already active at the actual execution boundary.
pub(crate) async fn tool<T: serde::Serialize, E>(
    name: &str,
    args: &Value,
    future: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    use tracing_opentelemetry::OpenTelemetrySpanExt;
    let current = tracing::Span::current();
    let cx = current
        .metadata()
        .filter(|m| m.target().starts_with("adk_") && m.fields().field("tool.name").is_some())
        .map(|_| current.context());
    if let Some(cx) = &cx {
        let label = NODE
            .try_with(|node| format!("{} · {name}", node.1))
            .unwrap_or_else(|_| name.to_owned());
        cx.span().update_name(label);
        if super::telemetry::capture_content() {
            cx.span()
                .set_attribute(KeyValue::new("langfuse.observation.input", encoded(args)));
        }
    }
    let result = future.await;
    if let Some(cx) = cx {
        cx.span().set_attribute(KeyValue::new(
            "langfuse.observation.metadata.status",
            if result.is_ok() { "completed" } else { "failed" },
        ));
        if result.is_err() {
            cx.span()
                .set_attribute(KeyValue::new("langfuse.observation.level", "ERROR"));
        }
        if super::telemetry::capture_content() {
            let output = result.as_ref().map(|v| json!(v)).unwrap_or(json!({"failed":true}));
            cx.span()
                .set_attribute(KeyValue::new("langfuse.observation.output", encoded(&output)));
        }
    }
    result
}

#[cfg(test)]
mod display_tests {
    use super::*;
    #[tokio::test]
    async fn aliases_only_change_exported_protocol_names() {
        let names = std::collections::HashMap::from([("process_42".into(), "订单查询".into())]);
        let mut request = LlmRequest::new("test", vec![]);
        request.tools.insert(
            "process_42".into(),
            json!({"name":"process_42","description":"process_42"}),
        );
        let before = request.tools.clone();
        let trace = tool_names(&names, async { ModelTrace::new("call", &request, &Default::default()) }).await;
        assert_eq!(request.tools, before);
        let mut payload = json!({"tools":before,"messages":[{"parts":[
            {"toolCall":{"name":"process_42","args":{"name":"process_42"},"id":"call_42"}},
            {"toolResult":{"name":"process_42","response":{"name":"process_42"}}},
            {"text":"process_42"}, {"toolCall":{"name":"unknown"}}
        ]}]});
        display_names(&mut payload, &trace.0.tool_names);
        assert_eq!(payload["tools"]["订单查询"]["name"], "订单查询");
        assert_eq!(payload["tools"]["订单查询"]["description"], "process_42");
        let parts = &payload["messages"][0]["parts"];
        assert_eq!(parts[0]["toolCall"]["name"], "订单查询");
        assert_eq!(parts[1]["toolResult"]["name"], "订单查询");
        assert_eq!(parts[0]["toolCall"]["args"]["name"], "process_42");
        assert_eq!(parts[1]["toolResult"]["response"]["name"], "process_42");
        assert_eq!(parts[2]["text"], "process_42");
        assert_eq!(parts[3]["toolCall"]["name"], "unknown");
        assert_eq!(parts[0]["toolCall"]["id"], "call_42");
        // Aliases cannot leak into the next request or another workflow node.
        let unscoped = ModelTrace::new("next", &request, &Default::default());
        assert!(unscoped.0.tool_names.is_empty());
    }
}

#[cfg(test)]
mod user_tests {
    use super::*;
    use crate::module::team_model::TeamOwner;

    fn owner(server: &str, name: &str) -> TeamOwner {
        TeamOwner {
            server: server.into(),
            user_id: "user-1".into(),
            user_name: Some(name.into()),
            user_email: Some("demo@example.com".into()),
        }
    }

    #[test]
    fn team_identity_is_stable_across_renames_and_isolated_by_server() {
        let first = User::team(&owner("https://one.example", "Alice"));
        let renamed = User::team(&owner("https://one.example", "Bob"));
        let other = User::team(&owner("https://two.example", "Alice"));
        assert_eq!(first.id, renamed.id);
        assert_ne!(first.id, other.id);
        assert!(
            first
                .attributes()
                .iter()
                .any(|a| a.key.as_str() == "langfuse.trace.metadata.userName" && a.value.to_string() == "Alice")
        );
        let legacy: TeamOwner =
            serde_json::from_value(json!({"server":"https://one.example","userId":"user-1"})).unwrap();
        assert!(legacy.user_name.is_none());
        assert!(User::team(&legacy).id.is_some());
    }

    #[tokio::test]
    async fn model_stream_captures_user_and_scope_does_not_leak() {
        let request = LlmRequest::new("test", vec![]);
        let trace = user(User::team(&owner("https://one.example", "Alice")), async {
            ModelTrace::new("call", &request, &Default::default())
        })
        .await;
        assert!(USER.try_with(|_| ()).is_err());
        user(User::personal(Some("Local name")), async {
            trace
                .scope(async {
                    assert_eq!(USER.with(|u| u.name.clone()).as_deref(), Some("Alice"));
                })
                .await;
            assert_eq!(USER.with(|u| u.name.clone()).as_deref(), Some("Local name"));
            assert!(USER.with(|u| u.id.is_none()));
            assert!(USER.with(|u| u.email.is_none()));
        })
        .await;
        assert!(USER.try_with(|_| ()).is_err());
        assert!(User::personal(Some("  ")).name.is_none());
    }
}
