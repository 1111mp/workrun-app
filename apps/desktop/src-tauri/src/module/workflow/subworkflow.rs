use super::*;
use crate::module::{state::NodeStateUpdate, workflow_catalog::WorkflowCatalogStore};

pub(super) fn add_subworkflow_node(
    graph: StateGraph,
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
    workflow_path: Vec<String>,
) -> Result<StateGraph> {
    let workflow_id = string_data(node, "workflowId")
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| anyhow!("Select a saved workflow in the subworkflow node settings"))?;
    Ok(graph.add_node(SubworkflowNode {
        id: node.id.clone(),
        workflow_id,
        config: config.clone(),
        on_event,
        state,
        global_keys: state_config.global_keys,
        sensitive_fields: state_config.sensitive_fields,
        workflow_path,
    }))
}

struct SubworkflowNode {
    id: String,
    workflow_id: String,
    config: IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
    sensitive_fields: BTreeSet<String>,
    workflow_path: Vec<String>,
}

#[async_trait::async_trait]
impl Node for SubworkflowNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let resume_key = format!("workflow.subworkflow.{}.resume", self.id);
        let resume = context.get(&resume_key).and_then(Value::as_bool).unwrap_or(false);
        let input = if resume {
            adk_rust::graph::State::new()
        } else {
            let input = self
                .state
                .lock()
                .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
                .node_input(&self.id)
                .map_err(|error| graph_node_error(&self.id, error))?;
            serde_json::from_value(input).map_err(|error| graph_node_error(&self.id, error))?
        };
        let mut dsl = workflow_dsl(&self.workflow_id)
            .await
            .map_err(|error| graph_node_error(&self.id, error))?;
        validate_workflow_path(&self.workflow_path, &dsl.id).map_err(|error| graph_node_error(&self.id, error))?;
        let thread_id = format!("{}/{}", context.config.thread_id, self.id);
        inject_workflow_context(&mut dsl, &thread_id, &self.id);
        let output_keys = dsl
            .output_schema
            .fields
            .iter()
            .map(|field| field.key.clone())
            .collect::<Vec<_>>();
        let workflow_name = dsl.name.clone();
        let node_names = dsl
            .nodes
            .iter()
            .map(|node| {
                let name = string_data(node, "workflowName")
                    .or_else(|| string_data(node, "name"))
                    .or_else(|| string_data(node, "label"))
                    .or_else(|| string_data(node, "title"))
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "Workflow step".to_string());
                (node.id.clone(), name)
            })
            .collect::<HashMap<_, _>>();
        let mut child_path = self.workflow_path.clone();
        child_path.push(dsl.id.clone());
        let child = compile_with_path(dsl, &self.config, self.on_event.clone(), child_path)
            .await
            .map_err(|error| graph_node_error(&self.id, error))?;
        let result = child
            .run_stream(input, &thread_id, resume, |_| {})
            .await
            .map_err(|error| graph_node_error(&self.id, error))?;
        if result.interrupted {
            return Ok(NodeOutput::interrupt_with_data(
                "Subworkflow interrupted",
                json!({ "workflowId": self.workflow_id, "threadId": thread_id }),
            )
            .with_update(&resume_key, true));
        }
        let terminated = result
            .state
            .get("workflow")
            .and_then(Value::as_object)
            .and_then(|workflow| workflow.get(WORKFLOW_TERMINATED_KEY))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let outputs = extract_outputs(&result.state, output_keys).map_err(|error| graph_node_error(&self.id, error))?;
        let global_updates = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .apply_node_update_with_sensitive_fields(
                &self.id,
                NodeStateUpdate::from_object(outputs.clone()),
                &self.global_keys,
                &self.sensitive_fields,
            )
            .map_err(|error| graph_node_error(&self.id, error))?;
        let execution = workflow_trace(&result.state, &node_names);
        let event = json!({
            "nodeId": self.id,
            "type": "subworkflow",
            "workflowName": workflow_name,
            "result": outputs,
            "execution": execution,
            "terminated": terminated,
        });
        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(&self.id, "workflow.node_result", event.clone()),
            );
        }
        let output = NodeOutput::new()
            .with_update(&resume_key, false)
            .with_update("workflow.last_node", json!(self.id))
            .with_update("workflow.node", event.clone())
            .with_update("workflow.trace", event)
            .with_updates(global_updates);
        if terminated {
            Ok(output
                .with_update(WORKFLOW_TERMINATED_KEY, Value::Bool(true))
                .with_goto([END]))
        } else {
            Ok(output)
        }
    }
}

