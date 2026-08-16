//! React Flow DSL -> adk-rust graph compiler.
//!
//! Layout properties emitted by React Flow are deliberately not part of the
//! runtime model.  The only execution data is a node's `id`, `type`, `data`,
//! and the edge endpoint/handle information.

use crate::{
    config::{IWorkrun, ModelDefinition, ModelProvider, model_catalog},
    module::{
        mcp_server::McpServerRegistry,
        process_node::{ProcessNodeRegistry, ToolExecutionPolicy},
        tool_registry::{ToolDefinition, ToolRegistry, ToolSource},
    },
};
use adk_rust::{
    graph::{
        AgentNode as AdkAgentNode, END, Edge, EdgeTarget, ExecutionConfig, GraphError, Node, NodeContext, NodeOutput,
        START, State, StateGraph, StreamEvent, StreamMode,
    },
    model::{
        GeminiModel,
        anthropic::{AnthropicClient, AnthropicConfig},
        deepseek::{DeepSeekClient, DeepSeekConfig},
        groq::{GroqClient, GroqConfig},
        ollama::{OllamaConfig, OllamaModel},
        openai::{OpenAIClient, OpenAIConfig},
    },
    prelude::{Content, Event, Llm, LlmAgentBuilder, Tool, ToolContext},
    server::RemoteA2aAgent,
};
use anyhow::{Result, anyhow, bail};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
    },
    time::Instant,
};
use tauri::ipc::Channel;
use tokio::sync::oneshot;

type RouterFn = Arc<dyn Fn(&State) -> String + Send + Sync>;

static TOOL_APPROVALS: OnceLock<Mutex<HashMap<String, oneshot::Sender<bool>>>> = OnceLock::new();

