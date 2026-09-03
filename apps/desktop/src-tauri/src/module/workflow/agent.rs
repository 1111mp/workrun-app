use super::*;

#[derive(Debug, Deserialize)]
struct SkillReference {
    source: String,
    name: String,
}

/// Resolves only the tools selected by this workflow node.
///
/// `SkillToolset` starts with its discovery tools and asks this registry for a
/// business tool only after the model has loaded the declaring skill. Keeping
/// this map node-scoped preserves the workflow's existing tool boundary.
struct SelectedToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl adk_rust::ToolRegistry for SelectedToolRegistry {
    fn resolve(&self, tool_name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(tool_name).cloned()
    }
}

pub(super) async fn add_local_agent_node(
    graph: StateGraph,
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let description = string_data(node, "description").unwrap_or_default();
    let instruction = string_data(node, "instruction").unwrap_or_default();
    let output_key = string_data(node, "outputKey").filter(|key| !key.trim().is_empty());
    let output_schema = agent_output_schema(node)?;
    if output_key.is_some() && output_schema.is_some() {
        bail!("agent node `{id}` cannot set both data.outputKey and data.outputSchema");
    }
    let profile_id =
        string_data(node, "modelProfileId").ok_or_else(|| anyhow!("agent node `{id}` needs data.modelProfileId"))?;
    let temperature = number_data(node, "temperature", 0.0, 2.0)?;
    let top_p = number_data(node, "topP", 0.0, 1.0)?;
    let tool_ids = string_array_data(node, "toolIds")?;
    let skills = crate::module::skill::SkillRegistry::resolve(&personal_skill_names(node)?)?;
    let tool_ids = crate::module::skill::allowed_tool_ids(&skills, tool_ids)?;
    let mut state_bindings = tool_state_bindings(node, &tool_ids)?;
    let max_tool_calls = integer_data(node, "maxToolCalls", 8, 1, 50)?;
    let tool_timeout_seconds = integer_data(node, "toolTimeoutSeconds", 60, 1, 600)?;
    let tools = ToolRegistry::resolve(&tool_ids).await?;
    validate_tool_state_binding_schemas(node, &tools, &state_bindings)?;
    let confirmation_tool_names = tools
        .iter()
        .filter(|tool| tool.execution_policy == ToolExecutionPolicy::AskEveryTime)
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let mut agent = LlmAgentBuilder::new(id.clone())
        .description(description)
        .instruction(instruction)
        .model(create_model(&model, config)?)
        .input_guardrails(input_guardrails())
        .output_guardrails(output_guardrails())
        .tool_guardrails(tool_guardrails());
    if let Some(temperature) = temperature {
        agent = agent.temperature(temperature);
    }
    if let Some(top_p) = top_p {
        agent = agent.top_p(top_p);
    }
    if let Some(schema) = output_schema.clone() {
        agent = agent.output_schema(schema);
    }
    let tool_calls = Arc::new(AtomicU32::new(0));
    let tool_trace = Arc::new(Mutex::new(Vec::new()));
    let mut managed_tools = HashMap::with_capacity(tools.len());
    for tool in tools {
        let tool_id = tool.id.clone();
        let tool_bindings = state_bindings.remove(&tool.id).unwrap_or_default();
        let executor = match tool.source {
            ToolSource::Process => ManagedToolExecutor::Process,
            ToolSource::Mcp => ManagedToolExecutor::Mcp(McpServerRegistry::resolve_tool(&tool.id).await?.1),
        };
        let managed_tool: Arc<dyn Tool> = Arc::new(ManagedTool::new(
            tool,
            executor,
            id.clone(),
            on_event.clone(),
            Arc::clone(&tool_calls),
            Arc::clone(&tool_trace),
            Arc::clone(&state),
            tool_bindings,
            max_tool_calls,
            tool_timeout_seconds.into(),
        ));
        managed_tools.insert(tool_id, managed_tool);
    }
    if skills.is_empty() {
        for tool in managed_tools.into_values() {
            agent = agent.tool(tool);
        }
    } else {
        // Do not attach these tools directly: that would expose their schemas
        // before `load_skill` activates the skill that authorizes them.
        agent = agent.toolset(Arc::new(adk_rust::skill::SkillToolset::new(
            Arc::new(adk_rust::skill::SkillIndex::new(skills)),
            Arc::new(SelectedToolRegistry { tools: managed_tools }),
            adk_rust::skill::SkillToolsetConfig::default(),
        )));
    }
    for tool_name in confirmation_tool_names {
        // Let the graph checkpoint before the tool starts. Waiting inside
        // `ManagedTool::execute` would keep this workflow invocation alive.
        agent = agent.require_tool_confirmation(tool_name);
    }
    let agent = agent.build()?;
    Ok(graph.add_node(StreamingAgentNode::new(
        AdkAgentNode::new(Arc::new(agent)).with_input_mapper(agent_input_mapper(Arc::clone(&state), id.clone())),
        id,
        "agent",
        label,
        on_event,
        Some(tool_trace),
        output_key,
        output_schema,
        state,
        state_config.global_keys,
        state_config.sensitive_fields,
    )))
}

