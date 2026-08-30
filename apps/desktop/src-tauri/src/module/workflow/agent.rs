use super::*;

#[derive(Debug, Deserialize)]
struct SkillReference {
    source: String,
    name: String,
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
    let profile_id =
        string_data(node, "modelProfileId").ok_or_else(|| anyhow!("agent node `{id}` needs data.modelProfileId"))?;
    let temperature = number_data(node, "temperature", 0.0, 2.0)?;
    let top_p = number_data(node, "topP", 0.0, 1.0)?;
    let tool_ids = string_array_data(node, "toolIds")?;
    let skills = crate::module::skill::SkillRegistry::resolve(&personal_skill_names(node)?)?;
    let tool_ids = crate::module::skill::allowed_tool_ids(&skills, tool_ids)?;
    let max_tool_calls = integer_data(node, "maxToolCalls", 8, 1, 50)?;
    let tool_timeout_seconds = integer_data(node, "toolTimeoutSeconds", 60, 1, 600)?;
    let tools = ToolRegistry::resolve(&tool_ids).await?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let mut agent = LlmAgentBuilder::new(id.clone())
        .description(description)
        .instruction(instruction)
        .model(create_model(&model, config)?);
    if !skills.is_empty() {
        agent = agent
            .with_skills(adk_rust::skill::SkillIndex::new(skills.clone()))
            .with_skill_policy(adk_rust::skill::SelectionPolicy {
                top_k: 1,
                min_score: 0.0,
                ..Default::default()
            })
            .with_skill_budget(5_000);
    }
    if let Some(temperature) = temperature {
        agent = agent.temperature(temperature);
    }
    if let Some(top_p) = top_p {
        agent = agent.top_p(top_p);
    }
    let tool_calls = Arc::new(AtomicU32::new(0));
    let tool_trace = Arc::new(Mutex::new(Vec::new()));
    for tool in tools {
        let executor = match tool.source {
            ToolSource::Process => ManagedToolExecutor::Process,
            ToolSource::Mcp => ManagedToolExecutor::Mcp(McpServerRegistry::resolve_tool(&tool.id).await?.1),
        };
        agent = agent.tool(Arc::new(ManagedTool::new(
            tool,
            executor,
            id.clone(),
            on_event.clone(),
            Arc::clone(&tool_calls),
            Arc::clone(&tool_trace),
            max_tool_calls,
            tool_timeout_seconds.into(),
        )));
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
        state,
        state_config.global_keys,
    )))
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
        state,
        state_config.global_keys,
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
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
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
        state: SharedWorkflowState,
        global_keys: BTreeSet<String>,
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
            state,
            global_keys,
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
        );
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
            .apply_node_update(
                &self.id,
                crate::module::state::NodeStateUpdate::from_object(values),
                &self.global_keys,
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
            .and_then(|mut state| {
                state
                    .node_input(self.id.clone())
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
                        // ADK 2.0 applies state only from `Updates` emitted by
                        // this wrapper. Keep the inner agent's streamed tokens,
                        // but replace its updates with the workflow trace below.
                        if !matches!(event, StreamEvent::Updates { .. }) {
                            yield Ok(event);
                        }
                    }
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
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
            .and_then(|mut state| state.node_input(node_id.clone()).ok())
            .unwrap_or(Value::Null);
        Content::new("user").with_text(serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string()))
    }
}

pub(super) fn agent_output_updates(
    events: &[adk_rust::Event],
    node_id: &str,
    kind: &str,
    endpoint_or_model: &str,
    on_event: Option<&Channel<StreamEvent>>,
    tool_calls: &[Value],
    output_key: Option<&str>,
) -> HashMap<String, Value> {
    let messages = events
        .iter()
        .filter_map(|event| event.content())
        .map(|content| {
            content
                .parts
                .iter()
                .filter_map(|part| part.text())
                .collect::<Vec<_>>()
                .join("")
        })
        .filter(|text| !text.is_empty())
        .map(|content| json!({ "role": "assistant", "content": content }))
        .collect::<Vec<_>>();
    let mut event = json!({
        "nodeId": node_id,
        "type": kind,
        "endpointOrModel": endpoint_or_model,
        "messages": messages,
    });
    if !tool_calls.is_empty() {
        event["toolCalls"] = Value::Array(tool_calls.to_vec());
    }
    if let Some(on_event) = on_event {
        let _ = on_event.send(StreamEvent::custom(node_id, "workflow.node_result", event.clone()));
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
    updates
}