fn tool_approvals() -> &'static Mutex<HashMap<String, oneshot::Sender<bool>>> {
    TOOL_APPROVALS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn resolve_tool_approval(request_id: &str, approved: bool) -> Result<()> {
    let sender = tool_approvals()
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(request_id));
    let Some(sender) = sender else {
        bail!("Tool approval request is no longer pending")
    };
    let _ = sender.send(approved);
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDsl {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub data: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub source_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPlan {
    pub workflow_id: String,
    pub workflow_name: String,
    pub executable_nodes: Vec<String>,
    pub edges: Vec<PlanEdge>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEdge {
    pub source: String,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunResult {
    pub plan: WorkflowPlan,
    pub state: State,
}

pub struct CompiledWorkflow {
    graph: adk_rust::graph::CompiledGraph,
    plan: WorkflowPlan,
}

impl CompiledWorkflow {
    /// Execute the graph while forwarding ordered node and model events to the
    /// caller. The final `Done` stream event is retained as the command result.
    pub async fn run_stream<F>(
        self,
        initial_state: State,
        thread_id: &str,
        mut on_event: F,
    ) -> Result<WorkflowRunResult>
    where
        F: FnMut(StreamEvent),
    {
        let stream = self
            .graph
            .stream(initial_state, ExecutionConfig::new(thread_id), StreamMode::Messages);
        futures::pin_mut!(stream);
        let mut final_state = None;
        let mut node_started_at = HashMap::new();

        while let Some(event) = stream.next().await {
            let event = event?;
            if let StreamEvent::Done { state, .. } = &event {
                final_state = Some(state.clone());
            }
            on_event(with_measured_node_duration(event, &mut node_started_at));
        }

        let state = final_state.ok_or_else(|| anyhow!("workflow stream ended without a final state"))?;
        Ok(WorkflowRunResult { plan: self.plan, state })
    }

    pub fn plan(&self) -> &WorkflowPlan {
        &self.plan
    }
}

fn with_measured_node_duration(event: StreamEvent, node_started_at: &mut HashMap<String, Instant>) -> StreamEvent {
    match event {
        StreamEvent::NodeStart { node, step } => {
            node_started_at.insert(node.clone(), Instant::now());
            StreamEvent::node_start(&node, step)
        },
        StreamEvent::NodeEnd {
            node,
            step,
            duration_ms,
        } => {
            let duration_ms = node_started_at
                .remove(&node)
                .map(|started_at| started_at.elapsed().as_millis() as u64)
                .unwrap_or(duration_ms);
            StreamEvent::node_end(&node, step, duration_ms)
        },
        _ => event,
    }
}

/// Compile a React Flow document into an executable ADK `StateGraph`.
pub async fn compile(
    dsl: WorkflowDsl,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<CompiledWorkflow> {
    let nodes: HashMap<_, _> = dsl.nodes.iter().map(|node| (node.id.as_str(), node)).collect();
    if nodes.len() != dsl.nodes.len() {
        bail!("workflow contains duplicate node ids");
    }

    let starts = dsl.nodes.iter().filter(|node| node.kind == "start").collect::<Vec<_>>();
    if starts.len() != 1 {
        bail!("workflow must contain exactly one start node (found {})", starts.len());
    }
    if !dsl.nodes.iter().any(|node| node.kind == "end") {
        bail!("workflow must contain at least one end node");
    }

    for node in &dsl.nodes {
        if !matches!(
            node.kind.as_str(),
            "start" | "end" | "agent" | "remote_agent" | "process" | "if_else" | "switch" | "group"
        ) {
            bail!("node `{}` has unsupported type `{}`", node.id, node.kind);
        }
        if node.kind == "group"
            && dsl
                .edges
                .iter()
                .any(|edge| edge.source == node.id || edge.target == node.id)
        {
            bail!("group node `{}` is layout-only and cannot have workflow edges", node.id);
        }
    }

    let executable = dsl.nodes.iter().filter(|node| is_executable(node)).collect::<Vec<_>>();
    let executable_ids = executable.iter().map(|node| node.id.clone()).collect::<HashSet<_>>();
    let end_ids = dsl
        .nodes
        .iter()
        .filter(|node| node.kind == "end")
        .map(|node| node.id.clone())
        .collect::<HashSet<_>>();
    let start_id = starts[0].id.as_str();

    validate_edges(&dsl.edges, &nodes, &executable_ids, &end_ids, start_id)?;

    let mut graph = StateGraph::with_channels(&["workflow.last_node", "workflow.node", "workflow.trace"]);
    // Trace is append-only, which makes parallel branches observable instead of
    // having the last branch overwrite its predecessor.
    graph.schema.channels.insert(
        "workflow.trace".to_string(),
        adk_rust::graph::Channel::list("workflow.trace"),
    );

    for node in &executable {
        graph = match node.kind.as_str() {
            // A2A is a first-class ADK Agent. Wrapping it in AgentNode makes
            // the remote call a real graph execution step, not a side effect
            // performed by the Tauri command.
            "remote_agent" => graph.add_node(remote_a2a_graph_node(node, on_event.clone())?),
            "process" => add_process_node(graph, node, on_event.clone()),
            "if_else" => add_if_else_control_node(graph, node, on_event.clone())?,
            "switch" => add_switch_control_node(graph, node, on_event.clone())?,
            // Build the LLM only at execution time. This keeps `compile` pure
            // and lets users open/validate workflows before configuring keys.
            "agent" => add_local_agent_node(graph, node, config, on_event.clone()).await?,
            _ => add_control_node(graph, node),
        };
    }

    let mut plan_edges = Vec::new();
    for edge in dsl.edges.iter().filter(|edge| edge.source == start_id) {
        graph = graph.add_edge(START, &edge.target);
        plan_edges.push(PlanEdge {
            source: START.to_string(),
            target: edge.target.clone(),
            route: None,
        });
    }

    for node in &executable {
        let outgoing = dsl
            .edges
            .iter()
            .filter(|edge| edge.source == node.id)
            .collect::<Vec<_>>();
        match node.kind.as_str() {
            "if_else" => add_if_else_edges(&mut graph, node, &outgoing, &end_ids, &mut plan_edges)?,
            "switch" => add_switch_edges(&mut graph, node, &outgoing, &end_ids, &mut plan_edges)?,
            _ => {
                for edge in outgoing {
                    let target = graph_target(&edge.target, &end_ids);
                    graph.edges.push(Edge::Direct {
                        source: node.id.clone(),
                        target: target.clone(),
                    });
                    plan_edges.push(PlanEdge {
                        source: node.id.clone(),
                        target: display_target(target),
                        route: None,
                    });
                }
            },
        }
    }

    let plan = WorkflowPlan {
        workflow_id: dsl.id,
        workflow_name: dsl.name,
        executable_nodes: executable.into_iter().map(|node| node.id.clone()).collect(),
        edges: plan_edges,
    };
    Ok(CompiledWorkflow {
        graph: graph.compile()?,
        plan,
    })
}

fn is_executable(node: &WorkflowNode) -> bool {
    matches!(
        node.kind.as_str(),
        "agent" | "remote_agent" | "process" | "if_else" | "switch"
    )
}

fn add_process_node(graph: StateGraph, node: &WorkflowNode, on_event: Option<Channel<StreamEvent>>) -> StateGraph {
    graph.add_node(ProcessWorkflowNode {
        id: node.id.clone(),
        process_node_id: string_data(node, "processNodeId").unwrap_or_default(),
        name: string_data(node, "name").unwrap_or_else(|| node.id.clone()),
        on_event,
    })
}

struct ProcessWorkflowNode {
    id: String,
    process_node_id: String,
    name: String,
    on_event: Option<Channel<StreamEvent>>,
}

#[async_trait::async_trait]
impl Node for ProcessWorkflowNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        if self.process_node_id.trim().is_empty() {
            return Err(graph_node_error(&self.id, "process node needs data.processNodeId"));
        }
        let input = serde_json::to_value(&context.state).map_err(|error| graph_node_error(&self.id, error))?;
        let output_node_id = self.id.clone();
        let name = self.name.clone();
        let on_event = self.on_event.clone();
        let run = ProcessNodeRegistry::run_for_workflow(
            &self.process_node_id,
            &input,
            Arc::new(move |chunk| {
                if let Some(on_event) = &on_event {
                    let _ = on_event.send(StreamEvent::custom(
                        &output_node_id,
                        "process.output",
                        json!({ "name": name, "stream": chunk.stream, "data": chunk.data }),
                    ));
                }
            }),
        )
        .await
        .map_err(|error| graph_node_error(&self.id, error))?;
        let event = json!({
            "nodeId": self.id,
            "type": "process",
            "processNodeId": self.process_node_id,
            "processName": run.definition.name,
            "stdout": run.stdout,
            "stderr": run.stderr,
            "exitCode": run.execution.exit_code,
            "result": run.result,
        });
        if let Some(on_event) = &self.on_event {
            let _ = on_event.send(StreamEvent::custom(&self.id, "workflow.node_result", event.clone()));
        }
        let mut output = NodeOutput::new()
            .with_update("workflow.last_node", json!(self.id))
            .with_update("workflow.node", event.clone())
            .with_update("workflow.trace", event);
        for (key, value) in run.result.as_object().expect("validated Process Node result") {
            output = output.with_update(key, value.clone());
        }
        Ok(output)
    }

    fn execute_stream<'a>(
        &'a self,
        _context: &'a NodeContext,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = adk_rust::graph::Result<StreamEvent>> + Send + 'a>> {
        Box::pin(futures::stream::empty())
    }
}

fn add_control_node(graph: StateGraph, node: &WorkflowNode) -> StateGraph {
    let id = node.id.clone();
    let kind = node.kind.clone();
    let data = node.data.clone();
    graph.add_node_fn(&id.clone(), move |_ctx| {
        let id = id.clone();
        let kind = kind.clone();
        let data = data.clone();
        async move {
            let event = json!({ "nodeId": id, "type": kind, "data": data });
            Ok(NodeOutput::new()
                .with_update("workflow.last_node", json!(id))
                .with_update("workflow.node", event.clone())
                .with_update("workflow.trace", event))
        }
    })
}

fn add_if_else_control_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let data = node.data.clone();
    let conditions = if_else_conditions(node)?;
    Ok(graph.add_node_fn(&id.clone(), move |context| {
        let id = id.clone();
        let data = data.clone();
        let route = if_else_route(&conditions, &context.state);
        let condition = data
            .pointer(&format!("/conditions/{route}/condition"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let label = data
            .pointer(&format!("/conditions/{route}/label"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let on_event = on_event.clone();
        async move {
            let event = json!({
                "nodeId": id,
                "type": "if_else",
                "data": data,
                "result": { "route": route, "label": label, "condition": condition },
            });
            if let Some(on_event) = on_event {
                let _ = on_event.send(StreamEvent::custom(&id, "workflow.node_result", event.clone()));
            }
            Ok(NodeOutput::new()
                .with_update("workflow.last_node", json!(id))
                .with_update("workflow.node", event.clone())
                .with_update("workflow.trace", event))
        }
    }))
}

fn add_switch_control_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let data = node.data.clone();
    let cases = switch_cases(node)?;
    Ok(graph.add_node_fn(&id.clone(), move |context| {
        let id = id.clone();
        let data = data.clone();
        let route = switch_route(&cases, &context.state);
        let branch = if route == "default" {
            data.get("defaultCase")
        } else {
            let case_id = route.strip_prefix("case:").expect("switch route is valid");
            data.get("cases").and_then(Value::as_array).and_then(|items| {
                items
                    .iter()
                    .find(|item| item.get("id").and_then(Value::as_str) == Some(case_id))
            })
        };
        let label = branch
            .and_then(|branch| branch.get("label"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let condition = branch
            .and_then(|branch| branch.get("condition"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        let on_event = on_event.clone();
        async move {
            let event = json!({
                "nodeId": id,
                "type": "switch",
                "data": data,
                "result": { "route": route, "label": label, "condition": condition },
            });
            if let Some(on_event) = on_event {
                let _ = on_event.send(StreamEvent::custom(&id, "workflow.node_result", event.clone()));
            }
            Ok(NodeOutput::new()
                .with_update("workflow.last_node", json!(id))
                .with_update("workflow.node", event.clone())
                .with_update("workflow.trace", event))
        }
    }))
}

async fn add_local_agent_node(
    graph: StateGraph,
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let description = string_data(node, "description").unwrap_or_default();
    let instruction = string_data(node, "instruction").unwrap_or_default();
    let profile_id =
        string_data(node, "modelProfileId").ok_or_else(|| anyhow!("agent node `{id}` needs data.modelProfileId"))?;
    let temperature = number_data(node, "temperature", 0.0, 2.0)?;
    let top_p = number_data(node, "topP", 0.0, 1.0)?;
    let tool_ids = string_array_data(node, "toolIds")?;
    let max_tool_calls = integer_data(node, "maxToolCalls", 8, 1, 50)?;
    let tool_timeout_seconds = integer_data(node, "toolTimeoutSeconds", 60, 1, 600)?;
    let tools = ToolRegistry::resolve(&tool_ids).await?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let mut agent = LlmAgentBuilder::new(id.clone())
        .description(description)
        .instruction(instruction)
        .model(create_model(&model, config)?);
    if let Some(temperature) = temperature {
        agent = agent.temperature(temperature);
    }
    if let Some(top_p) = top_p {
        agent = agent.top_p(top_p);
    }
    let tool_calls = Arc::new(AtomicU32::new(0));
    let tool_trace = Arc::new(Mutex::new(Vec::new()));
    for tool in tools {
        let executor = match tool.source {
            ToolSource::Process => ManagedToolExecutor::Process,
            ToolSource::Mcp => ManagedToolExecutor::Mcp(McpServerRegistry::resolve_tool(&tool.id).await?.1),
        };
        agent = agent.tool(Arc::new(ManagedTool::new(
            tool,
            executor,
            id.clone(),
            on_event.clone(),
            Arc::clone(&tool_calls),
            Arc::clone(&tool_trace),
            max_tool_calls,
            tool_timeout_seconds.into(),
        )));
    }
    let agent = agent.build()?;
    Ok(graph.add_node(StreamingAgentNode::new(
        AdkAgentNode::new(Arc::new(agent)).with_input_mapper(state_as_agent_input),
        id,
        "agent",
        label,
        on_event,
        Some(tool_trace),
    )))
}

enum ManagedToolExecutor {
    Process,
    Mcp(Arc<dyn Tool>),
}

struct ManagedTool {
    definition: ToolDefinition,
    executor: ManagedToolExecutor,
    agent_node_id: String,
    on_event: Option<Channel<StreamEvent>>,
    tool_calls: Arc<AtomicU32>,
    tool_trace: Arc<Mutex<Vec<Value>>>,
    max_tool_calls: u32,
    timeout_seconds: u64,
}

impl ManagedTool {
    fn new(
        definition: ToolDefinition,
        executor: ManagedToolExecutor,
        agent_node_id: String,
        on_event: Option<Channel<StreamEvent>>,
        tool_calls: Arc<AtomicU32>,
        tool_trace: Arc<Mutex<Vec<Value>>>,
        max_tool_calls: u32,
        timeout_seconds: u64,
    ) -> Self {
        Self {
            definition,
            executor,
            agent_node_id,
            on_event,
            tool_calls,
            tool_trace,
            max_tool_calls,
            timeout_seconds,
        }
    }
}

#[async_trait::async_trait]
impl Tool for ManagedTool {
    fn name(&self) -> &str {
        &self.definition.name
    }

    fn description(&self) -> &str {
        &self.definition.description
    }

    fn parameters_schema(&self) -> Option<Value> {
        Some(self.definition.input_schema.clone())
    }

    fn response_schema(&self) -> Option<Value> {
        Some(self.definition.output_schema.clone())
    }

    async fn execute(&self, context: Arc<dyn ToolContext>, args: Value) -> adk_rust::Result<Value> {
        if self.tool_calls.fetch_add(1, Ordering::Relaxed) >= self.max_tool_calls {
            return Err(adk_rust::AdkError::tool(format!(
                "Agent reached its {} tool-call limit",
                self.max_tool_calls
            )));
        }
        validate_tool_value(&self.definition.input_schema, &args, "input")?;
        if self.definition.execution_policy == ToolExecutionPolicy::AskEveryTime {
            let request_id = uuid::Uuid::now_v7().to_string();
            let (sender, receiver) = oneshot::channel();
            tool_approvals()
                .lock()
                .map_err(|_| adk_rust::AdkError::tool("Tool approval registry is unavailable"))?
                .insert(request_id.clone(), sender);
            if let Some(on_event) = &self.on_event {
                let _ = on_event.send(StreamEvent::custom(
                    &self.agent_node_id,
                    "agent.tool_approval_required",
                    json!({
                        "requestId": request_id,
                        "tool": self.name(),
                        "name": self.definition.display_name,
                        "description": self.definition.description,
                        "input": args,
                    }),
                ));
            }
            let approved = tokio::time::timeout(std::time::Duration::from_secs(300), receiver)
                .await
                .ok()
                .and_then(|value| value.ok())
                .unwrap_or(false);
            tool_approvals()
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request_id));
            if !approved {
                return Err(adk_rust::AdkError::tool("Tool denied by user"));
            }
        }
        if let Some(on_event) = &self.on_event {
            let _ = on_event.send(StreamEvent::custom(
                &self.agent_node_id,
                "agent.tool_call",
                json!({
                    "tool": self.name(),
                    "name": self.definition.display_name,
                    "input": args,
                }),
            ));
        }
        let timeout = std::time::Duration::from_secs(self.timeout_seconds);
        let result = match &self.executor {
            ManagedToolExecutor::Process => {
                let node_id = self.agent_node_id.clone();
                let name = self.definition.name.clone();
                let on_event = self.on_event.clone();
                tokio::time::timeout(
                    timeout,
                    ProcessNodeRegistry::run_for_tool(
                        &self.definition.id,
                        &args,
                        Arc::new(move |chunk| {
                            if let Some(on_event) = &on_event {
                                let _ = on_event.send(StreamEvent::custom(
                                    &node_id,
                                    "agent.tool_output",
                                    json!({ "tool": name, "stream": chunk.stream, "data": chunk.data }),
                                ));
                            }
                        }),
                    ),
                )
                .await
                .map_err(|_| tool_timeout_error(self.name(), self.timeout_seconds))?
                .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?
                .result
            },
            ManagedToolExecutor::Mcp(tool) => tokio::time::timeout(timeout, tool.execute(context, args.clone()))
                .await
                .map_err(|_| tool_timeout_error(self.name(), self.timeout_seconds))??,
        };
        validate_tool_value(&self.definition.output_schema, &result, "output")?;
        let trace = json!({
            "tool": self.name(),
            "name": self.definition.display_name,
            "input": args,
            "result": result,
        });
        if let Ok(mut tool_trace) = self.tool_trace.lock() {
            tool_trace.push(trace.clone());
        }
        if let Some(on_event) = &self.on_event {
            let _ = on_event.send(StreamEvent::custom(&self.agent_node_id, "agent.tool_result", trace));
        }
        Ok(result)
    }
}

fn tool_timeout_error(name: &str, timeout_seconds: u64) -> adk_rust::AdkError {
    adk_rust::AdkError::tool(format!("Tool `{name}` timed out after {timeout_seconds} seconds"))
}

fn create_model(model: &ModelDefinition, config: &IWorkrun) -> Result<Arc<dyn Llm>> {
    let credential = config.credential_for(&model.provider);
    let api_key = credential.and_then(|credential| credential.api_key.as_deref());
    if model.provider != ModelProvider::Ollama && api_key.is_none_or(|api_key| api_key.trim().is_empty()) {
        bail!("provider for model `{}` has no API key", model.id);
    }
    let api_key = api_key.unwrap_or_default();
    Ok(match model.provider {
        ModelProvider::Gemini => Arc::new(GeminiModel::new(api_key, &model.model)?),
        ModelProvider::OpenAi | ModelProvider::OpenAiStrict => {
            Arc::new(OpenAIClient::new(OpenAIConfig::new(api_key, &model.model))?)
        },
        ModelProvider::Anthropic => Arc::new(AnthropicClient::new(AnthropicConfig::new(api_key, &model.model))?),
        ModelProvider::DeepSeek => Arc::new(DeepSeekClient::new(DeepSeekConfig::new(api_key, &model.model))?),
        ModelProvider::Groq => {
            let config = match credential.and_then(|credential| credential.base_url.as_deref()) {
                Some(url) => GroqConfig::new(api_key, &model.model).with_base_url(url),
                None => GroqConfig::new(api_key, &model.model),
            };
            Arc::new(GroqClient::new(config)?)
        },
        ModelProvider::Ollama => Arc::new(OllamaModel::new(
            credential
                .and_then(|credential| credential.base_url.as_ref())
                .map(|url| OllamaConfig::with_host(url, &model.model))
                .unwrap_or_else(|| OllamaConfig::new(&model.model)),
        )?),
    })
}

fn remote_a2a_graph_node(node: &WorkflowNode, on_event: Option<Channel<StreamEvent>>) -> Result<StreamingAgentNode> {
    let url = string_data(node, "url")
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| anyhow!("remote_agent node `{}` needs data.url", node.id))?;
    let description = string_data(node, "description").unwrap_or_default();
    let remote = RemoteA2aAgent::builder(node.id.clone())
        .description(description)
        .agent_url(url.clone())
        .build()
        .map_err(|error| anyhow!("remote_agent node `{}` is invalid: {error}", node.id))?;
    let id = node.id.clone();
    Ok(StreamingAgentNode::new(
        AdkAgentNode::new(Arc::new(remote)).with_input_mapper(state_as_agent_input),
        id,
        "remote_agent",
        url,
        on_event,
        None,
    ))
}

/// `adk-graph` calls `execute_stream` to emit tokens, then calls `execute` a
/// second time to obtain state updates. Its built-in `AgentNode` starts a new
/// model request in both methods. Cache the events from the first request so
/// the second call can derive the state from exactly the text the user saw.
struct StreamingAgentNode {
    id: String,
    inner: AdkAgentNode,
    kind: String,
    endpoint_or_model: String,
    on_event: Option<Channel<StreamEvent>>,
    streamed_events: Mutex<HashMap<(String, usize), Vec<Value>>>,
    tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
}

impl StreamingAgentNode {
    fn new(
        inner: AdkAgentNode,
        id: String,
        kind: impl Into<String>,
        endpoint_or_model: impl Into<String>,
        on_event: Option<Channel<StreamEvent>>,
        tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
    ) -> Self {
        Self {
            id,
            inner,
            kind: kind.into(),
            endpoint_or_model: endpoint_or_model.into(),
            on_event,
            streamed_events: Mutex::new(HashMap::new()),
            tool_trace,
        }
    }

    fn cache_key(context: &NodeContext) -> (String, usize) {
        (context.config.thread_id.clone(), context.step)
    }

    fn store_streamed_events(&self, key: (String, usize), events: Vec<Value>) -> adk_rust::graph::Result<()> {
        let mut cache = self
            .streamed_events
            .lock()
            .map_err(|_| graph_node_error(&self.id, "agent event cache is unavailable"))?;
        cache.insert(key, events);
        Ok(())
    }
}

#[async_trait::async_trait]
impl Node for StreamingAgentNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let key = Self::cache_key(context);
        let events = self
            .streamed_events
            .lock()
            .map_err(|_| graph_node_error(&self.id, "agent event cache is unavailable"))?
            .remove(&key)
            .ok_or_else(|| graph_node_error(&self.id, "streamed agent events are unavailable"))?
            .into_iter()
            .map(|event| serde_json::from_value::<Event>(event).map_err(|error| graph_node_error(&self.id, error)))
            .collect::<adk_rust::graph::Result<Vec<_>>>()?;

        let tool_calls = self
            .tool_trace
            .as_ref()
            .and_then(|tool_trace| tool_trace.lock().ok().map(|tool_trace| tool_trace.clone()))
            .unwrap_or_default();
        Ok(NodeOutput::new().with_updates(agent_output_updates(
            &events,
            &self.id,
            &self.kind,
            &self.endpoint_or_model,
            self.on_event.as_ref(),
            &tool_calls,
        )))
    }

    fn execute_stream<'a>(
        &'a self,
        context: &'a NodeContext,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = adk_rust::graph::Result<StreamEvent>> + Send + 'a>> {
        let key = Self::cache_key(context);
        let stream = self.inner.execute_stream(context);
        let node = self;

        Box::pin(async_stream::stream! {
            futures::pin_mut!(stream);
            let mut events = Vec::new();

            while let Some(result) = stream.next().await {
                match result {
                    Ok(event) => {
                        if let StreamEvent::Custom { event_type, data, .. } = &event
                            && event_type == "agent_event"
                        {
                            events.push(data.clone());
                        }
                        yield Ok(event);
                    }
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
            }

            if let Err(error) = node.store_streamed_events(key, events) {
                yield Err(error);
            }
        })
    }
}

fn state_as_agent_input(state: &State) -> Content {
    // A2A carries text parts. JSON preserves the full shared workflow state,
    // while still allowing remote agents to treat it as a normal user message.
    let input = serde_json::to_string(state).unwrap_or_else(|_| "{}".to_string());
    Content::new("user").with_text(input)
}

fn agent_output_updates(
    events: &[adk_rust::Event],
    node_id: &str,
    kind: &str,
    endpoint_or_model: &str,
    on_event: Option<&Channel<StreamEvent>>,
    tool_calls: &[Value],
) -> HashMap<String, Value> {
    let messages = events
        .iter()
        .filter_map(|event| event.content())
        .map(|content| {
            content
                .parts
                .iter()
                .filter_map(|part| part.text())
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
        .map(|content| json!({ "role": "assistant", "content": content }))
        .collect::<Vec<_>>();
    let mut event = json!({
        "nodeId": node_id,
        "type": kind,
        "endpointOrModel": endpoint_or_model,
        "messages": messages,
    });
    if !tool_calls.is_empty() {
        event["toolCalls"] = Value::Array(tool_calls.to_vec());
    }
    if let Some(on_event) = on_event {
        let _ = on_event.send(StreamEvent::custom(node_id, "workflow.node_result", event.clone()));
    }
    let mut updates = HashMap::from([
        ("workflow.last_node".to_string(), json!(node_id)),
        ("workflow.node".to_string(), event.clone()),
        ("workflow.trace".to_string(), event),
    ]);
    if !messages.is_empty() {
        updates.insert("messages".to_string(), Value::Array(messages));
    }
    updates
}

fn graph_node_error(node: &str, error: impl std::fmt::Display) -> GraphError {
    GraphError::NodeExecutionFailed {
        node: node.to_string(),
        message: error.to_string(),
    }
}

fn string_data(node: &WorkflowNode, key: &str) -> Option<String> {
    node.data.get(key).and_then(Value::as_str).map(ToOwned::to_owned)
}

fn number_data(node: &WorkflowNode, key: &str, min: f32, max: f32) -> Result<Option<f32>> {
    let Some(value) = node.data.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let value = value
        .as_f64()
        .ok_or_else(|| anyhow!("agent node `{}` field `{key}` must be a number", node.id))?;
    if !value.is_finite() || value < min as f64 || value > max as f64 {
        bail!("agent node `{}` field `{key}` must be between {min} and {max}", node.id);
    }
    Ok(Some(value as f32))
}

fn string_array_data(node: &WorkflowNode, key: &str) -> Result<Vec<String>> {
    let Some(value) = node.data.get(key) else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| anyhow!("agent node `{}` field `{key}` must be an array", node.id))?;
    values
        .iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| !value.trim().is_empty())
                .map(ToOwned::to_owned)
                .ok_or_else(|| anyhow!("agent node `{}` field `{key}` must contain non-empty strings", node.id))
        })
        .collect()
}

fn integer_data(node: &WorkflowNode, key: &str, default: u32, min: u32, max: u32) -> Result<u32> {
    let Some(value) = node.data.get(key) else {
        return Ok(default);
    };
    let value = value
        .as_u64()
        .filter(|value| *value <= u32::MAX as u64)
        .map(|value| value as u32)
        .ok_or_else(|| anyhow!("agent node `{}` field `{key}` must be an integer", node.id))?;
    if value < min || value > max {
        bail!("agent node `{}` field `{key}` must be between {min} and {max}", node.id);
    }
    Ok(value)
}

fn validate_tool_value(schema: &Value, value: &Value, kind: &str) -> adk_rust::Result<()> {
    let validator = jsonschema::validator_for(schema)
        .map_err(|error| adk_rust::AdkError::tool(format!("Tool {kind} schema is invalid: {error}")))?;
    if let Some(error) = validator.iter_errors(value).next() {
        return Err(adk_rust::AdkError::tool(format!(
            "Tool {kind} does not match its schema: {error}"
        )));
    }
    Ok(())
}

fn validate_edges(
    edges: &[WorkflowEdge],
    nodes: &HashMap<&str, &WorkflowNode>,
    executable: &HashSet<String>,
    end_ids: &HashSet<String>,
    start_id: &str,
) -> Result<()> {
    let mut branch_handles = HashSet::new();
    for edge in edges {
        let source = nodes
            .get(edge.source.as_str())
            .ok_or_else(|| anyhow!("edge source `{}` does not exist", edge.source))?;
        let target = nodes
            .get(edge.target.as_str())
            .ok_or_else(|| anyhow!("edge target `{}` does not exist", edge.target))?;
        if target.kind == "start" || target.kind == "group" || source.kind == "end" || source.kind == "group" {
            bail!(
                "edge `{}` -> `{}` has an invalid workflow endpoint",
                edge.source,
                edge.target
            );
        }
        if source.id == start_id && !executable.contains(&edge.target) {
            bail!("start node must connect to an executable node, not `{}`", edge.target);
        }
        if source.kind == "if_else" {
            let handle = edge
                .source_handle
                .as_deref()
                .ok_or_else(|| anyhow!("if_else node `{}` requires a sourceHandle", source.id))?;
            if handle != "true" && handle != "false" {
                bail!("if_else node `{}` has invalid handle `{handle}`", source.id);
            }
            if !branch_handles.insert((source.id.clone(), handle.to_string())) {
                bail!("if_else node `{}` has multiple `{handle}` edges", source.id);
            }
        } else if source.kind == "switch" {
            let handle = edge
                .source_handle
                .as_deref()
                .ok_or_else(|| anyhow!("switch node `{}` requires a sourceHandle", source.id))?;
            let valid = handle == "default"
                || switch_cases(source)?
                    .iter()
                    .any(|case| handle == format!("case:{}", case.id));
            if !valid {
                bail!("switch node `{}` has invalid handle `{handle}`", source.id);
            }
            if !branch_handles.insert((source.id.clone(), handle.to_string())) {
                bail!("switch node `{}` has multiple `{handle}` edges", source.id);
            }
        } else if edge.source_handle.is_some() {
            bail!("node `{}` does not support sourceHandle routing", source.id);
        }
        if !executable.contains(&edge.target) && !end_ids.contains(&edge.target) {
            bail!("edge target `{}` cannot be executed", edge.target);
        }
    }
    Ok(())
}

fn add_if_else_edges(
    graph: &mut StateGraph,
    node: &WorkflowNode,
    outgoing: &[&WorkflowEdge],
    end_ids: &HashSet<String>,
    plan: &mut Vec<PlanEdge>,
) -> Result<()> {
    let targets = routes_from_edges(outgoing, end_ids, |edge| edge.source_handle.clone().unwrap())?;
    let true_target = targets.get("true").cloned().unwrap_or(EdgeTarget::End);
    let false_target = targets.get("false").cloned().unwrap_or(EdgeTarget::End);
    let conditions = if_else_conditions(node)?;
    let router: RouterFn = Arc::new(move |state: &State| if_else_route(&conditions, state));
    graph.edges.push(Edge::Conditional {
        source: node.id.clone(),
        router,
        targets,
    });
    plan.push(PlanEdge {
        source: node.id.clone(),
        target: display_target(true_target),
        route: Some("true".into()),
    });
    plan.push(PlanEdge {
        source: node.id.clone(),
        target: display_target(false_target),
        route: Some("false".into()),
    });
    Ok(())
}

fn add_switch_edges(
    graph: &mut StateGraph,
    node: &WorkflowNode,
    outgoing: &[&WorkflowEdge],
    end_ids: &HashSet<String>,
    plan: &mut Vec<PlanEdge>,
) -> Result<()> {
    let cases = switch_cases(node)?;
    let mut targets = HashMap::new();
    for edge in outgoing {
        let handle = edge.source_handle.as_deref().expect("validated source handle");
        let route = handle.to_string();
        let target = graph_target(&edge.target, end_ids);
        targets.insert(route.clone(), target.clone());
        plan.push(PlanEdge {
            source: node.id.clone(),
            target: display_target(target),
            route: Some(route),
        });
    }
    let router: RouterFn = Arc::new(move |state: &State| switch_route(&cases, state));
    graph.edges.push(Edge::Conditional {
        source: node.id.clone(),
        router,
        targets,
    });
    Ok(())
}

fn routes_from_edges<F>(
    edges: &[&WorkflowEdge],
    end_ids: &HashSet<String>,
    route: F,
) -> Result<HashMap<String, EdgeTarget>>
where
    F: Fn(&WorkflowEdge) -> String,
{
    let mut result = HashMap::new();
    for edge in edges {
        result.insert(route(edge), graph_target(&edge.target, end_ids));
    }
    Ok(result)
}

fn graph_target(id: &str, end_ids: &HashSet<String>) -> EdgeTarget {
    if end_ids.contains(id) {
        EdgeTarget::End
    } else {
        EdgeTarget::Node(id.to_string())
    }
}

fn display_target(target: EdgeTarget) -> String {
    target.node_name().unwrap_or(END).to_string()
}

struct IfElseConditions {
    true_condition: Condition,
    false_condition: Condition,
}

fn if_else_route(conditions: &IfElseConditions, state: &State) -> String {
    if conditions.true_condition.matches(state) {
        "true".into()
    } else if conditions.false_condition.matches(state) {
        "false".into()
    } else {
        END.into()
    }
}

#[derive(Clone)]
struct Condition {
    field: String,
    operator: Option<ConditionOperator>,
    expected: Option<Value>,
}

#[derive(Clone, Copy)]
enum ConditionOperator {
    Equal,
    NotEqual,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
}

impl Condition {
    fn matches(&self, state: &State) -> bool {
        let value = state_value(state, &self.field);
        let Some(operator) = self.operator else {
            return value.is_some_and(is_truthy);
        };
        let Some(expected) = self.expected.as_ref() else {
            return false;
        };
        let Some(value) = value else {
            return false;
        };

        match operator {
            ConditionOperator::Equal => value == expected,
            ConditionOperator::NotEqual => value != expected,
            ConditionOperator::GreaterThan => compare_values(value, expected).is_some_and(|order| order.is_gt()),
            ConditionOperator::GreaterThanOrEqual => compare_values(value, expected).is_some_and(|order| order.is_ge()),
            ConditionOperator::LessThan => compare_values(value, expected).is_some_and(|order| order.is_lt()),
            ConditionOperator::LessThanOrEqual => compare_values(value, expected).is_some_and(|order| order.is_le()),
        }
    }
}

fn if_else_conditions(node: &WorkflowNode) -> Result<IfElseConditions> {
    let conditions = node
        .data
        .get("conditions")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("if_else node `{}` has invalid data.conditions", node.id))?;
    let get_condition = |branch: &str| {
        conditions
            .get(branch)
            .ok_or_else(|| anyhow!("if_else node `{}` needs data.conditions.{branch}", node.id))
            .and_then(|condition| {
                condition
                    .get("condition")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("if_else node `{}` needs data.conditions.{branch}.condition", node.id))
            })
            .and_then(parse_condition)
    };
    Ok(IfElseConditions {
        true_condition: get_condition("true")?,
        false_condition: get_condition("false")?,
    })
}