pub(super) fn agent_output_schema(node: &WorkflowNode) -> Result<Option<Value>> {
    let Some(value) = node.data.get("outputSchema") else {
        return Ok(None);
    };
    let source = value
        .as_str()
        .ok_or_else(|| anyhow!("agent node `{}` field `outputSchema` must be a JSON string", node.id))?;
    if source.trim().is_empty() {
        return Ok(None);
    }
    let schema = serde_json::from_str::<Value>(source)
        .map_err(|error| anyhow!("agent node `{}` field `outputSchema` is invalid JSON: {error}", node.id))?;
    let root = schema
        .as_object()
        .ok_or_else(|| anyhow!("agent node `{}` outputSchema must be a JSON object", node.id))?;
    if root.get("type").and_then(Value::as_str) != Some("object") {
        bail!("agent node `{}` outputSchema root type must be `object`", node.id);
    }
    let properties = root
        .get("properties")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("agent node `{}` outputSchema must declare object properties", node.id))?;
    for key in properties.keys() {
        if !is_output_state_key_safe(key) {
            bail!(
                "agent node `{}` outputSchema has invalid State property `{key}`",
                node.id
            );
        }
    }
    Ok(Some(schema))
}

fn is_output_state_key_safe(key: &str) -> bool {
    key.trim() == key && !key.is_empty() && !key.contains('.') && key != "messages" && !key.starts_with("workflow.")
}

fn personal_skill_names(node: &WorkflowNode) -> Result<Vec<String>> {
    let Some(value) = node.data.get("skillRefs") else {
        return Ok(Vec::new());
    };
    let refs = serde_json::from_value::<Vec<SkillReference>>(value.clone())
        .map_err(|error| anyhow!("agent node `{}` field `skillRefs` is invalid: {error}", node.id))?;
    refs.into_iter()
        .map(|skill| {
            if skill.source != "personal" {
                bail!(
                    "agent node `{}` references unsupported skill source `{}`",
                    node.id,
                    skill.source
                );
            }
            Ok(skill.name)
        })
        .collect()
}

pub(super) fn create_model(model: &ModelDefinition, config: &IWorkrun) -> Result<Arc<dyn Llm>> {
    let credential = config.credential_for(&model.provider);
    let api_key = credential.and_then(|credential| credential.api_key.as_deref());
    if model.provider != ModelProvider::Ollama && api_key.is_none_or(|api_key| api_key.trim().is_empty()) {
        bail!("provider for model `{}` has no API key", model.id);
    }
    let api_key = api_key.unwrap_or_default();
    Ok(match model.provider {
        ModelProvider::Gemini => Arc::new(GeminiModel::new(api_key, &model.model)?),
        ModelProvider::OpenAi | ModelProvider::OpenAiStrict => {
            Arc::new(OpenAIClient::new(OpenAIConfig::new(api_key, &model.model))?)
        },
        ModelProvider::Anthropic => Arc::new(AnthropicClient::new(AnthropicConfig::new(api_key, &model.model))?),
        ModelProvider::DeepSeek => Arc::new(DeepSeekClient::new(DeepSeekConfig::new(api_key, &model.model))?),
        ModelProvider::Groq => {
            let config = match credential.and_then(|credential| credential.base_url.as_deref()) {
                Some(url) => GroqConfig::new(api_key, &model.model).with_base_url(url),
                None => GroqConfig::new(api_key, &model.model),
            };
            Arc::new(GroqClient::new(config)?)
        },
        ModelProvider::Ollama => Arc::new(OllamaModel::new(
            credential
                .and_then(|credential| credential.base_url.as_ref())
                .map(|url| OllamaConfig::with_host(url, &model.model))
                .unwrap_or_else(|| OllamaConfig::new(&model.model)),
        )?),
    })
}

