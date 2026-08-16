use super::*;

pub(super) async fn add_local_agent_node(
    graph: StateGraph,
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let description = string_data(node, "description").unwrap_or_default();
    let instruction = string_data(node, "instruction").unwrap_or_default();
    let profile_id =
        string_data(node, "modelProfileId").ok_or_else(|| anyhow!("agent node `{id}` needs data.modelProfileId"))?;
    let temperature = number_data(node, "temperature", 0.0, 2.0)?;
    let top_p = number_data(node, "topP", 0.0, 1.0)?;
    let tool_ids = string_array_data(node, "toolIds")?;
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
        AdkAgentNode::new(Arc::new(agent)).with_input_mapper(state_as_agent_input),
        id,
        "agent",
        label,
        on_event,
        Some(tool_trace),
    )))
}

fn create_model(model: &ModelDefinition, config: &IWorkrun) -> Result<Arc<dyn Llm>> {
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
        AdkAgentNode::new(Arc::new(remote)).with_input_mapper(state_as_agent_input),
        id,
        "remote_agent",
        url,
        on_event,
        None,
    ))
}

/// `adk-graph` calls `execute_stream` to emit tokens, then calls `execute` a
/// second time to obtain state updates. Its built-in `AgentNode` starts a new
/// model request in both methods. Cache the events from the first request so
/// the second call can derive the state from exactly the text the user saw.
pub(super) struct StreamingAgentNode {
    id: String,
    inner: AdkAgentNode,
    kind: String,
    endpoint_or_model: String,
    on_event: Option<Channel<StreamEvent>>,
    streamed_events: Mutex<HashMap<(String, usize), Vec<Value>>>,
    tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
}

impl StreamingAgentNode {
    fn new(
        inner: AdkAgentNode,
        id: String,
        kind: impl Into<String>,
        endpoint_or_model: impl Into<String>,
        on_event: Option<Channel<StreamEvent>>,
        tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
    ) -> Self {
        Self {
            id,
            inner,
            kind: kind.into(),
            endpoint_or_model: endpoint_or_model.into(),
            on_event,
            streamed_events: Mutex::new(HashMap::new()),
            tool_trace,
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
        Ok(NodeOutput::new().with_updates(agent_output_updates(
            &events,
            &self.id,
            &self.kind,
            &self.endpoint_or_model,
            self.on_event.as_ref(),
            &tool_calls,
        )))
    }

    fn execute_stream<'a>(
        &'a self,
        context: &'a NodeContext,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = adk_rust::graph::Result<StreamEvent>> + Send + 'a>> {
        let key = Self::cache_key(context);
        let stream = self.inner.execute_stream(context);
        let node = self;

        Box::pin(async_stream::stream! {
            futures::pin_mut!(stream);
            let mut events = Vec::new();

            while let Some(result) = stream.next().await {
                match result {
                    Ok(event) => {
                        if let StreamEvent::Custom { event_type, data, .. } = &event
                            && event_type == "agent_event"
                        {
                            events.push(data.clone());
                        }
                        yield Ok(event);
                    }
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
            }

            if let Err(error) = node.store_streamed_events(key, events) {
                yield Err(error);
            }
        })
    }
}

fn state_as_agent_input(state: &State) -> Content {
    // A2A carries text parts. JSON preserves the full shared workflow state,
    // while still allowing remote agents to treat it as a normal user message.
    let input = serde_json::to_string(state).unwrap_or_else(|_| "{}".to_string());
    Content::new("user").with_text(input)
}

pub(super) fn agent_output_updates(
    events: &[adk_rust::Event],
    node_id: &str,
    kind: &str,
    endpoint_or_model: &str,
    on_event: Option<&Channel<StreamEvent>>,
    tool_calls: &[Value],
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
    if !messages.is_empty() {
        updates.insert("messages".to_string(), Value::Array(messages));
    }
    updates
}