fn parse_condition(expression: &str) -> Result<Condition> {
    let expression = expression.trim();
    if expression.is_empty() {
        bail!("condition cannot be empty");
    }
    for (token, operator) in [
        ("==", ConditionOperator::Equal),
        ("!=", ConditionOperator::NotEqual),
        (">=", ConditionOperator::GreaterThanOrEqual),
        ("<=", ConditionOperator::LessThanOrEqual),
        (">", ConditionOperator::GreaterThan),
        ("<", ConditionOperator::LessThan),
    ] {
        if let Some((field, expected)) = expression.split_once(token) {
            let field = parse_condition_field(field)?;
            let expected = expected.trim();
            if expected.is_empty() {
                bail!("condition `{expression}` needs a value after `{token}`");
            }
            let expected = expected
                .strip_prefix('\'')
                .and_then(|value| value.strip_suffix('\''))
                .map(|value| Value::String(value.to_string()))
                .unwrap_or_else(|| {
                    serde_json::from_str(expected).unwrap_or_else(|_| Value::String(expected.to_string()))
                });
            return Ok(Condition {
                field,
                operator: Some(operator),
                expected: Some(expected),
            });
        }
    }
    Ok(Condition {
        field: parse_condition_field(expression)?,
        operator: None,
        expected: None,
    })
}

