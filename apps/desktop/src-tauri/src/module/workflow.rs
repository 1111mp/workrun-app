//! React Flow DSL -> adk-rust graph compiler.
//!
//! Layout properties emitted by React Flow are deliberately not part of the
//! runtime model.  The only execution data is a node's `id`, `type`, `data`,
//! and the edge endpoint/handle information.

use crate::config::{IWorkrun, ModelDefinition, ModelProvider, model_catalog};
use adk_rust::{
    graph::{
        AgentNode as AdkAgentNode, END, Edge, EdgeTarget, ExecutionConfig, GraphError, Node as AdkGraphNode,
        NodeOutput, START, State, StateGraph,
    },
    model::{
        GeminiModel,
        anthropic::{AnthropicClient, AnthropicConfig},
        deepseek::{DeepSeekClient, DeepSeekConfig},
        groq::{GroqClient, GroqConfig},
        ollama::{OllamaConfig, OllamaModel},
        openai::{OpenAIClient, OpenAIConfig},
    },
    prelude::{Content, Llm, LlmAgentBuilder},
    server::RemoteA2aAgent,
};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

type RouterFn = Arc<dyn Fn(&State) -> String + Send + Sync>;

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
    pub async fn run(self, initial_state: State, thread_id: &str) -> Result<WorkflowRunResult> {
        let state = self
            .graph
            .invoke(initial_state, ExecutionConfig::new(thread_id))
            .await?;
        Ok(WorkflowRunResult { plan: self.plan, state })
    }

    pub fn plan(&self) -> &WorkflowPlan {
        &self.plan
    }
}

/// Compile a React Flow document into an executable ADK `StateGraph`.
pub fn compile(dsl: WorkflowDsl, config: &IWorkrun) -> Result<CompiledWorkflow> {
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
            "start" | "end" | "agent" | "remote_agent" | "if_else" | "switch" | "group"
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
            "remote_agent" => graph.add_node(remote_a2a_graph_node(node)?),
            // Build the LLM only at execution time. This keeps `compile` pure
            // and lets users open/validate workflows before configuring keys.
            "agent" => add_local_agent_node(graph, node, config)?,
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
    matches!(node.kind.as_str(), "agent" | "remote_agent" | "if_else" | "switch")
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

fn add_local_agent_node(graph: StateGraph, node: &WorkflowNode, config: &IWorkrun) -> Result<StateGraph> {
    let id = node.id.clone();
    let description = string_data(node, "description").unwrap_or_default();
    let instruction = string_data(node, "instruction").unwrap_or_default();
    let profile_id =
        string_data(node, "modelProfileId").ok_or_else(|| anyhow!("agent node `{id}` needs data.modelProfileId"))?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let agent = LlmAgentBuilder::new(id.clone())
        .description(description)
        .instruction(instruction)
        .model(create_model(&model, config)?)
        .build()?;
    Ok(graph.add_node(
        AdkAgentNode::new(Arc::new(agent))
            .with_input_mapper(state_as_agent_input)
            .with_output_mapper(move |events| agent_output_updates(events, &id, "agent", &label)),
    ))
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

fn remote_a2a_graph_node(node: &WorkflowNode) -> Result<AdkAgentNode> {
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
    Ok(AdkAgentNode::new(Arc::new(remote))
        .with_input_mapper(state_as_agent_input)
        .with_output_mapper(move |events| agent_output_updates(events, &id, "remote_agent", &url)))
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
    let event = json!({
        "nodeId": node_id,
        "type": kind,
        "endpointOrModel": endpoint_or_model,
        "messages": messages,
    });
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
    let field = selector_field(node)?;
    let targets = routes_from_edges(outgoing, end_ids, |edge| edge.source_handle.clone().unwrap())?;
    let true_target = targets.get("true").cloned().unwrap_or(EdgeTarget::End);
    let false_target = targets.get("false").cloned().unwrap_or(EdgeTarget::End);
    let router: RouterFn = Arc::new(move |state: &State| {
        if state.get(&field).and_then(Value::as_bool).unwrap_or(false) {
            "true".into()
        } else {
            "false".into()
        }
    });
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
    let field = selector_field(node)?;
    let cases = switch_cases(node)?;
    let mut targets = HashMap::new();
    for edge in outgoing {
        let handle = edge.source_handle.as_deref().expect("validated source handle");
        let route = if handle == "default" {
            "default".to_string()
        } else {
            let id = handle.strip_prefix("case:").expect("validated case handle");
            cases
                .iter()
                .find(|case| case.id == id)
                .expect("validated case")
                .value
                .clone()
        };
        let target = graph_target(&edge.target, end_ids);
        targets.insert(route.clone(), target.clone());
        plan.push(PlanEdge {
            source: node.id.clone(),
            target: display_target(target),
            route: Some(route),
        });
    }
    let known = targets
        .keys()
        .filter(|key| key.as_str() != "default")
        .cloned()
        .collect::<HashSet<_>>();
    let router: RouterFn = Arc::new(move |state: &State| {
        let value = state.get(&field).and_then(Value::as_str).unwrap_or_default();
        if known.contains(value) {
            value.to_string()
        } else {
            "default".to_string()
        }
    });
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

fn selector_field(node: &WorkflowNode) -> Result<String> {
    node.data
        .pointer("/selector/field")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("{} node `{}` needs data.selector.field", node.kind, node.id))
}

#[derive(Debug, Deserialize)]
struct SwitchCase {
    id: String,
    value: String,
}

fn switch_cases(node: &WorkflowNode) -> Result<Vec<SwitchCase>> {
    let cases: Vec<SwitchCase> = serde_json::from_value(node.data.get("cases").cloned().unwrap_or_else(|| json!([])))
        .map_err(|_| anyhow!("switch node `{}` has invalid data.cases", node.id))?;
    let mut ids = HashSet::new();
    let mut values = HashSet::new();
    for case in &cases {
        if case.id.is_empty() || case.value.is_empty() || !ids.insert(&case.id) || !values.insert(&case.value) {
            bail!("switch node `{}` has duplicate or empty case ids/values", node.id);
        }
    }
    Ok(cases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compiles_and_runs_a_boolean_branch() {
        let dsl: WorkflowDsl = serde_json::from_value(json!({
            "id": "approval", "nodes": [
                {"id":"start","type":"start"}, {"id":"check","type":"if_else","data":{"selector":{"field":"approved"}}},
                {"id":"end","type":"end"}
            ], "edges": [
                {"source":"start","target":"check"}, {"source":"check","target":"end","sourceHandle":"true"},
                {"source":"check","target":"end","sourceHandle":"false"}
            ]
        }))
        .unwrap();
        let mut input = State::new();
        input.insert("approved".into(), json!(true));
        let result = compile(dsl, &Default::default())
            .unwrap()
            .run(input, "test")
            .await
            .unwrap();
        assert_eq!(result.state["workflow.last_node"], json!("check"));
    }

    #[test]
    fn compiles_remote_a2a_agent_as_a_graph_node() {
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
        let compiled = compile(dsl, &Default::default()).unwrap();
        assert_eq!(compiled.plan().executable_nodes, vec!["remote"]);
    }
}
