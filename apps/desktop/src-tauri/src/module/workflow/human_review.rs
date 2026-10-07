use super::*;
use adk_rust::graph::END;

pub(super) struct HumanReviewConfig {
    pub(super) title: String,
    pub(super) description: String,
    pub(super) content_key: Option<String>,
    pub(super) context_keys: Vec<String>,
    pub(super) editable: bool,
    pub(super) attachment_paths: Vec<String>,
    pub(super) approval_key: String,
    pub(super) workflow_context: Option<Value>,
}

pub(super) fn review_approval_key(node_id: &str) -> String {
    format!("workflow.human_review.{node_id}.approved")
}

pub(super) fn human_review_config(node: &WorkflowNode) -> Result<HumanReviewConfig> {
    let legacy_editable_key = string_data(node, "editableKey").filter(|key| !key.trim().is_empty());
    Ok(HumanReviewConfig {
        title: string_data(node, "title").unwrap_or_else(|| "Human review required".to_string()),
        description: string_data(node, "description").unwrap_or_default(),
        content_key: string_data(node, "contentKey")
            .filter(|key| !key.trim().is_empty())
            .or_else(|| legacy_editable_key.clone())
            .or_else(|| string_array_data(node, "contextKeys").ok()?.into_iter().next()),
        context_keys: string_array_data(node, "contextKeys")?,
        editable: node
            .data
            .get("editable")
            .and_then(Value::as_bool)
            .unwrap_or(legacy_editable_key.is_some()),
        attachment_paths: string_array_data(node, "attachmentPaths")?,
        approval_key: review_approval_key(&node.id),
        workflow_context: node.data.get("workflowContext").cloned(),
    })
}

pub(super) fn add_human_review_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let config = human_review_config(node)?;
    Ok(graph.add_node_fn(&id.clone(), move |context| {
        let id = id.clone();
        let config = HumanReviewConfig {
            title: config.title.clone(),
            description: config.description.clone(),
            content_key: config.content_key.clone(),
            context_keys: config.context_keys.clone(),
            editable: config.editable,
            attachment_paths: config.attachment_paths.clone(),
            approval_key: config.approval_key.clone(),
            workflow_context: config.workflow_context.clone(),
        };
        let on_event = on_event.clone();
        let state = Arc::clone(&state);
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
                    send_guarded_event(
                        &on_event,
                        StreamEvent::custom(&id, "workflow.node_result", event.clone()),
                    );
                }
                return Ok(NodeOutput::new()
                    .with_update("workflow.last_node", json!(id))
                    .with_update("workflow.node", event.clone())
                    .with_update("workflow.trace", event));
            }

            let input = state
                .lock()
                .map_err(|_| graph_node_error(&id, "workflow state lock is poisoned"))?
                .node_input(&id)
                .map_err(|error| graph_node_error(&id, error))?;
            let payload = review_payload(&id, &config, &input).map_err(|error| graph_node_error(&id, error))?;
            if let Some(on_event) = on_event {
                send_guarded_event(
                    &on_event,
                    StreamEvent::custom(&id, "workflow.human_review_required", payload.clone()),
                );
            }
            Ok(NodeOutput::interrupt_with_data("Human review required", payload))
        }
    }))
}