fn parse_condition_field(field: &str) -> Result<String> {
    let field = field.trim();
    if field.is_empty()
        || !field.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_')
        })
    {
        bail!("condition `{field}` needs a state field such as `approved` or `review.score`");
    }
    Ok(field.to_string())
}

fn state_value<'a>(state: &'a State, field: &str) -> Option<&'a Value> {
    let mut value = state.get(field.split('.').next()?)?;
    for segment in field.split('.').skip(1) {
        value = value.get(segment)?;
    }
    Some(value)
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Null => false,
        Value::Array(value) => !value.is_empty(),
        Value::Object(value) => !value.is_empty(),
    }
}

fn compare_values(left: &Value, right: &Value) -> Option<std::cmp::Ordering> {
    match (left, right) {
        (Value::Number(left), Value::Number(right)) => left.as_f64()?.partial_cmp(&right.as_f64()?),
        (Value::String(left), Value::String(right)) => Some(left.cmp(right)),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct SwitchCaseInput {
    id: String,
    condition: Option<String>,
    value: Option<String>,
}

struct SwitchCase {
    id: String,
    condition: Condition,
}

fn switch_cases(node: &WorkflowNode) -> Result<Vec<SwitchCase>> {
    let cases: Vec<SwitchCaseInput> =
        serde_json::from_value(node.data.get("cases").cloned().unwrap_or_else(|| json!([])))
            .map_err(|_| anyhow!("switch node `{}` has invalid data.cases", node.id))?;
    let mut ids = HashSet::new();
    for case in &cases {
        if case.id.is_empty() || !ids.insert(&case.id) {
            bail!("switch node `{}` has duplicate or empty case ids", node.id);
        }
    }
    let legacy_selector = node
        .data
        .pointer("/selector/field")
        .and_then(Value::as_str)
        .filter(|field| !field.trim().is_empty());
    cases
        .into_iter()
        .map(|case| {
            let expression = match case.condition {
                Some(condition) => condition,
                None => {
                    let field = legacy_selector
                        .ok_or_else(|| anyhow!("switch node `{}` needs data.cases[].condition", node.id))?;
                    let value = case
                        .value
                        .ok_or_else(|| anyhow!("switch node `{}` needs data.cases[].condition", node.id))?;
                    format!("{field} == {}", json!(value))
                },
            };
            parse_condition(&expression).map(|condition| SwitchCase { id: case.id, condition })
        })
        .collect()
}

fn switch_route(cases: &[SwitchCase], state: &State) -> String {
    cases
        .iter()
        .find(|case| case.condition.matches(state))
        .map(|case| format!("case:{}", case.id))
        .unwrap_or_else(|| "default".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{thread, time::Duration};

    #[test]
    fn measures_node_duration_from_stream_events() {
        let mut node_started_at = HashMap::new();
        let started = with_measured_node_duration(StreamEvent::node_start("node", 0), &mut node_started_at);
        assert!(matches!(started, StreamEvent::NodeStart { .. }));

        thread::sleep(Duration::from_millis(2));

        let ended = with_measured_node_duration(StreamEvent::node_end("node", 0, 0), &mut node_started_at);
        assert!(matches!(
            ended,
            StreamEvent::NodeEnd { duration_ms, .. } if duration_ms >= 1
        ));
    }

    #[tokio::test]
    async fn compiles_and_runs_an_if_else_branch() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "id": "approval", "nodes": [
                {"id":"start","type":"start"}, {"id":"check","type":"if_else","data":{"conditions":{"true":{"label":"True","condition":"approved == true"},"false":{"label":"False","condition":"approved == false"}}}},
                {"id":"end","type":"end"}
            ], "edges": [
                {"source":"start","target":"check"}, {"source":"check","target":"end","sourceHandle":"true"},
                {"source":"check","target":"end","sourceHandle":"false"}
            ]
        }))
        .unwrap();
        let mut input = State::new();
        input.insert("approved".into(), json!(true));
        let mut events = Vec::new();
        let result = compile(dsl, &Default::default(), None)
            .await
            .unwrap()
            .run_stream(input, "test", |event| events.push(event))
            .await
            .unwrap();
        assert_eq!(result.state["workflow.last_node"], json!("check"));
        assert_eq!(result.state["workflow.trace"][0]["result"]["route"], json!("true"));
        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::NodeStart { node, .. } if node == "check"
        )));
        assert!(matches!(events.last(), Some(StreamEvent::Done { .. })));
    }

    #[test]
    fn evaluates_independent_if_else_conditions() {
        let conditions = if_else_conditions(&WorkflowNode {
            id: "check".into(),
            kind: "if_else".into(),
            data: json!({
                "conditions": {
                    "true": {"label": "Pass", "condition": "review.score >= 80"},
                    "false": {"label": "Fail", "condition": "review.score < 80"}
                }
            }),
        })
        .unwrap();
        let state = State::from_iter([("review".into(), json!({"score": 80}))]);

        assert!(conditions.true_condition.matches(&state));
        assert!(!conditions.false_condition.matches(&state));
    }

    #[test]
    fn evaluates_switch_cases_in_order_then_uses_default() {
        let cases = switch_cases(&WorkflowNode {
            id: "route".into(),
            kind: "switch".into(),
            data: json!({
                "cases": [
                    {"id": "high", "label": "High", "condition": "score >= 80"},
                    {"id": "passing", "label": "Passing", "condition": "score >= 60"}
                ]
            }),
        })
        .unwrap();

        assert_eq!(
            switch_route(&cases, &State::from_iter([("score".into(), json!(90))])),
            "case:high",
        );
        assert_eq!(
            switch_route(&cases, &State::from_iter([("score".into(), json!(70))])),
            "case:passing",
        );
        assert_eq!(
            switch_route(&cases, &State::from_iter([("score".into(), json!(50))])),
            "default",
        );
    }

    #[test]
    fn parses_single_quoted_string_condition_values() {
        let condition = parse_condition("profile.gender == 'male'").unwrap();
        let state = State::from_iter([("profile".into(), json!({"gender": "male"}))]);

        assert!(condition.matches(&state));
    }

    #[test]
    fn validates_agent_generation_parameters() {
        let node = WorkflowNode {
            id: "agent".into(),
            kind: "agent".into(),
            data: json!({"temperature": 0.7, "topP": 0.9}),
        };

        assert_eq!(number_data(&node, "temperature", 0.0, 2.0).unwrap(), Some(0.7));
        assert_eq!(number_data(&node, "topP", 0.0, 1.0).unwrap(), Some(0.9));

        let invalid = WorkflowNode {
            data: json!({"topP": 1.1}),
            ..node
        };
        assert!(number_data(&invalid, "topP", 0.0, 1.0).is_err());
    }

    #[test]
    fn validates_tool_arguments_against_json_schema() {
        let schema = json!({
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": false,
        });

        assert!(validate_tool_value(&schema, &json!({"query": "weather"}), "input").is_ok());
        assert!(validate_tool_value(&schema, &json!({"query": 1}), "input").is_err());
    }

    #[tokio::test]
    async fn resolves_one_time_tool_approval() {
        let request_id = uuid::Uuid::now_v7().to_string();
        let (sender, receiver) = oneshot::channel();
        tool_approvals().lock().unwrap().insert(request_id.clone(), sender);

        resolve_tool_approval(&request_id, true).await.unwrap();

        assert!(receiver.await.unwrap());
        assert!(resolve_tool_approval(&request_id, false).await.is_err());
    }

    #[test]
    fn records_tool_calls_in_the_agent_trace() {
        let tool_calls = vec![json!({
            "tool": "uppercase",
            "name": "Uppercase text",
            "input": {"text": "hello"},
            "result": {"uppercase": "HELLO"},
        })];

        let updates = agent_output_updates(&[], "agent", "agent", "model", None, &tool_calls);

        assert_eq!(
            updates["workflow.trace"]["toolCalls"],
            json!([{
                "tool": "uppercase",
                "name": "Uppercase text",
                "input": {"text": "hello"},
                "result": {"uppercase": "HELLO"},
            }]),
        );
    }

    #[tokio::test]
    async fn records_the_matched_switch_case_in_the_workflow_trace() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "id": "routing", "nodes": [
                {"id": "start", "type": "start"},
                {"id": "route", "type": "switch", "data": {
                    "cases": [{"id": "adult", "label": "Adult", "condition": "age >= 18"}],
                    "defaultCase": {"label": "Minor", "condition": ""}
                }},
                {"id": "end", "type": "end"}
            ], "edges": [
                {"source": "start", "target": "route"},
                {"source": "route", "target": "end", "sourceHandle": "case:adult"},
                {"source": "route", "target": "end", "sourceHandle": "default"}
            ]
        }))
        .unwrap();
        let state = State::from_iter([("age".into(), json!(20))]);
        let result = compile(dsl, &Default::default(), None)
            .await
            .unwrap()
            .run_stream(state, "test", |_| {})
            .await
            .unwrap();

        assert_eq!(result.state["workflow.trace"][0]["type"], json!("switch"));
        assert_eq!(
            result.state["workflow.trace"][0]["result"]["route"],
            json!("case:adult")
        );
        assert_eq!(result.state["workflow.trace"][0]["result"]["label"], json!("Adult"));
        assert_eq!(
            result.state["workflow.trace"][0]["result"]["condition"],
            json!("age >= 18"),
        );
    }

    #[tokio::test]
    async fn compiles_remote_a2a_agent_as_a_graph_node() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "nodes": [
                {"id":"start","type":"start"},
                {"id":"remote","type":"remote_agent","data":{"url":"http://localhost:8080","description":"Remote worker"}},
                {"id":"end","type":"end"}
            ],
            "edges": [
                {"source":"start","target":"remote"},
                {"source":"remote","target":"end"}
            ]
        }))
        .unwrap();
        let compiled = compile(dsl, &Default::default(), None).await.unwrap();
        assert_eq!(compiled.plan().executable_nodes, vec!["remote"]);
    }
}
