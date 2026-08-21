use super::*;

pub(super) fn add_if_else_control_node(
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

pub(super) fn add_switch_control_node(
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

pub(super) fn validate_edges(
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
        } else if source.kind == "human_review" {
            // Existing workflows used an unlabelled outgoing edge. Preserve it
            // as the new Approved route while newly-created edges must use a
            // labelled handle from the canvas.
            let handle = edge.source_handle.as_deref().unwrap_or("approved");
            if handle != "approved" && handle != "rejected" {
                bail!("human_review node `{}` has invalid handle `{handle}`", source.id);
            }
            if !branch_handles.insert((source.id.clone(), handle.to_string())) {
                bail!("human_review node `{}` has multiple `{handle}` edges", source.id);
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

pub(super) fn add_if_else_edges(
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

pub(super) fn add_switch_edges(
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

pub(super) fn routes_from_edges<F>(
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

pub(super) fn graph_target(id: &str, end_ids: &HashSet<String>) -> EdgeTarget {
    if end_ids.contains(id) {
        EdgeTarget::End
    } else {
        EdgeTarget::Node(id.to_string())
    }
}

pub(super) fn display_target(target: EdgeTarget) -> String {
    target.node_name().unwrap_or(END).to_string()
}

pub(super) struct IfElseConditions {
    pub(super) true_condition: Condition,
    pub(super) false_condition: Condition,
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
pub(super) struct Condition {
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
    pub(super) fn matches(&self, state: &State) -> bool {
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

pub(super) fn if_else_conditions(node: &WorkflowNode) -> Result<IfElseConditions> {
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

pub(super) fn parse_condition(expression: &str) -> Result<Condition> {
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

pub(super) fn parse_condition_field(field: &str) -> Result<String> {
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
pub(super) struct SwitchCaseInput {
    id: String,
    condition: Option<String>,
    value: Option<String>,
}

pub(super) struct SwitchCase {
    id: String,
    condition: Condition,
}

pub(super) fn switch_cases(node: &WorkflowNode) -> Result<Vec<SwitchCase>> {
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

pub(super) fn switch_route(cases: &[SwitchCase], state: &State) -> String {
    cases
        .iter()
        .find(|case| case.condition.matches(state))
        .map(|case| format!("case:{}", case.id))
        .unwrap_or_else(|| "default".to_string())
}