pub(super) fn remote_a2a_graph_node(
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> Result<StreamingAgentNode> {
    let url = string_data(node, "url")
        .filter(|url| !url.trim().is_empty())
        .ok_or_else(|| anyhow!("remote_agent node `{}` needs data.url", node.id))?;
    let description = string_data(node, "description").unwrap_or_default();
    let remote = RemoteA2aAgent::builder(node.id.clone())
        .description(description)
        .agent_url(url.clone())
        .build()
        .map_err(|error| anyhow!("remote_agent node `{}` is invalid: {error}", node.id))?;
    let id = node.id.clone();
    Ok(StreamingAgentNode::new(
        AdkAgentNode::new(Arc::new(remote)).with_input_mapper(agent_input_mapper(Arc::clone(&state), id.clone())),
        id,
        "remote_agent",
        url,
        on_event,
        None,
        None,
        None,
        state,
        state_config.global_keys,
        state_config.sensitive_fields,
    ))
}

/// ADK 2.0 executes this node once through `execute_stream`. Cache the agent
/// events from that run, then emit the corresponding workflow trace and state
/// updates without issuing another model request.
pub(super) struct StreamingAgentNode {
    id: String,
    inner: AdkAgentNode,
    kind: String,
    endpoint_or_model: String,
    on_event: Option<Channel<StreamEvent>>,
    streamed_events: Mutex<HashMap<(String, usize), Vec<Value>>>,
    tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
    output_key: Option<String>,
    output_schema: Option<Value>,
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
    sensitive_fields: BTreeSet<String>,
}

impl StreamingAgentNode {
    pub(super) fn new(
        inner: AdkAgentNode,
        id: String,
        kind: impl Into<String>,
        endpoint_or_model: impl Into<String>,
        on_event: Option<Channel<StreamEvent>>,
        tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
        output_key: Option<String>,
        output_schema: Option<Value>,
        state: SharedWorkflowState,
        global_keys: BTreeSet<String>,
        sensitive_fields: BTreeSet<String>,
    ) -> Self {
        Self {
            id,
            inner,
            kind: kind.into(),
            endpoint_or_model: endpoint_or_model.into(),
            on_event,
            streamed_events: Mutex::new(HashMap::new()),
            tool_trace,
            output_key,
            output_schema,
            state,
            global_keys,
            sensitive_fields,
        }
    }

    fn cache_key(context: &NodeContext) -> (String, usize) {
        (context.config.thread_id.clone(), context.step)
    }

    fn store_streamed_events(&self, key: (String, usize), events: Vec<Value>) -> adk_rust::graph::Result<()> {
        let mut cache = self
            .streamed_events
            .lock()
            .map_err(|_| graph_node_error(&self.id, "agent event cache is unavailable"))?;
        cache.insert(key, events);
        Ok(())
    }
}

#[async_trait::async_trait]
impl Node for StreamingAgentNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let key = Self::cache_key(context);
        let events = self
            .streamed_events
            .lock()
            .map_err(|_| graph_node_error(&self.id, "agent event cache is unavailable"))?
            .remove(&key)
            .ok_or_else(|| graph_node_error(&self.id, "streamed agent events are unavailable"))?
            .into_iter()
            .map(|event| serde_json::from_value::<Event>(event).map_err(|error| graph_node_error(&self.id, error)))
            .collect::<adk_rust::graph::Result<Vec<_>>>()?;
        let tool_calls = self
            .tool_trace
            .as_ref()
            .and_then(|tool_trace| tool_trace.lock().ok().map(|tool_trace| tool_trace.clone()))
            .unwrap_or_default();
        let mut updates = agent_output_updates(
            &events,
            &self.id,
            &self.kind,
            &self.endpoint_or_model,
            self.on_event.as_ref(),
            &tool_calls,
            self.output_key.as_deref(),
            self.output_schema.as_ref(),
        )
        .map_err(|error| graph_node_error(&self.id, error))?;
        let values = updates
            .iter()
            .filter(|(key, _)| !key.starts_with("workflow."))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        updates.retain(|key, _| key.starts_with("workflow."));
        let global_updates = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .apply_node_update_with_sensitive_fields(
                &self.id,
                crate::module::state::NodeStateUpdate::from_object(values),
                &self.global_keys,
                &self.sensitive_fields,
            )
            .map_err(|error| graph_node_error(&self.id, error))?;
        updates.extend(global_updates);
        Ok(NodeOutput::new().with_updates(updates))
    }

    fn execute_stream<'a>(
        &'a self,
        context: &'a NodeContext,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = adk_rust::graph::Result<StreamEvent>> + Send + 'a>> {
        // The synchronous ADK mapper cannot return an error. Validate the
        // bridge input first so a key collision fails before a model call.
        if let Err(error) = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))
            .and_then(|state| {
                state
                    .agent_input(&self.id)
                    .map_err(|error| graph_node_error(&self.id, error))
            })
        {
            return Box::pin(async_stream::stream! { yield Err(error); });
        }
        let key = Self::cache_key(context);
        let stream = self.inner.execute_stream(context);
        let node = self;

        Box::pin(async_stream::stream! {
            tokio::pin!(stream);

            let mut events = Vec::new();
            while let Some(result) = stream.next().await {
                match result {
                    Ok(event) => {
                        if let StreamEvent::Custom { event_type, data, .. } = &event
                            && event_type == "agent_event"
                        {
                            events.push(data.clone());
                        }
                        if matches!(event, StreamEvent::NodeInterrupt { .. }) {
                            // The executor converts this into a persisted graph pause. Do not
                            // run the post-processing path after a confirmation request.
                            yield Ok(event);
                            return;
                        }
                        // ADK 2.1 emits raw SSE chunks before output guardrails run.
                        // Hold message and agent payload events until the complete
                        // response can be redacted across chunk boundaries.
                        if !matches!(event, StreamEvent::Updates { .. } | StreamEvent::Message { .. })
                            && !matches!(&event, StreamEvent::Custom { event_type, .. } if event_type == "agent_event")
                        {
                            yield Ok(redact_stream_event(event));
                        }
                    }
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
            }

            let parsed_events = events
                .iter()
                .filter_map(|event| serde_json::from_value::<Event>(event.clone()).ok())
                .collect::<Vec<_>>();
            let response = redact_text(&agent_response_text(&parsed_events));
            if !response.is_empty() {
                yield Ok(StreamEvent::message(node.name(), &response, true));
            }

            if let Err(error) = node.store_streamed_events(key, events) {
                yield Err(error);
                return;
            }

            match node.execute(context).await {
                Ok(output) => {
                    for event in output.events {
                        yield Ok(event);
                    }
                    yield Ok(StreamEvent::updates(node.name(), output.updates));
                }
                Err(error) => yield Err(error),
            }
        })
    }
}

