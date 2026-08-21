use super::*;
use adk_rust::graph::END;

pub(super) struct HumanReviewConfig {
    pub(super) title: String,
    pub(super) description: String,
    pub(super) context_keys: Vec<String>,
    pub(super) approval_key: String,
}

pub(super) fn review_approval_key(node_id: &str) -> String {
    format!("workflow.human_review.{node_id}.approved")
}

pub(super) fn human_review_config(node: &WorkflowNode) -> Result<HumanReviewConfig> {
    Ok(HumanReviewConfig {
        title: string_data(node, "title").unwrap_or_else(|| "Human review required".to_string()),
        description: string_data(node, "description").unwrap_or_default(),
        context_keys: string_array_data(node, "contextKeys")?,
        approval_key: review_approval_key(&node.id),
    })
}

pub(super) fn add_human_review_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let config = human_review_config(node)?;
    Ok(graph.add_node_fn(&id.clone(), move |context| {
        let id = id.clone();
        let config = HumanReviewConfig {
            title: config.title.clone(),
            description: config.description.clone(),
            context_keys: config.context_keys.clone(),
            approval_key: config.approval_key.clone(),
        };
        let on_event = on_event.clone();
        async move {
            // A resumed dynamic interrupt re-executes this node. Its
            // conditional edges route the persisted decision to the matching
            // Approved or Rejected handle.
            if let Some(approved) = context.get(&config.approval_key).and_then(Value::as_bool) {
                let event = json!({
                    "nodeId": id,
                    "type": "human_review",
                    "data": { "title": config.title },
                    "result": {
                        "approved": approved,
                        "label": if approved { "Approved" } else { "Rejected" },
                    },
                });
                if let Some(on_event) = on_event {
                    let _ = on_event.send(StreamEvent::custom(&id, "workflow.node_result", event.clone()));
                }
                return Ok(NodeOutput::new()
                    .with_update("workflow.last_node", json!(id))
                    .with_update("workflow.node", event.clone())
                    .with_update("workflow.trace", event));
            }

            let context_values = config
                .context_keys
                .iter()
                .map(|key| (key.clone(), context.get(key).cloned().unwrap_or(Value::Null)))
                .collect::<serde_json::Map<_, _>>();
            let payload = json!({
                "nodeId": id,
                "title": config.title,
                "description": config.description,
                "context": context_values,
            });
            if let Some(on_event) = on_event {
                let _ = on_event.send(StreamEvent::custom(
                    &id,
                    "workflow.human_review_required",
                    payload.clone(),
                ));
            }
            Ok(NodeOutput::interrupt_with_data("Human review required", payload))
        }
    }))
}

pub(super) fn add_human_review_edges(
    graph: &mut StateGraph,
    node: &WorkflowNode,
    outgoing: &[&WorkflowEdge],
    end_ids: &HashSet<String>,
    plan: &mut Vec<PlanEdge>,
) -> Result<()> {
    let approval_key = review_approval_key(&node.id);
    let mut targets = routes_from_edges(outgoing, end_ids, |edge| {
        edge.source_handle.clone().unwrap_or_else(|| "approved".to_string())
    })?;
    let approved_target = targets.entry("approved".to_string()).or_insert(EdgeTarget::End).clone();
    let rejected_target = targets.entry("rejected".to_string()).or_insert(EdgeTarget::End).clone();
    let router: RouterFn = Arc::new(
        move |state: &State| match state.get(&approval_key).and_then(Value::as_bool) {
            Some(true) => "approved".to_string(),
            Some(false) => "rejected".to_string(),
            None => END.to_string(),
        },
    );
    graph.edges.push(Edge::Conditional {
        source: node.id.clone(),
        router,
        targets,
    });
    plan.push(PlanEdge {
        source: node.id.clone(),
        target: display_target(approved_target),
        route: Some("approved".into()),
    });
    plan.push(PlanEdge {
        source: node.id.clone(),
        target: display_target(rejected_target),
        route: Some("rejected".into()),
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::graph::{ExecutionConfig, START};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[test]
    fn uses_safe_defaults_for_a_human_review_node() {
        let config = human_review_config(&WorkflowNode {
            id: "review".to_string(),
            kind: "human_review".to_string(),
            data: json!({}),
        })
        .unwrap();

        assert_eq!(config.approval_key, "workflow.human_review.review.approved");
        assert!(config.context_keys.is_empty());
    }

    #[tokio::test]
    async fn routes_review_decisions_to_matching_handles() {
        let after_review_runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&after_review_runs);
        let review = WorkflowNode {
            id: "review".to_string(),
            kind: "human_review".to_string(),
            data: json!({}),
        };
        let mut graph = add_human_review_node(
            StateGraph::with_channels(&["workflow.human_review.review.approved"]),
            &review,
            None,
        )
        .unwrap()
        .add_node_fn("after_review", move |_context| {
            let counter = Arc::clone(&counter);
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(NodeOutput::new())
            }
        })
        .add_edge(START, "review")
        .add_edge("after_review", END);
        let edges = vec![WorkflowEdge {
            source: "review".to_string(),
            target: "after_review".to_string(),
            source_handle: Some("approved".to_string()),
        }];
        let outgoing = edges.iter().collect::<Vec<_>>();
        add_human_review_edges(&mut graph, &review, &outgoing, &HashSet::new(), &mut Vec::new()).unwrap();
        let graph = graph.compile().unwrap();

        graph
            .invoke(
                State::from_iter([("workflow.human_review.review.approved".to_string(), json!(false))]),
                ExecutionConfig::new("human-review-rejected"),
            )
            .await
            .unwrap();

        assert_eq!(after_review_runs.load(Ordering::SeqCst), 0);

        graph
            .invoke(
                State::from_iter([("workflow.human_review.review.approved".to_string(), json!(true))]),
                ExecutionConfig::new("human-review-approved"),
            )
            .await
            .unwrap();

        assert_eq!(after_review_runs.load(Ordering::SeqCst), 1);
    }
}