fn workflow_trace(state: &State, node_names: &HashMap<String, String>) -> Vec<Value> {
    state
        .get("workflow")
        .and_then(Value::as_object)
        .and_then(|workflow| workflow.get("workflow.trace"))
        .and_then(Value::as_array)
        .map(|trace| {
            trace
                .iter()
                .cloned()
                .map(|mut entry| {
                    if let Some(record) = entry.as_object_mut()
                        && let Some(node_id) = record.get("nodeId").and_then(Value::as_str)
                        && let Some(node_name) = node_names.get(node_id)
                    {
                        record.insert("nodeName".to_string(), json!(node_name));
                    }
                    entry
                })
                .collect()
        })
        .unwrap_or_default()
}

fn validate_workflow_path(workflow_path: &[String], workflow_id: &str) -> Result<()> {
    if workflow_path.iter().any(|id| id == workflow_id) {
        bail!(
            "subworkflow cycle detected: {} -> {workflow_id}",
            workflow_path.join(" -> "),
        )
    }
    if workflow_path.len() >= 10 {
        bail!("subworkflow nesting exceeds the maximum depth of 10")
    }
    Ok(())
}

fn extract_outputs(state: &adk_rust::graph::State, output_keys: Vec<String>) -> Result<serde_json::Map<String, Value>> {
    let child_global = state
        .get("global")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("subworkflow returned an invalid state"))?;
    Ok(output_keys
        .into_iter()
        .filter_map(|key| child_global.get(&key).cloned().map(|value| (key, value)))
        .collect())
}

pub async fn workflow_dsl(id: &str) -> Result<WorkflowDsl> {
    let workflow = WorkflowCatalogStore::inspect(id).await?;
    let settings = workflow.document.get("settings").cloned().unwrap_or_default();
    serde_json::from_value(json!({
        "id": workflow.id,
        "name": settings.get("name").and_then(Value::as_str).unwrap_or_default(),
        "inputSchema": settings.get("inputSchema").cloned().unwrap_or(json!({ "fields": [] })),
        "outputSchema": settings.get("outputSchema").cloned().unwrap_or(json!({ "fields": [] })),
        "nodes": workflow.document.get("nodes").cloned().unwrap_or_default(),
        "edges": workflow.document.get("edges").cloned().unwrap_or_default(),
    }))
    .map_err(Into::into)
}

pub fn inject_workflow_context(dsl: &mut WorkflowDsl, thread_id: &str, parent_node_id: &str) {
    for node in &mut dsl.nodes {
        if node.kind == "human_review" || node.kind == "ask_user_question" {
            node.data["workflowContext"] = json!({
                "workflowId": dsl.id,
                "threadId": thread_id,
                "path": [parent_node_id, node.id],
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injects_resume_context_only_into_interactive_nodes() {
        let mut dsl = WorkflowDsl {
            id: "child-workflow".to_string(),
            name: String::new(),
            input_schema: WorkflowInterfaceSchema::default(),
            output_schema: WorkflowInterfaceSchema::default(),
            nodes: vec![
                WorkflowNode {
                    id: "review".to_string(),
                    kind: "human_review".to_string(),
                    data: json!({}),
                },
                WorkflowNode {
                    id: "process".to_string(),
                    kind: "process".to_string(),
                    data: json!({}),
                },
            ],
            edges: vec![],
        };

        inject_workflow_context(&mut dsl, "root/subworkflow", "subworkflow");

        assert_eq!(
            dsl.nodes[0].data["workflowContext"],
            json!({
                "workflowId": "child-workflow",
                "threadId": "root/subworkflow",
                "path": ["subworkflow", "review"],
            })
        );
        assert!(dsl.nodes[1].data.get("workflowContext").is_none());
    }

    #[test]
    fn rejects_cycles_and_excessive_nesting() {
        assert!(validate_workflow_path(&["root".to_string()], "root").is_err());
        assert!(validate_workflow_path(&vec!["child".to_string(); 10], "next").is_err());
        assert!(validate_workflow_path(&["root".to_string()], "child").is_ok());
    }

    #[test]
    fn exposes_only_declared_global_outputs() {
        let state = serde_json::from_value(json!({
            "global": { "summary": "done", "inheritedInput": "keep private" },
        }))
        .unwrap();
        assert_eq!(
            extract_outputs(&state, vec!["summary".to_string()]).unwrap(),
            json!({ "summary": "done" }).as_object().unwrap().clone(),
        );
    }

    #[test]
    fn reads_the_child_workflow_trace() {
        let state = serde_json::from_value(json!({
            "workflow": { "workflow.trace": [{ "nodeId": "step", "type": "process" }] },
        }))
        .unwrap();
        assert_eq!(
            workflow_trace(
                &state,
                &HashMap::from([("step".to_string(), "Process data".to_string())])
            ),
            vec![json!({ "nodeId": "step", "type": "process", "nodeName": "Process data" })],
        );
    }
}
