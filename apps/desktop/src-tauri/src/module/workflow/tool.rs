use super::*;

pub(super) fn tool_state_bindings(
    node: &WorkflowNode,
    selected_tool_ids: &[String],
) -> Result<HashMap<String, Vec<ToolStateBinding>>> {
    let Some(value) = node.data.get("toolStateBindings") else {
        return Ok(HashMap::new());
    };
    let bindings = serde_json::from_value::<Vec<ToolStateBinding>>(value.clone())
        .map_err(|error| anyhow!("agent node `{}` field `toolStateBindings` is invalid: {error}", node.id))?;
    let selected_tool_ids = selected_tool_ids.iter().collect::<HashSet<_>>();
    let mut by_tool = HashMap::<String, Vec<ToolStateBinding>>::new();
    let mut targets = HashSet::new();
    for binding in bindings {
        if !selected_tool_ids.contains(&binding.tool_id) {
            bail!(
                "agent node `{}` State Binding references unselected tool `{}`",
                node.id,
                binding.tool_id
            );
        }
        validate_state_path(node, "argumentPath", &binding.argument_path)?;
        validate_state_path(node, "statePath", &binding.state_path)?;
        if !targets.insert((binding.tool_id.clone(), binding.argument_path.clone())) {
            bail!(
                "agent node `{}` has duplicate State Binding target `{}:{}`",
                node.id,
                binding.tool_id,
                binding.argument_path
            );
        }
        by_tool.entry(binding.tool_id.clone()).or_default().push(binding);
    }
    Ok(by_tool)
}

pub(super) fn validate_tool_state_binding_schemas(
    node: &WorkflowNode,
    tools: &[ToolDefinition],
    bindings: &HashMap<String, Vec<ToolStateBinding>>,
) -> Result<()> {
    for tool in tools {
        for binding in bindings.get(&tool.id).into_iter().flatten() {
            if !schema_declares_argument_path(&tool.input_schema, &binding.argument_path) {
                bail!(
                    "agent node `{}` State Binding argumentPath `{}` is not declared by tool `{}` inputSchema",
                    node.id,
                    binding.argument_path,
                    tool.id
                );
            }
        }
    }
    Ok(())
}

fn schema_declares_argument_path(schema: &Value, path: &str) -> bool {
    let segments = path.split('.').collect::<Vec<_>>();
    schema_declares_segments(schema, schema, &segments, 0)
}

fn schema_declares_segments(root: &Value, schema: &Value, segments: &[&str], depth: usize) -> bool {
    if segments.is_empty() {
        return true;
    }
    // Resolve only document-local references; remote schemas are not part of
    // a Tool definition and cannot be validated reliably during compilation.
    if depth < 32
        && let Some(reference) = schema.get("$ref").and_then(Value::as_str)
        && let Some(target) = reference.strip_prefix('#').and_then(|pointer| root.pointer(pointer))
    {
        return schema_declares_segments(root, target, segments, depth + 1);
    }
    for keyword in ["allOf", "anyOf", "oneOf"] {
        if schema.get(keyword).and_then(Value::as_array).is_some_and(|variants| {
            variants
                .iter()
                .any(|variant| schema_declares_segments(root, variant, segments, depth + 1))
        }) {
            return true;
        }
    }
    if let Some(property) = schema
        .get("properties")
        .and_then(Value::as_object)
        .and_then(|properties| properties.get(segments[0]))
    {
        return schema_declares_segments(root, property, &segments[1..], depth + 1);
    }
    if segments[0].parse::<usize>().is_ok()
        && let Some(items) = schema.get("items")
    {
        return schema_declares_segments(root, items, &segments[1..], depth + 1);
    }
    false
}

fn validate_state_path(node: &WorkflowNode, field: &str, path: &str) -> Result<()> {
    if path.trim() != path || path.is_empty() || path.split('.').any(str::is_empty) {
        bail!(
            "agent node `{}` State Binding {field} `{path}` must be a dot-separated path",
            node.id
        );
    }
    Ok(())
}

pub(super) enum ManagedToolExecutor {
    Process,
    Mcp(Arc<dyn Tool>),
}

pub(super) struct ManagedTool {
    definition: ToolDefinition,
    executor: ManagedToolExecutor,
    agent_node_id: String,
    on_event: Option<Channel<StreamEvent>>,
    tool_calls: Arc<AtomicU32>,
    tool_trace: Arc<Mutex<Vec<Value>>>,
    state: SharedWorkflowState,
    state_bindings: Vec<ToolStateBinding>,
    max_tool_calls: u32,
    timeout_seconds: u64,
}

