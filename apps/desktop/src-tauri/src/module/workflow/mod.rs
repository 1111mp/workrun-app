//! React Flow DSL -> adk-rust graph compiler.
//!
//! Layout properties emitted by React Flow are deliberately not part of the
//! runtime model.  The only execution data is a node's `id`, `type`, `data`,
//! and the edge endpoint/handle information.

mod agent;
mod ask_user_question;
mod codeact_agent;
mod human_review;
mod process;
mod routing;
mod tool;
mod tool_approval;

use agent::*;
use ask_user_question::*;
use codeact_agent::*;
use human_review::*;
use process::*;
use routing::*;
use tool::*;
use tool_approval::*;

use crate::{
    config::{IWorkrun, ModelDefinition, ModelProvider, model_catalog},
    core::db::DBManager,
    module::{
        mcp_server::McpServerRegistry,
        process_node::{ProcessNodeRegistry, ToolExecutionPolicy},
        tool_registry::{ToolDefinition, ToolRegistry, ToolSource},
    },
};
use adk_rust::{
    graph::{
        AgentNode as AdkAgentNode, Checkpointer, END, Edge, EdgeTarget, ExecutionConfig, GraphError, Node, NodeContext,
        NodeOutput, START, SqliteCheckpointer, State, StateGraph, StreamEvent, StreamMode,
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
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::Instant,
};
use tauri::ipc::Channel;

type RouterFn = Arc<dyn Fn(&State) -> String + Send + Sync>;

pub async fn resolve_tool_approval(request_id: &str, fingerprint: &str, approved: bool) -> Result<()> {
    ToolApprovalRegistry::global().resolve(request_id, fingerprint, approved)
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
    pub interrupted: bool,
}

pub struct CompiledWorkflow {
    graph: adk_rust::graph::CompiledGraph,
    plan: WorkflowPlan,
    checkpoint_db_url: String,
}

impl CompiledWorkflow {
    /// Execute the graph while forwarding ordered node and model events to the
    /// caller. The final `Done` stream event is retained as the command result.
    pub async fn run_stream<F>(
        self,
        initial_state: State,
        thread_id: &str,
        _resume: bool,
        mut on_event: F,
    ) -> Result<WorkflowRunResult>
    where
        F: FnMut(StreamEvent),
    {
        let checkpointer = SqliteCheckpointer::new(&self.checkpoint_db_url).await?;
        let has_checkpoint = checkpointer.load(thread_id).await?.is_some();
        let initial_state = if has_checkpoint { State::new() } else { initial_state };

        let stream = self
            .graph
            .stream(initial_state, ExecutionConfig::new(thread_id), StreamMode::Messages);

        tokio::pin!(stream);

        let mut final_state = None;
        let mut interrupted = false;
        let mut node_started_at = HashMap::new();

        while let Some(event) = stream.next().await {
            let event = event?;
            if let StreamEvent::Done { state, .. } = &event {
                final_state = Some(state.clone());
            }
            if matches!(event, StreamEvent::Interrupted { .. }) {
                interrupted = true;
            }
            on_event(with_measured_node_duration(event, &mut node_started_at));
        }

        let state = match final_state {
            Some(state) => state,
            None if interrupted => self
                .graph
                .get_state(thread_id)
                .await?
                .ok_or_else(|| anyhow!("interrupted workflow checkpoint is unavailable"))?,
            None => bail!("workflow stream ended without a final state"),
        };
        Ok(WorkflowRunResult {
            plan: self.plan,
            state,
            interrupted,
        })
    }

    pub fn plan(&self) -> &WorkflowPlan {
        &self.plan
    }

    pub async fn update_state(
        &self,
        thread_id: &str,
        updates: impl IntoIterator<Item = (String, Value)>,
    ) -> Result<()> {
        self.graph.update_state(thread_id, updates).await.map_err(Into::into)
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
            "start"
                | "end"
                | "agent"
                | "remote_agent"
                | "process"
                | "if_else"
                | "switch"
                | "human_review"
                | "ask_user_question"
                | "group"
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

    for node in dsl.nodes.iter().filter(|node| node.kind == "human_review") {
        let approval_key = human_review_config(node)?.approval_key;
        graph
            .schema
            .channels
            .entry(approval_key.clone())
            .or_insert_with(|| adk_rust::graph::Channel::new(&approval_key));
    }

    for node in dsl.nodes.iter().filter(|node| node.kind == "ask_user_question") {
        let answer_key = ask_user_question_config(node)?.answer_key;
        graph
            .schema
            .channels
            .entry(answer_key.clone())
            .or_insert_with(|| adk_rust::graph::Channel::new(&answer_key));
    }

    for node in &executable {
        graph = match node.kind.as_str() {
            // A2A is a first-class ADK Agent. Wrapping it in AgentNode makes
            // the remote call a real graph execution step, not a side effect
            // performed by the Tauri command.
            "remote_agent" => graph.add_node(remote_a2a_graph_node(node, on_event.clone())?),
            "process" => add_process_node(graph, node, on_event.clone()),
            "human_review" => add_human_review_node(graph, node, on_event.clone())?,
            "ask_user_question" => add_ask_user_question_node(graph, node, on_event.clone())?,
            "if_else" => add_if_else_control_node(graph, node, on_event.clone())?,
            "switch" => add_switch_control_node(graph, node, on_event.clone())?,
            // Build the LLM only at execution time. This keeps `compile` pure
            // and lets users open/validate workflows before configuring keys.
            "agent" => add_local_agent_node(graph, node, config, on_event.clone()).await?,
            "codeact_agent" => add_codeact_agent_node(graph, node, config, on_event.clone()).await?,
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
            "human_review" => add_human_review_edges(&mut graph, node, &outgoing, &end_ids, &mut plan_edges)?,
            "ask_user_question" => add_ask_user_question_edges(&mut graph, node, &outgoing, &end_ids, &mut plan_edges)?,
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
    let db_url = DBManager::db_url().await?;
    let checkpointer = SqliteCheckpointer::new(&db_url).await?;
    let graph = graph.compile()?.with_checkpointer(checkpointer);

    Ok(CompiledWorkflow {
        graph,
        plan,
        checkpoint_db_url: db_url,
    })
}

fn is_executable(node: &WorkflowNode) -> bool {
    matches!(
        node.kind.as_str(),
        "agent"
            | "codeact_agent"
            | "remote_agent"
            | "process"
            | "if_else"
            | "switch"
            | "human_review"
            | "ask_user_question"
    )
}

/// Return the one state key a review node is authorized to update when a
/// person makes their decision. This deliberately keeps arbitrary state
/// mutation out of the webview IPC boundary.
pub fn human_review_approval_key(dsl: &WorkflowDsl, node_id: &str) -> Result<String> {
    let node = dsl
        .nodes
        .iter()
        .find(|node| node.id == node_id && node.kind == "human_review")
        .ok_or_else(|| anyhow!("human review node `{node_id}` does not exist"))?;
    Ok(review_approval_key(&node.id))
}

/// Return the one state key an Ask User Question node is allowed to update.
/// This keeps arbitrary state mutation out of the webview IPC boundary.
pub fn ask_user_question_answer_key(dsl: &WorkflowDsl, node_id: &str) -> Result<String> {
    let node = dsl
        .nodes
        .iter()
        .find(|node| node.id == node_id && node.kind == "ask_user_question")
        .ok_or_else(|| anyhow!("ask user question node `{node_id}` does not exist"))?;
    Ok(ask_user_question_config(node)?.answer_key)
}

/// Validate that an answer is one of the options configured by its node.
pub fn ask_user_question_option_id(dsl: &WorkflowDsl, node_id: &str, option_id: &str) -> Result<String> {
    let node = dsl
        .nodes
        .iter()
        .find(|node| node.id == node_id && node.kind == "ask_user_question")
        .ok_or_else(|| anyhow!("ask user question node `{node_id}` does not exist"))?;
    let config = ask_user_question_config(node)?;
    if !config.options.iter().any(|option| option.id == option_id) {
        bail!("ask user question node `{node_id}` does not have option `{option_id}`");
    }
    Ok(option_id.to_string())
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
            .run_stream(input, "test", false, |event| events.push(event))
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

    #[tokio::test]
    async fn executes_process_nodes_when_streaming_workflow_messages() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "nodes": [
                {"id":"start","type":"start"},
                {"id":"process","type":"process","data":{}},
                {"id":"end","type":"end"}
            ],
            "edges": [
                {"source":"start","target":"process"},
                {"source":"process","target":"end"}
            ]
        }))
        .unwrap();

        let error = compile(dsl, &Default::default(), None)
            .await
            .unwrap()
            .run_stream(State::new(), "test", false, |_| {})
            .await
            .unwrap_err();

        assert!(error.to_string().contains("process node needs data.processNodeId"));
    }

    #[tokio::test]
    async fn runs_a_fan_in_node_once_after_both_branches_arrive() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "nodes": [
                {"id":"start","type":"start"},
                {"id":"left","type":"if_else","data":{"conditions":{"true":{"label":"Continue","condition":"approved == true"},"false":{"label":"Stop","condition":"approved == false"}}}},
                {"id":"right","type":"if_else","data":{"conditions":{"true":{"label":"Continue","condition":"approved == true"},"false":{"label":"Stop","condition":"approved == false"}}}},
                {"id":"join","type":"if_else","data":{"conditions":{"true":{"label":"Complete","condition":"approved == true"},"false":{"label":"Stop","condition":"approved == false"}}}},
                {"id":"end","type":"end"}
            ],
            "edges": [
                {"source":"start","target":"left"}, {"source":"start","target":"right"},
                {"source":"left","target":"join","sourceHandle":"true"},
                {"source":"right","target":"join","sourceHandle":"true"},
                {"source":"join","target":"end","sourceHandle":"true"}
            ]
        }))
        .unwrap();
        let state = State::from_iter([("approved".into(), json!(true))]);
        let result = compile(dsl, &Default::default(), None)
            .await
            .unwrap()
            .run_stream(state, "test", false, |_| {})
            .await
            .unwrap();

        assert_eq!(
            result.state["workflow.trace"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["nodeId"] == "join")
                .count(),
            1
        );
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
        let fingerprint = "tool\u{1f}{\"value\":true}";
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let approval_request_id = request_id.clone();
        let approval = tokio::spawn(async move {
            ToolApprovalRegistry::global()
                .request_approval(approval_request_id, fingerprint.into(), || {
                    let _ = started_sender.send(());
                })
                .await
        });
        started_receiver.await.unwrap();

        assert!(resolve_tool_approval(&request_id, "mismatch", true).await.is_err());
        resolve_tool_approval(&request_id, fingerprint, true).await.unwrap();

        assert!(approval.await.unwrap().unwrap());
        assert!(resolve_tool_approval(&request_id, fingerprint, false).await.is_err());
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
            .run_stream(state, "test", false, |_| {})
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

    #[test]
    fn recognizes_codeact_agents_as_executable_nodes() {
        assert!(is_executable(&WorkflowNode {
            id: "codeact".into(),
            kind: "codeact_agent".into(),
            data: Value::Null,
        }));
    }
}