pub(super) fn agent_input_mapper(
    state: SharedWorkflowState,
    node_id: String,
) -> impl Fn(&State) -> Content + Send + Sync + 'static {
    move |_| {
        // ADK graph state is not the execution input authority: the bridge
        // projects only the values this node is allowed to read.
        let input = state
            .lock()
            .ok()
            .and_then(|state| state.agent_input(&node_id).ok())
            .unwrap_or(Value::Null);
        Content::new("user").with_text(serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string()))
    }
}

fn agent_response_text(events: &[adk_rust::Event]) -> String {
    events
        .iter()
        .filter_map(|event| event.content())
        .flat_map(|content| content.parts.iter().filter_map(|part| part.text()))
        .collect()
}

fn tool_confirmation_was_denied(events: &[adk_rust::Event]) -> bool {
    events.iter().any(|event| {
        matches!(
            event.actions.tool_confirmation_decision,
            Some(adk_rust::ToolConfirmationDecision::Deny)
        )
    })
}

pub(super) fn agent_output_updates(
    events: &[adk_rust::Event],
    node_id: &str,
    kind: &str,
    endpoint_or_model: &str,
    on_event: Option<&Channel<StreamEvent>>,
    tool_calls: &[Value],
    output_key: Option<&str>,
    output_schema: Option<&Value>,
) -> Result<HashMap<String, Value>> {
    let tool_confirmation_denied = tool_confirmation_was_denied(events);
    // A denied tool call is returned to the model as a function response. Do
    // not let a later model turn invent the data that the user explicitly denied.
    let raw_response = if tool_confirmation_denied {
        "Tool execution was denied by the user.".to_string()
    } else {
        agent_response_text(events)
    };
    let response = redact_text(&raw_response);
    let messages = (!response.is_empty())
        .then(|| json!({ "role": "assistant", "content": response }))
        .into_iter()
        .collect::<Vec<_>>();
    let mut event = json!({
        "nodeId": node_id,
        "type": kind,
        "endpointOrModel": endpoint_or_model,
        "messages": messages,
    });
    if !tool_calls.is_empty() {
        event["toolCalls"] = redact_json(&Value::Array(tool_calls.to_vec()));
    }
    let event = redact_json(&event);
    if let Some(on_event) = on_event {
        send_guarded_event(
            on_event,
            StreamEvent::custom(node_id, "workflow.node_result", event.clone()),
        );
    }
    let mut updates = HashMap::from([
        ("workflow.last_node".to_string(), json!(node_id)),
        ("workflow.node".to_string(), event.clone()),
        ("workflow.trace".to_string(), event),
    ]);
    let output_content = output_key.map(|_| {
        messages
            .iter()
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<String>()
    });
    if !messages.is_empty() {
        updates.insert("messages".to_string(), Value::Array(messages));
    }
    if let (Some(output_key), Some(content)) = (output_key, output_content) {
        updates.insert(output_key.to_string(), Value::String(content));
    }
    if output_schema.is_some() {
        let structured = serde_json::from_str::<Value>(&raw_response)
            .map_err(|error| anyhow!("structured Agent output is not valid JSON: {error}"))?;
        let values = structured
            .as_object()
            .ok_or_else(|| anyhow!("structured Agent output must be a JSON object"))?;
        if let Some(key) = values.keys().find(|key| !is_output_state_key_safe(key)) {
            bail!("structured Agent output has invalid State property `{key}`");
        }
        updates.extend(values.clone());
    }
    Ok(updates)
}
