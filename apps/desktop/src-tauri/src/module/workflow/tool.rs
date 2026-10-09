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

pub(super) struct ManagedToolConfig {
    pub(super) agent_node_id: String,
    pub(super) compensation: Option<Value>,
    pub(super) on_event: Option<Channel<StreamEvent>>,
    pub(super) tool_calls: Arc<AtomicU32>,
    pub(super) tool_trace: Arc<Mutex<Vec<Value>>>,
    pub(super) state: SharedWorkflowState,
    pub(super) state_bindings: Vec<ToolStateBinding>,
    pub(super) max_tool_calls: u32,
    pub(super) timeout_seconds: u64,
    pub(super) execution_profile: WorkflowExecutionProfile,
}

pub(super) struct ManagedTool {
    definition: ToolDefinition,
    executor: ManagedToolExecutor,
    agent_node_id: String,
    compensation: Option<Value>,
    on_event: Option<Channel<StreamEvent>>,
    tool_calls: Arc<AtomicU32>,
    tool_trace: Arc<Mutex<Vec<Value>>>,
    state: SharedWorkflowState,
    state_bindings: Vec<ToolStateBinding>,
    max_tool_calls: u32,
    timeout_seconds: u64,
    execution_profile: WorkflowExecutionProfile,
}

impl ManagedTool {
    pub(super) fn new(definition: ToolDefinition, executor: ManagedToolExecutor, config: ManagedToolConfig) -> Self {
        Self {
            definition,
            executor,
            agent_node_id: config.agent_node_id,
            compensation: config.compensation,
            on_event: config.on_event,
            tool_calls: config.tool_calls,
            tool_trace: config.tool_trace,
            state: config.state,
            state_bindings: config.state_bindings,
            max_tool_calls: config.max_tool_calls,
            timeout_seconds: config.timeout_seconds,
            execution_profile: config.execution_profile,
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
        let journal = super::tool_journal::CURRENT.try_with(Arc::clone).ok();
        if let Some(journal) = &journal {
            journal
                .check(false)
                .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
        }
        if self.tool_calls.fetch_add(1, Ordering::Relaxed) >= self.max_tool_calls {
            return Err(adk_rust::AdkError::tool(format!(
                "Agent reached its {} tool-call limit",
                self.max_tool_calls
            )));
        }

        ensure_tool_args_safe(&args)?;

        validate_tool_value(&self.definition.input_schema, &args, "input")?;
        // A model may invoke the same tool repeatedly within one Agent turn.
        // Preserve a call-local ID so history can pair each request and result.
        let call_id = uuid::Uuid::new_v4().to_string();
        let started_at = std::time::Instant::now();

        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(
                    &self.agent_node_id,
                    "agent.tool_call",
                    json!({
                        "callId": call_id,
                        "tool": self.name(),
                        "name": self.definition.display_name,
                        "input": args,
                    }),
                ),
            );
        }
        let execution = async {
            // Fixtures model the tool boundary, not the model-visible request.
            // Resolve authorized bindings first, but keep `args` for events and
            // traces so plaintext credentials never become evaluation evidence.
            let execution_args = resolve_execution_args(
                &self.state,
                &self.agent_node_id,
                &args,
                &self.state_bindings,
                &self.definition.input_schema,
            )?;
            if let Some(result) = evaluation_fixture_result(
                &self.execution_profile,
                &self.agent_node_id,
                self.name(),
                &execution_args,
            )? {
                validate_tool_value(&self.definition.output_schema, &result, "fixture output")?;
                return Ok::<_, adk_rust::AdkError>(result);
            }
            let mut snapshot = json!({"definition": self.definition, "bindings": self.state_bindings, "capabilities": super::tool_journal::CAPABILITIES});
            if matches!(&self.executor, ManagedToolExecutor::Process) && journal.is_some() {
                snapshot["app"] = serde_json::to_value(crate::feat::get_process_node(&self.definition.id).await
                    .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?)
                    .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
            }
            if let Some(compensation) = &self.compensation { snapshot["compensation"] = compensation.clone(); }
            let mut operation = if let Some(journal) = &journal {
                Some(journal.enter(&execution_args, &snapshot).await
                    .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?)
            } else { None };
            if let (Some(journal), Some(operation)) = (&journal, &mut operation) {
                if let Some(saved) = &operation.result {
                    let result = journal.decode(saved).map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
                    validate_tool_value(&self.definition.output_schema, &result, "saved output")?;
                    operation.finish(Some(saved.clone()).as_ref(), "succeeded", None).await
                        .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
                    return Ok(result);
                }
                operation.mark_dispatched().await.map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
            }
            let timeout = std::time::Duration::from_secs(self.timeout_seconds);
            let execution = async { match &self.executor {
                ManagedToolExecutor::Process => {
                    let run = tokio::time::timeout(
                        timeout,
                        crate::module::process_node::ProcessNodeRegistry::run_for_tool(
                            if let Some(app)=snapshot.get("app") {
                                serde_json::from_value(app.clone()).map_err(|error| adk_rust::AdkError::tool(error.to_string()))?
                            } else { crate::feat::get_process_node(&self.definition.id).await.map_err(|error| adk_rust::AdkError::tool(error.to_string()))? },
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
                    Ok::<_, adk_rust::AdkError>(run.result)
                },
                ManagedToolExecutor::Mcp(tool) => tokio::time::timeout(timeout, tool.execute(context, execution_args))
                    .await
                    .map_err(|_| tool_timeout_error(self.name(), self.timeout_seconds))?,
            } }.await;
            let result = match execution {
                Ok(result) => result,
                Err(error) => {
                    if let Some(operation) = &mut operation {
                        // Process exit/MCP error does not prove no external effect.
                        operation.finish(None, "unknown", Some("Tool execution outcome requires reconciliation")).await
                            .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
                    }
                    return Err(error);
                }
            };
            if let (Some(journal), Some(operation)) = (&journal, &mut operation) {
                let saved = journal.encode(&result).map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
                // Save the external fact even if schema validation or Agent
                // output processing fails afterwards.
                operation.finish(Some(&saved), "succeeded", None).await
                    .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
            }
            validate_tool_value(&self.definition.output_schema, &result, "output")?;
            Ok::<_, adk_rust::AdkError>(result)
        }
        .await;
        let result = match execution {
            Ok(result) => result,
            Err(error) => {
                if let Some(journal) = &journal {
                    journal.fail("Tool execution or replay failed; manual reconciliation may be required");
                }
                if let Some(on_event) = &self.on_event {
                    // Record failure without duplicating the possibly sensitive tool error.
                    send_guarded_event(
                        on_event,
                        StreamEvent::custom(
                            &self.agent_node_id,
                            "agent.tool_error",
                            json!({
                                "callId": call_id,
                                "durationMs": started_at.elapsed().as_millis() as u64,
                                "tool": self.name(),
                                "name": self.definition.display_name,
                                "errorCode": tool_error_code(&error),
                            }),
                        ),
                    );
                }
                return Err(error);
            },
        };

        let trace = redact_json(&json!({
            "callId": call_id,
            "durationMs": started_at.elapsed().as_millis() as u64,
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

/// Converts internal failures to stable diagnostics without putting tool
/// arguments, fixture values, or provider error text in the event journal.
fn tool_error_code(error: &adk_rust::AdkError) -> &'static str {
    let message = error.to_string();
    if message.contains("Test Mode blocked unmocked tool") {
        "fixture_not_matched"
    } else if message.contains("Tool State Binding source") {
        "state_binding_unavailable"
    } else if message.contains("fixture output") {
        "fixture_output_invalid"
    } else if message.contains("still redacted") {
        "tool_argument_unresolved"
    } else if message.contains("input does not match its schema") {
        "tool_input_invalid"
    } else {
        "tool_execution_failed"
    }
}

/// Evaluation must fail closed: a fixture mismatch can never fall through to
/// the Process or MCP executor that would perform a real external operation.
fn evaluation_fixture_result(
    profile: &WorkflowExecutionProfile,
    node_id: &str,
    tool: &str,
    args: &Value,
) -> adk_rust::Result<Option<Value>> {
    let WorkflowExecutionProfile::Evaluation(profile) = profile else {
        return Ok(None);
    };
    // A node-scoped rule wins over a legacy global rule, so shared tools can
    // return different fixtures without making existing cases ambiguous.
    profile
        .tool_fixtures
        .iter()
        .find(|fixture| fixture.node_id.as_deref() == Some(node_id) && fixture.tool == tool && fixture.args == *args)
        .or_else(|| {
            profile
                .tool_fixtures
                .iter()
                .find(|fixture| fixture.node_id.is_none() && fixture.tool == tool && fixture.args == *args)
        })
        .map(|fixture| fixture.result.clone())
        .ok_or_else(|| adk_rust::AdkError::tool(format!("Test Mode blocked unmocked tool `{tool}`")))
        .map(Some)
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

    struct UploadTool {
        uploads: Arc<AtomicU32>,
        fail: bool,
    }

    #[async_trait::async_trait]
    impl Tool for UploadTool {
        fn name(&self) -> &str {
            "upload"
        }
        fn description(&self) -> &str {
            "Upload a fixture file"
        }
        async fn execute(&self, _: Arc<dyn ToolContext>, _: Value) -> adk_rust::Result<Value> {
            let resource = self.uploads.fetch_add(1, Ordering::SeqCst) + 1;
            if self.fail {
                return Err(adk_rust::AdkError::tool("Response lost after upload"));
            }
            Ok(json!({"resourceId": format!("private-resource-{resource}")}))
        }
    }

    struct UploadModel {
        calls: AtomicU32,
        fail_after_tool: bool,
        file: &'static str,
        skip_tool: bool,
    }

    #[async_trait::async_trait]
    impl Llm for UploadModel {
        fn name(&self) -> &str {
            "fixture-model"
        }
        async fn generate_content(
            &self,
            _: adk_rust::LlmRequest,
            _: bool,
        ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
            let first = self.calls.fetch_add(1, Ordering::SeqCst) == 0;
            if !first && self.fail_after_tool {
                return Err(adk_rust::AdkError::agent("Answer generation failed after upload"));
            }
            let content = if first && !self.skip_tool {
                adk_rust::Content {
                    role: "model".into(),
                    parts: vec![adk_rust::Part::FunctionCall {
                        name: "upload".into(),
                        args: json!({"file": self.file}),
                        id: Some(uuid::Uuid::new_v4().to_string()),
                        thought_signature: None,
                    }],
                }
            } else {
                adk_rust::Content::new("model").with_text("Uploaded")
            };
            Ok(Box::pin(futures::stream::iter([Ok(adk_rust::LlmResponse {
                content: Some(content),
                partial: false,
                turn_complete: !first || self.skip_tool,
                ..Default::default()
            })])))
        }
    }

    fn upload_agent(
        pool: sqlx::SqlitePool,
        uploads: Arc<AtomicU32>,
        model: UploadModel,
        tool_fails: bool,
    ) -> StreamingAgentNode {
        let state = Arc::new(Mutex::new(
            WorkflowStateBridge::from_initial_state(json!({"input":"upload"})).unwrap(),
        ));
        let mut definition = tool_with_schema(
            "upload",
            json!({"type":"object", "properties":{"file":{"type":"string"}}, "required":["file"]}),
        );
        definition.name = "upload".into();
        let tool = ManagedTool::new(
            definition,
            ManagedToolExecutor::Mcp(Arc::new(UploadTool {
                uploads,
                fail: tool_fails,
            })),
            ManagedToolConfig {
                agent_node_id: "agent".into(),
                compensation: None,
                on_event: None,
                tool_calls: Arc::new(AtomicU32::new(0)),
                tool_trace: Arc::new(Mutex::new(Vec::new())),
                state: Arc::clone(&state),
                state_bindings: Vec::new(),
                max_tool_calls: 8,
                timeout_seconds: 60,
                execution_profile: WorkflowExecutionProfile::Production,
            },
        );
        let agent = LlmAgentBuilder::new("agent")
            .model(Arc::new(model))
            .tool(Arc::new(tool))
            .build()
            .unwrap();
        StreamingAgentNode::new(
            AdkAgentNode::new(Arc::new(agent)),
            StreamingAgentNodeConfig {
                id: "agent".into(),
                kind: "agent".into(),
                endpoint_or_model: "fixture".into(),
                on_event: None,
                tool_trace: None,
                output_key: None,
                output_schema: None,
                state,
                global_keys: BTreeSet::new(),
                sensitive_fields: BTreeSet::new(),
            },
        )
        .with_tracking_storage(pool, vec![42; 32])
    }

    fn upload_model(fail_after_tool: bool) -> UploadModel {
        UploadModel {
            calls: AtomicU32::new(0),
            fail_after_tool,
            file: "fixture.pdf",
            skip_tool: false,
        }
    }

    async fn execute_upload(node: &StreamingAgentNode) -> Vec<adk_rust::graph::Result<StreamEvent>> {
        let context = NodeContext::new(
            HashMap::from([("input".into(), json!("upload"))]),
            ExecutionConfig::new("same-thread").with_metadata("workrun.run_id", json!("run-1")),
            2,
        );
        node.execute_stream(&context).collect().await
    }

    #[tokio::test]
    async fn agent_failure_after_upload_reuses_saved_result_in_original_task() {
        let pool = remote_tasks::test_pool().await;
        let uploads = Arc::new(AtomicU32::new(0));
        let first = upload_agent(pool.clone(), uploads.clone(), upload_model(true), false);
        assert!(execute_upload(&first).await.iter().any(Result::is_err));
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        let id: String = sqlx::query_scalar("SELECT id FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        // Rebuild all runtime objects, as a process restart would. The provider
        // emits a different function-call ID; the logical operation stays stable.
        let resumed = upload_agent(pool.clone(), uploads.clone(), upload_model(false), false);
        let events = execute_upload(&resumed).await;
        assert!(events.iter().all(Result::is_ok), "{events:?}");
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT id FROM workflow_operations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            id
        );
        let actions: Vec<String> =
            sqlx::query_scalar("SELECT action FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(actions, ["submit", "reuse"]);
        let raw: String = sqlx::query_scalar("SELECT result_json FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!raw.contains("private-resource"));
        let input: String = sqlx::query_scalar("SELECT input_ciphertext FROM workflow_tool_inputs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!input.contains("fixture.pdf"));
    }

    #[tokio::test]
    async fn divergent_agent_replay_never_dispatches_changed_or_skipped_calls() {
        let pool = remote_tasks::test_pool().await;
        let uploads = Arc::new(AtomicU32::new(0));
        let first = upload_agent(pool.clone(), uploads.clone(), upload_model(true), false);
        assert!(execute_upload(&first).await.iter().any(Result::is_err));
        let mut changed = upload_model(false);
        changed.file = "different.pdf";
        let node = upload_agent(pool.clone(), uploads.clone(), changed, false);
        assert!(execute_upload(&node).await.iter().any(Result::is_err));
        let mut skipped = upload_model(false);
        skipped.skip_tool = true;
        let node = upload_agent(pool, uploads.clone(), skipped, false);
        assert!(execute_upload(&node).await.iter().any(Result::is_err));
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn tool_error_after_side_effect_blocks_node_even_if_model_returns_an_answer() {
        let pool = remote_tasks::test_pool().await;
        let uploads = Arc::new(AtomicU32::new(0));
        let first = upload_agent(pool.clone(), uploads.clone(), upload_model(false), true);
        assert!(execute_upload(&first).await.iter().any(Result::is_err));
        let resumed = upload_agent(pool.clone(), uploads.clone(), upload_model(false), false);
        assert!(execute_upload(&resumed).await.iter().any(Result::is_err));
        assert_eq!(uploads.load(Ordering::SeqCst), 1);
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
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

        let execution_args = resolve_execution_args(
            &state,
            "agent",
            &json!({"recipient": "[EMAIL REDACTED]"}),
            &[],
            &json!({"type": "object", "properties": {"recipient": {"type": "string"}}, "required": ["recipient"]}),
        )
        .unwrap();
        assert_eq!(execution_args, json!({"recipient": "alice@example.com"}));
        let profile = WorkflowExecutionProfile::Evaluation(EvaluationExecutionProfile {
            tool_fixtures: vec![EvaluationToolFixture {
                node_id: None,
                tool: "lookup_customer".to_string(),
                args: json!({"recipient": "alice@example.com"}),
                result: json!({"found": true}),
            }],
        });
        // A fixture must use the resolved execution value, never the visible
        // redaction marker the model used to construct its request.
        assert_eq!(
            evaluation_fixture_result(&profile, "agent", "lookup_customer", &execution_args).unwrap(),
            Some(json!({"found": true}))
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

    #[test]
    fn evaluation_profile_returns_only_an_exact_fixture_match() {
        let profile = WorkflowExecutionProfile::Evaluation(EvaluationExecutionProfile {
            tool_fixtures: vec![EvaluationToolFixture {
                node_id: None,
                tool: "cancel_order".to_string(),
                args: json!({ "orderId": "42" }),
                result: json!({ "cancelled": true }),
            }],
        });

        assert_eq!(
            evaluation_fixture_result(&profile, "agent", "cancel_order", &json!({ "orderId": "42" })).unwrap(),
            Some(json!({ "cancelled": true }))
        );
        assert!(
            evaluation_fixture_result(&profile, "agent", "cancel_order", &json!({ "orderId": "43" }))
                .unwrap_err()
                .to_string()
                .contains("blocked unmocked tool")
        );
    }

    #[test]
    fn classifies_fixture_misses_without_exposing_arguments() {
        let error = adk_rust::AdkError::tool("Test Mode blocked unmocked tool `lookup_customer`");

        assert_eq!(tool_error_code(&error), "fixture_not_matched");
    }
}