impl ManagedTool {
    pub(super) fn new(
        definition: ToolDefinition,
        executor: ManagedToolExecutor,
        agent_node_id: String,
        on_event: Option<Channel<StreamEvent>>,
        tool_calls: Arc<AtomicU32>,
        tool_trace: Arc<Mutex<Vec<Value>>>,
        state: SharedWorkflowState,
        state_bindings: Vec<ToolStateBinding>,
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
            state,
            state_bindings,
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

        ensure_tool_args_safe(&args)?;

        validate_tool_value(&self.definition.input_schema, &args, "input")?;

        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(
                    &self.agent_node_id,
                    "agent.tool_call",
                    json!({
                        "tool": self.name(),
                        "name": self.definition.display_name,
                        "input": args,
                    }),
                ),
            );
        }
        let execution_args = resolve_execution_args(
            &self.state,
            &self.agent_node_id,
            &args,
            &self.state_bindings,
            &self.definition.input_schema,
        )?;
        let timeout = std::time::Duration::from_secs(self.timeout_seconds);
        let result = match &self.executor {
            ManagedToolExecutor::Process => {
                let run = tokio::time::timeout(
                    timeout,
                    ProcessNodeRegistry::run_for_tool(
                        &self.definition.id,
                        &execution_args,
                        // Buffer process output so secrets split across chunks
                        // cannot pass through the event channel undetected.
                        Arc::new(|_| {}),
                    ),
                )
                .await
                .map_err(|_| tool_timeout_error(self.name(), self.timeout_seconds))?
                .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
                if let Some(on_event) = &self.on_event {
                    for (stream, data) in [("stdout", &run.stdout), ("stderr", &run.stderr)] {
                        if !data.is_empty() {
                            // Tool App stdout/stderr is an explicit local debugging
                            // surface. Preserve it verbatim for the workflow Output UI;
                            // the workflow author is responsible for what the tool prints.
                            let _ = on_event.send(StreamEvent::custom(
                                &self.agent_node_id,
                                "agent.tool_output",
                                json!({ "tool": self.name(), "stream": stream, "data": data }),
                            ));
                        }
                    }
                }
                run.result
            },
            ManagedToolExecutor::Mcp(tool) => tokio::time::timeout(timeout, tool.execute(context, execution_args))
                .await
                .map_err(|_| tool_timeout_error(self.name(), self.timeout_seconds))??,
        };

        validate_tool_value(&self.definition.output_schema, &result, "output")?;

        let trace = redact_json(&json!({
            "tool": self.name(),
            "name": self.definition.display_name,
            "input": args,
            "result": result,
        }));
        if let Ok(mut tool_trace) = self.tool_trace.lock() {
            tool_trace.push(trace.clone());
        }

        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(&self.agent_node_id, "agent.tool_result", trace),
            );
        }

        // Tool implementations may use raw values, but their result returns to
        // the Agent and therefore crosses the visible-state boundary again.
        Ok(redact_json(&result))
    }
}

fn resolve_execution_args(
    state: &SharedWorkflowState,
    agent_node_id: &str,
    args: &Value,
    state_bindings: &[ToolStateBinding],
    input_schema: &Value,
) -> adk_rust::Result<Value> {
    let execution_args = state
        .lock()
        .map_err(|_| adk_rust::AdkError::tool("workflow state lock is poisoned"))?
        .tool_args(agent_node_id, args, state_bindings)
        .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
    // Both Process and MCP executors use this result. Never pass a redaction
    // marker across either external boundary when raw access was not granted.
    ensure_tool_args_resolved(&execution_args)?;
    validate_tool_value(input_schema, &execution_args, "input")?;
    Ok(execution_args)
}

