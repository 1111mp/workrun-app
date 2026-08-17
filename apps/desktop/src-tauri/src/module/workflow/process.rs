use super::*;

pub(super) fn add_process_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
) -> StateGraph {
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
}
