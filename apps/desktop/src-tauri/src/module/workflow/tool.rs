use super::*;

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

        if self.definition.execution_policy == ToolExecutionPolicy::AskEveryTime {
            let request_id = uuid::Uuid::now_v7().to_string();
            let function_call_id = context.function_call_id().to_string();
            let fingerprint = adk_rust::tool_call_fingerprint(self.name(), &args);

            let approved = ToolApprovalRegistry::global()
                .request_approval(request_id.clone(), fingerprint.clone(), || {
                    if let Some(on_event) = &self.on_event {
                        send_guarded_event(
                            on_event,
                            StreamEvent::custom(
                                &self.agent_node_id,
                                "agent.tool_approval_required",
                                json!({
                                    "requestId": request_id,
                                    "functionCallId": function_call_id,
                                    "fingerprint": fingerprint,
                                    "tool": self.name(),
                                    "name": self.definition.display_name,
                                    "description": self.definition.description,
                                    "input": args,
                                    "riskLevel": self.definition.risk_level,
                                    "permissions": self.definition.permissions,
                                    "source": self.definition.source,
                                    "sourceName": self.definition.source_name,
                                }),
                            ),
                        );
                    }
                })
                .await?;

            if !approved {
                return Err(adk_rust::AdkError::tool("Tool denied by user"));
            }
        }

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
        let execution_args = self
            .state
            .lock()
            .map_err(|_| adk_rust::AdkError::tool("workflow state lock is poisoned"))?
            .tool_args(&self.agent_node_id, &args)
            .map_err(|error| adk_rust::AdkError::tool(error.to_string()))?;
        validate_tool_value(&self.definition.input_schema, &execution_args, "input")?;
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
                            send_guarded_event(
                                on_event,
                                StreamEvent::custom(
                                    &self.agent_node_id,
                                    "agent.tool_output",
                                    json!({ "tool": self.name(), "stream": stream, "data": data }),
                                ),
                            );
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

fn tool_timeout_error(name: &str, timeout_seconds: u64) -> adk_rust::AdkError {
    adk_rust::AdkError::tool(format!("Tool `{name}` timed out after {timeout_seconds} seconds"))
}