fn tool_timeout_error(name: &str, timeout_seconds: u64) -> adk_rust::AdkError {
    adk_rust::AdkError::tool(format!("Tool `{name}` timed out after {timeout_seconds} seconds"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::state::{AccessRule, NodeStatePolicy, NodeStateUpdate};
    use serde_json::json;
    use std::collections::BTreeSet;

    fn tool_with_schema(id: &str, input_schema: Value) -> ToolDefinition {
        ToolDefinition {
            id: id.to_string(),
            source: ToolSource::Process,
            source_id: None,
            source_name: None,
            display_name: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            version: "1.0.0".to_string(),
            input_schema,
            output_schema: json!({}),
            risk_level: Default::default(),
            permissions: Vec::new(),
            execution_policy: Default::default(),
        }
    }

    #[test]
    fn groups_valid_state_bindings_by_selected_tool() {
        let node = WorkflowNode {
            id: "agent".to_string(),
            kind: "agent".to_string(),
            data: json!({
                "toolStateBindings": [{
                    "toolId": "send-email",
                    "argumentPath": "recipient",
                    "statePath": "customer.email"
                }]
            }),
        };

        let bindings = tool_state_bindings(&node, &["send-email".to_string()]).unwrap();

        assert_eq!(bindings["send-email"][0].argument_path, "recipient");
        assert_eq!(bindings["send-email"][0].state_path, "customer.email");
    }

    #[test]
    fn rejects_duplicate_binding_targets() {
        let node = WorkflowNode {
            id: "agent".to_string(),
            kind: "agent".to_string(),
            data: json!({
                "toolStateBindings": [
                    {"toolId": "send-email", "argumentPath": "recipient", "statePath": "customer.email"},
                    {"toolId": "send-email", "argumentPath": "recipient", "statePath": "backup.email"}
                ]
            }),
        };

        assert!(
            tool_state_bindings(&node, &["send-email".to_string()])
                .unwrap_err()
                .to_string()
                .contains("duplicate State Binding target")
        );
    }

    #[test]
    fn validates_nested_binding_paths_against_tool_input_schema() {
        let schema = json!({
            "type": "object",
            "properties": {
                "recipient": {"type": "string"},
                "options": {
                    "type": "object",
                    "properties": {"priority": {"type": "string"}}
                }
            }
        });

        assert!(schema_declares_argument_path(&schema, "recipient"));
        assert!(schema_declares_argument_path(&schema, "options"));
        assert!(schema_declares_argument_path(&schema, "options.priority"));
        assert!(!schema_declares_argument_path(&schema, "recpient"));
        assert!(!schema_declares_argument_path(&schema, "options.unknown"));
    }

    #[test]
    fn validates_binding_paths_through_local_schema_references() {
        let schema = json!({
            "type": "object",
            "properties": {"recipient": {"$ref": "#/$defs/recipient"}},
            "$defs": {
                "recipient": {
                    "type": "object",
                    "properties": {"email": {"type": "string"}}
                }
            }
        });

        assert!(schema_declares_argument_path(&schema, "recipient.email"));
    }

    #[test]
    fn rejects_binding_paths_missing_from_the_selected_tool_schema() {
        let node = WorkflowNode {
            id: "agent".to_string(),
            kind: "agent".to_string(),
            data: json!({
                "toolStateBindings": [{
                    "toolId": "send-email",
                    "argumentPath": "recpient",
                    "statePath": "customer.email"
                }]
            }),
        };
        let tools = [tool_with_schema(
            "send-email",
            json!({"type": "object", "properties": {"recipient": {"type": "string"}}}),
        )];
        let bindings = tool_state_bindings(&node, &["send-email".to_string()]).unwrap();

        assert!(
            validate_tool_state_binding_schemas(&node, &tools, &bindings)
                .unwrap_err()
                .to_string()
                .contains("argumentPath `recpient` is not declared")
        );
    }

    #[test]
    fn execution_boundary_restores_authorized_raw_tool_arguments() {
        let state = Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap()));
        {
            let mut bridge = state.lock().unwrap();
            bridge.configure_node(
                "extractor",
                NodeStatePolicy {
                    readers: AccessRule::only(["agent"]),
                    raw_readers: AccessRule::only(["agent"]),
                    ..Default::default()
                },
            );
            bridge
                .apply_node_update(
                    "extractor",
                    NodeStateUpdate::new().set("recipient", json!("alice@example.com")),
                    &BTreeSet::new(),
                )
                .unwrap();
        }

        assert_eq!(
            resolve_execution_args(
                &state,
                "agent",
                &json!({"recipient": "[EMAIL REDACTED]"}),
                &[],
                &json!({"type": "object", "properties": {"recipient": {"type": "string"}}, "required": ["recipient"]}),
            )
            .unwrap(),
            json!({"recipient": "alice@example.com"})
        );
    }

    #[test]
    fn execution_boundary_blocks_unresolved_tool_arguments() {
        let state = Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap()));
        {
            let mut bridge = state.lock().unwrap();
            bridge.configure_node(
                "extractor",
                NodeStatePolicy {
                    readers: AccessRule::only(["agent"]),
                    ..Default::default()
                },
            );
            bridge
                .apply_node_update(
                    "extractor",
                    NodeStateUpdate::new().set("recipient", json!("alice@example.com")),
                    &BTreeSet::new(),
                )
                .unwrap();
        }

        assert!(
            resolve_execution_args(
                &state,
                "agent",
                &json!({"recipient": "[EMAIL REDACTED]"}),
                &[],
                &json!({"type": "object", "properties": {"recipient": {"type": "string"}}, "required": ["recipient"]}),
            )
            .unwrap_err()
            .to_string()
            .contains("recipient")
        );
    }
}
