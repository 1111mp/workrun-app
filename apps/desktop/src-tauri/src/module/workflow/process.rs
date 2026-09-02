use super::*;

pub(super) fn add_process_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> StateGraph {
    graph.add_node(ProcessWorkflowNode {
        id: node.id.clone(),
        process_node_id: string_data(node, "processNodeId").unwrap_or_default(),
        name: string_data(node, "name").unwrap_or_else(|| node.id.clone()),
        on_event,
        state,
        global_keys: state_config.global_keys,
        sensitive_fields: state_config.sensitive_fields,
    })
}

struct ProcessWorkflowNode {
    id: String,
    process_node_id: String,
    name: String,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
    sensitive_fields: BTreeSet<String>,
}

#[async_trait::async_trait]
impl Node for ProcessWorkflowNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, _context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        if self.process_node_id.trim().is_empty() {
            return Err(graph_node_error(&self.id, "process node needs data.processNodeId"));
        }
        // `node_input` clones the authorized snapshot, so this guard is dropped
        // before the potentially long-running process invocation below.
        let input = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .node_input(&self.id)
            .map_err(|error| graph_node_error(&self.id, error))?;
        let run = ProcessNodeRegistry::run_for_workflow(
            &self.process_node_id,
            &input,
            // The registry still captures complete stdout/stderr. Emitting only
            // after completion prevents split credentials from escaping checks.
            Arc::new(|_| {}),
        )
        .await
        .map_err(|error| graph_node_error(&self.id, error))?;
        if let Some(on_event) = &self.on_event {
            for (stream, data) in [("stdout", &run.stdout), ("stderr", &run.stderr)] {
                if !data.is_empty() {
                    send_guarded_event(
                        on_event,
                        StreamEvent::custom(
                            &self.id,
                            "process.output",
                            json!({ "name": self.name, "stream": stream, "data": data }),
                        ),
                    );
                }
            }
        }
        // Result keys are private by default; only this node's configured
        // `globalKeys` are promoted by the bridge.
        let update = crate::module::state::NodeStateUpdate::from_object(
            run.result.as_object().expect("validated Process Node result").clone(),
        );
        let global_updates = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .apply_node_update_with_sensitive_fields(&self.id, update, &self.global_keys, &self.sensitive_fields)
            .map_err(|error| graph_node_error(&self.id, error))?;
        let event = redact_json(&json!({
            "nodeId": self.id,
            "type": "process",
            "processNodeId": self.process_node_id,
            "processName": run.definition.name,
            "stdout": run.stdout,
            "stderr": run.stderr,
            "exitCode": run.execution.exit_code,
            "result": run.result,
        }));
        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(&self.id, "workflow.node_result", event.clone()),
            );
        }
        let output = NodeOutput::new()
            .with_update("workflow.last_node", json!(self.id))
            .with_update("workflow.node", event.clone())
            .with_update("workflow.trace", event)
            .with_updates(global_updates);
        Ok(output)
    }
}