fn review_payload(id: &str, config: &HumanReviewConfig, input: &Value) -> Result<Value> {
    let context_values = config
        .context_keys
        .iter()
        .map(|key| (key.clone(), input.get(key).cloned().unwrap_or(Value::Null)))
        .collect::<serde_json::Map<_, _>>();
    let content = config.content_key.as_ref().and_then(|key| input.get(key)).cloned();
    let mut attachments = crate::module::artifact::references(&json!({
        "content": content, "context": context_values,
    }))?;
    // Select only the review's configured content, context and attachment paths,
    // never the whole workflow State or the subworkflow routing metadata.
    for path in &config.attachment_paths {
        let value = super::state_bridge::value_at_path(input, path)
            .ok_or_else(|| anyhow!("Review attachment State path `{path}` is missing or inaccessible"))?;
        let selected = crate::module::artifact::references(value)?;
        if selected.is_empty() {
            bail!("Review attachment State path `{path}` contains no files");
        }
        attachments.extend(selected);
    }
    let mut seen = HashSet::new();
    attachments.retain(|reference| seen.insert((reference.id.clone(), reference.version)));
    Ok(json!({
        "nodeId": id,
        "title": config.title,
        "description": config.description,
        "contentKey": config.content_key,
        "content": content,
        "context": context_values,
        "editable": config.editable,
        "attachments": attachments,
        "workflowContext": config.workflow_context,
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
        assert!(config.content_key.is_none());
        assert!(config.context_keys.is_empty());
        assert!(!config.editable);
    }

    #[test]
    fn reads_the_content_key_and_editing_flag() {
        let config = human_review_config(&WorkflowNode {
            id: "review".to_string(),
            kind: "human_review".to_string(),
            data: json!({ "contentKey": "release_notes", "editable": true }),
        })
        .unwrap();

        assert_eq!(config.content_key.as_deref(), Some("release_notes"));
        assert!(config.editable);
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
            Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap())),
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
        let edges = [WorkflowEdge {
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
    fn file(id: &str) -> Value {
        json!({"$type": "artifact", "id": id, "version": 1, "name": "review.pdf", "mimeType": "application/pdf", "size": 42})
    }

    #[test]
    fn selects_content_context_and_explicit_attachments_without_unrelated_files() {
        let config = human_review_config(&WorkflowNode { id: "review".into(), kind: "human_review".into(), data: json!({
            "contentKey": "document", "contextKeys": ["contextFiles"], "attachmentPaths": ["generated.files.0", "document"],
        }) }).unwrap();
        let payload = review_payload(
            "review",
            &config,
            &json!({
                "document": file("one"), "contextFiles": {"nested": [file("two"), file("one")]},
                "generated": {"files": [file("three")]}, "unrelated": file("hidden"),
            }),
        )
        .unwrap();
        let attachments = payload["attachments"].as_array().unwrap();
        assert_eq!(attachments.len(), 3);
        assert_eq!(
            attachments
                .iter()
                .map(|reference| reference["id"].as_str().unwrap())
                .collect::<HashSet<_>>(),
            HashSet::from(["one", "two", "three"])
        );
        assert!(payload.get("unrelated").is_none());
    }

    #[test]
    fn attachment_paths_cannot_bypass_state_read_permissions_or_sensitive_fields() {
        use crate::module::state::{NodeStatePolicy, NodeStateUpdate};
        let mut bridge = WorkflowStateBridge::from_initial_state_with_policy(
            json!({"secret": file("sensitive")}),
            BTreeSet::new(),
            BTreeSet::from(["secret".into()]),
        )
        .unwrap();
        bridge.configure_node(
            "producer",
            NodeStatePolicy {
                readers: AccessRule::only(["review"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "producer",
                NodeStateUpdate::new().set("report", file("allowed")),
                &BTreeSet::new(),
            )
            .unwrap();
        let config = human_review_config(&WorkflowNode {
            id: "review".into(),
            kind: "human_review".into(),
            data: json!({"attachmentPaths": ["report"]}),
        })
        .unwrap();
        assert_eq!(
            review_payload("review", &config, &bridge.node_input("review").unwrap()).unwrap()["attachments"][0]["id"],
            "allowed"
        );
        assert!(
            review_payload("other", &config, &bridge.node_input("other").unwrap())
                .unwrap_err()
                .to_string()
                .contains("inaccessible")
        );
        let config = human_review_config(&WorkflowNode {
            id: "review".into(),
            kind: "human_review".into(),
            data: json!({"attachmentPaths": ["secret"]}),
        })
        .unwrap();
        assert!(
            review_payload("review", &config, &bridge.node_input("review").unwrap())
                .unwrap_err()
                .to_string()
                .contains("no files")
        );
    }

    #[tokio::test]
    async fn review_pause_keeps_durable_file_references_and_resumes_after_approval() {
        use crate::module::artifact::{ArtifactStore, references};
        use adk_rust::graph::{Interrupt, MemoryCheckpointer};
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(directory.path().join("store"));
        let source = directory.path().join("report.pdf");
        std::fs::write(&source, b"%PDF-1.7\nreview fixture").unwrap();
        let reference = store.import(&source).unwrap();
        std::fs::remove_file(source).unwrap();
        let review = WorkflowNode {
            id: "review".into(),
            kind: "human_review".into(),
            data: json!({"attachmentPaths": ["document"]}),
        };
        let graph = add_human_review_node(
            StateGraph::with_channels(&[
                "workflow.last_node",
                "workflow.node",
                "workflow.trace",
                "workflow.human_review.review.approved",
            ]),
            &review,
            None,
            Arc::new(Mutex::new(
                WorkflowStateBridge::from_initial_state(json!({"document": reference})).unwrap(),
            )),
        )
        .unwrap()
        .add_edge(START, "review")
        .add_edge("review", END)
        .compile()
        .unwrap()
        .with_checkpointer(MemoryCheckpointer::new());
        let GraphError::Interrupted(paused) = graph
            .invoke(State::new(), ExecutionConfig::new("review-files"))
            .await
            .unwrap_err()
        else {
            panic!("expected review pause");
        };
        let Interrupt::Dynamic {
            data: Some(payload), ..
        } = paused.interrupt
        else {
            panic!("expected review payload");
        };
        // The durable action transports JSON references, never PDF bytes or host paths.
        let persisted = serde_json::to_string(&payload).unwrap();
        assert!(!persisted.contains("%PDF"));
        assert!(!persisted.contains(directory.path().to_str().unwrap()));
        let reopened: Value = serde_json::from_str(&persisted).unwrap();
        let attachments = references(&reopened["attachments"]).unwrap();
        assert_eq!(attachments.len(), 1);
        assert_eq!(
            std::fs::read(store.resolve(&attachments[0]).unwrap()).unwrap(),
            b"%PDF-1.7\nreview fixture"
        );
        graph
            .update_state("review-files", [(review_approval_key("review"), json!(true))])
            .await
            .unwrap();
        let resumed = graph
            .invoke(State::new(), ExecutionConfig::new("review-files"))
            .await
            .unwrap();
        assert_eq!(resumed["workflow.node"]["result"]["approved"], true);
        assert!(store.resolve(&attachments[0]).is_ok());
    }
}
