use super::*;
use adk_rust::graph::END;

#[derive(Clone)]
pub(super) struct AskUserQuestionOption {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) description: Option<String>,
}

pub(super) struct AskUserQuestionConfig {
    pub(super) title: String,
    pub(super) description: String,
    pub(super) options: Vec<AskUserQuestionOption>,
    pub(super) answer_key: String,
}

pub(super) fn ask_user_question_state_key(node_id: &str) -> String {
    format!("workflow.ask_user_question.{node_id}.answer")
}

pub(super) fn ask_user_question_config(node: &WorkflowNode) -> Result<AskUserQuestionConfig> {
    let options = node
        .data
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("ask user question node `{}` needs data.options", node.id))?;
    if options.is_empty() {
        bail!("ask user question node `{}` needs at least one option", node.id);
    }

    let mut ids = HashSet::new();
    let options = options
        .iter()
        .map(|option| {
            let id = option
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| anyhow!("ask user question node `{}` has an option without an id", node.id))?;
            if !ids.insert(id.to_string()) {
                bail!("ask user question node `{}` has duplicate option id `{id}`", node.id);
            }
            let label = option
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            Ok(AskUserQuestionOption {
                id: id.to_string(),
                label,
                description: option.get("description").and_then(Value::as_str).map(ToOwned::to_owned),
            })
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(AskUserQuestionConfig {
        title: string_data(node, "title").unwrap_or_else(|| "Choose an option".to_string()),
        description: string_data(node, "description").unwrap_or_default(),
        options,
        answer_key: ask_user_question_state_key(&node.id),
    })
}

pub(super) fn add_ask_user_question_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let config = ask_user_question_config(node)?;
    Ok(graph.add_node_fn(&id.clone(), move |context| {
        let id = id.clone();
        let config = AskUserQuestionConfig {
            title: config.title.clone(),
            description: config.description.clone(),
            options: config.options.clone(),
            answer_key: config.answer_key.clone(),
        };
        let on_event = on_event.clone();
        async move {
            if let Some(option_id) = context.get(&config.answer_key).and_then(Value::as_str) {
                let option = config.options.iter().find(|option| option.id == option_id);
                let event = json!({
                    "nodeId": id,
                    "type": "ask_user_question",
                    "data": { "title": config.title },
                    "result": {
                        "optionId": option_id,
                        "label": option.map(|option| option.label.as_str()).unwrap_or(option_id),
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

            let payload = json!({
                "nodeId": id,
                "title": config.title,
                "description": config.description,
                "options": config.options.iter().map(|option| json!({
                    "id": option.id,
                    "label": option.label,
                    "description": option.description,
                })).collect::<Vec<_>>(),
            });
            if let Some(on_event) = on_event {
                let _ = on_event.send(StreamEvent::custom(
                    &id,
                    "workflow.ask_user_question_required",
                    payload.clone(),
                ));
            }
            Ok(NodeOutput::interrupt_with_data("User answer required", payload))
        }
    }))
}

pub(super) fn add_ask_user_question_edges(
    graph: &mut StateGraph,
    node: &WorkflowNode,
    outgoing: &[&WorkflowEdge],
    end_ids: &HashSet<String>,
    plan: &mut Vec<PlanEdge>,
) -> Result<()> {
    let config = ask_user_question_config(node)?;
    let mut targets = routes_from_edges(outgoing, end_ids, |edge| {
        edge.source_handle.clone().expect("validated source handle")
    })?;
    for option in &config.options {
        targets
            .entry(format!("option:{}", option.id))
            .or_insert(EdgeTarget::End);
    }
    let answer_key = config.answer_key;
    let router: RouterFn = Arc::new(move |state: &State| {
        state
            .get(&answer_key)
            .and_then(Value::as_str)
            .map(|option_id| format!("option:{option_id}"))
            .unwrap_or_else(|| END.to_string())
    });
    graph.edges.push(Edge::Conditional {
        source: node.id.clone(),
        router,
        targets,
    });
    for option in config.options {
        let route = format!("option:{}", option.id);
        let target = graph_target_for_route(&route, outgoing, end_ids);
        plan.push(PlanEdge {
            source: node.id.clone(),
            target: display_target(target),
            route: Some(route),
        });
    }
    Ok(())
}

fn graph_target_for_route(route: &str, outgoing: &[&WorkflowEdge], end_ids: &HashSet<String>) -> EdgeTarget {
    outgoing
        .iter()
        .find(|edge| edge.source_handle.as_deref() == Some(route))
        .map(|edge| graph_target(&edge.target, end_ids))
        .unwrap_or(EdgeTarget::End)
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
    fn scopes_the_answer_key_to_the_node() {
        assert_eq!(
            ask_user_question_state_key("choose-target"),
            "workflow.ask_user_question.choose-target.answer"
        );
    }

    #[test]
    fn rejects_duplicate_option_ids() {
        let node = WorkflowNode {
            id: "question".to_string(),
            kind: "ask_user_question".to_string(),
            data: json!({"options": [
                {"id": "yes", "label": "Yes"},
                {"id": "yes", "label": "Also yes"}
            ]}),
        };
        assert!(ask_user_question_config(&node).is_err());
    }

    #[tokio::test]
    async fn routes_the_selected_option_to_its_handle() {
        let selected_target_runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&selected_target_runs);
        let question = WorkflowNode {
            id: "choose-target".to_string(),
            kind: "ask_user_question".to_string(),
            data: json!({"options": [
                {"id": "staging", "label": "Staging"},
                {"id": "production", "label": "Production"}
            ]}),
        };
        let answer_key = ask_user_question_state_key(&question.id);
        let mut graph = add_ask_user_question_node(StateGraph::with_channels(&[&answer_key]), &question, None)
            .unwrap()
            .add_node_fn("after-production", move |_context| {
                let counter = Arc::clone(&counter);
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Ok(NodeOutput::new())
                }
            })
            .add_edge(START, "choose-target")
            .add_edge("after-production", END);
        let edges = vec![WorkflowEdge {
            source: "choose-target".to_string(),
            target: "after-production".to_string(),
            source_handle: Some("option:production".to_string()),
        }];
        let outgoing = edges.iter().collect::<Vec<_>>();
        add_ask_user_question_edges(&mut graph, &question, &outgoing, &HashSet::new(), &mut Vec::new()).unwrap();
        let graph = graph.compile().unwrap();

        graph
            .invoke(
                State::from_iter([(answer_key, json!("staging"))]),
                ExecutionConfig::new("ask-user-question-staging"),
            )
            .await
            .unwrap();
        assert_eq!(selected_target_runs.load(Ordering::SeqCst), 0);

        graph
            .invoke(
                State::from_iter([(ask_user_question_state_key("choose-target"), json!("production"))]),
                ExecutionConfig::new("ask-user-question-production"),
            )
            .await
            .unwrap();
        assert_eq!(selected_target_runs.load(Ordering::SeqCst), 1);
    }
}
