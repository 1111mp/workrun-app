use super::*;
use adk_rust::prelude::Part;

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
    execution_profile: WorkflowExecutionProfile,
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
    if let Some(declarations) = node.data.get("toolCompensations").and_then(Value::as_object) {
        for tool in declarations.keys() {
            if !tool_ids.contains(tool) {
                bail!("Compensation declaration references an unselected tool");
            }
        }
    }
    let mut state_bindings = tool_state_bindings(node, &tool_ids)?;
    let max_tool_calls = effective_max_tool_calls(integer_data(node, "maxToolCalls", 8, 1, 50)?, &execution_profile);
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
    let attachment_paths = string_array_data(node, "attachmentPaths")?;
    let provider = model.provider.clone();
    let label = format!("{}/{}", model.id, model.model);
    let model = instrumented_model(create_model(&model, config)?, &id, &label, on_event.clone());
    let mut agent = LlmAgentBuilder::new(id.clone())
        .description(description)
        .instruction(instruction)
        .model(model)
        .input_guardrails(input_guardrails())
        .tool_guardrails(tool_guardrails());
    if !attachment_paths.is_empty() {
        let store = crate::module::artifact::ArtifactStore::active()?;
        let attachment_state = Arc::clone(&state);
        let attachment_node_id = id.clone();
        agent = agent.before_model_callback(Box::new(move |_, mut request| {
            let store = store.clone();
            let input = attachment_state
                .lock()
                .map_err(|_| "workflow state lock is poisoned".to_string())
                .and_then(|state| {
                    state
                        .agent_input(&attachment_node_id)
                        .map_err(|error| error.to_string())
                });
            let paths = attachment_paths.clone();
            let provider = provider.clone();
            Box::pin(async move {
                let input = input.map_err(adk_rust::AdkError::agent)?;
                let parts = tokio::task::spawn_blocking(move || attachment_parts(&store, &input, &paths, &provider))
                    .await
                    .map_err(|error| adk_rust::AdkError::agent(error.to_string()))?
                    .map_err(|error| adk_rust::AdkError::agent(error.to_string()))?;
                let content = request
                    .contents
                    .iter_mut()
                    .rev()
                    .find(|content| content.role == "user")
                    .ok_or_else(|| adk_rust::AdkError::agent("No user content for model attachments"))?;
                // Tool loops may call the model repeatedly with the same conversation.
                for part in parts {
                    if !content.parts.contains(&part) {
                        content.parts.push(part);
                    }
                }
                Ok(adk_rust::BeforeModelResult::Continue(request))
            })
        }));
    }
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
            ToolSource::Mcp => ManagedToolExecutor::Mcp(crate::feat::resolve_mcp_tool(&tool.id).await?.1),
        };
        let managed_tool: Arc<dyn Tool> = Arc::new(ManagedTool::new(
            tool,
            executor,
            ManagedToolConfig {
                agent_node_id: id.clone(),
                compensation: node
                    .data
                    .get("toolCompensations")
                    .and_then(|value| value.get(&tool_id))
                    .cloned(),
                on_event: on_event.clone(),
                tool_calls: Arc::clone(&tool_calls),
                tool_trace: Arc::clone(&tool_trace),
                state: Arc::clone(&state),
                state_bindings: tool_bindings,
                max_tool_calls,
                timeout_seconds: tool_timeout_seconds.into(),
                execution_profile: execution_profile.clone(),
            },
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
        StreamingAgentNodeConfig {
            id,
            kind: "agent".to_string(),
            endpoint_or_model: label,
            on_event,
            tool_trace: Some(tool_trace),
            output_key,
            output_schema,
            state,
            global_keys: state_config.global_keys,
            sensitive_fields: state_config.sensitive_fields,
        },
    )))
}

fn effective_max_tool_calls(configured_limit: u32, execution_profile: &WorkflowExecutionProfile) -> u32 {
    if matches!(execution_profile, WorkflowExecutionProfile::Evaluation(_)) {
        // A fixture is an exact, deterministic tool boundary. Retrying a miss
        // cannot make it match and only causes additional model calls.
        1
    } else {
        configured_limit
    }
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

/// Shared by workflow agents and Workrun-owned background model features.
/// Callers own their prompt and must not turn an internal request into a graph node.
pub(crate) fn create_model(model: &ModelDefinition, config: &IWorkrun) -> Result<Arc<dyn Llm>> {
    create_model_with_thinking(model, config, false)
}

pub(crate) fn conversation_thinking_config(model: &str) -> adk_rust::model::gemini::ThinkingConfig {
    let config = adk_rust::model::gemini::ThinkingConfig::new().with_thoughts_included(true);
    // Flash-Lite defaults to minimal reasoning. Request actual thinking for chat;
    // includeThoughts alone only asks for summaries of whatever thinking occurs.
    if model.starts_with("gemini-3") && model.contains("flash-lite") {
        config.with_thinking_level(adk_rust::model::gemini::ThinkingLevel::Medium)
    } else {
        config
    }
}

/// Conversations request displayable thinking without changing workflow model defaults.
pub(crate) fn create_model_with_thinking(
    model: &ModelDefinition,
    config: &IWorkrun,
    include_thoughts: bool,
) -> Result<Arc<dyn Llm>> {
    let credential = config.credential_for(&model.provider);
    let headers = credential
        .map(|credential| credential.request_headers())
        .transpose()?
        .unwrap_or_default();
    let api_key = credential.and_then(|credential| credential.api_key.as_deref());
    let base_url = credential
        .and_then(|credential| credential.base_url.as_deref())
        .filter(|url| !url.trim().is_empty());
    if model.provider != ModelProvider::Ollama && api_key.is_none_or(|api_key| api_key.trim().is_empty()) {
        bail!("provider for model `{}` has no API key", model.id);
    }
    let api_key = api_key.unwrap_or_default();
    Ok(match model.provider {
        ModelProvider::Gemini => {
            let gemini = GeminiModel::new(api_key, &model.model)?;
            Arc::new(if include_thoughts {
                gemini.with_thinking_config(conversation_thinking_config(&model.model))
            } else {
                gemini
            })
        },
        ModelProvider::OpenAi | ModelProvider::OpenAiStrict => {
            let config = match base_url {
                // ADK's compatible mode is required for local and proxy OpenAI endpoints.
                Some(url) => OpenAIConfig::compatible(api_key, url, &model.model),
                None => OpenAIConfig::new(api_key, &model.model),
            };
            if headers.is_empty() {
                Arc::new(OpenAIClient::new(config)?)
            } else {
                let mut compatible = adk_rust::model::openai::OpenAICompatibleConfig::new(api_key, &model.model)
                    .with_provider_name("openai");
                if let Some(url) = base_url {
                    compatible = compatible.with_base_url(url);
                }
                Arc::new(HeaderOpenAi(
                    adk_rust::model::openai::OpenAICompatible::new(compatible)?.with_default_headers(headers)?,
                ))
            }
        },
        ModelProvider::Anthropic => {
            let config = match base_url {
                Some(url) => AnthropicConfig::new(api_key, &model.model).with_base_url(url),
                None => AnthropicConfig::new(api_key, &model.model),
            };
            Arc::new(AnthropicClient::new(config)?.with_default_headers(headers))
        },
        ModelProvider::DeepSeek => {
            let config = match base_url {
                Some(url) => DeepSeekConfig::new(api_key, &model.model).with_base_url(url),
                None => DeepSeekConfig::new(api_key, &model.model),
            };
            Arc::new(DeepSeekClient::new(config)?)
        },
        ModelProvider::Groq => {
            let config = match base_url {
                Some(url) => GroqConfig::new(api_key, &model.model).with_base_url(url),
                None => GroqConfig::new(api_key, &model.model),
            };
            Arc::new(GroqClient::new(config)?)
        },
        ModelProvider::Ollama => Arc::new(OllamaModel::new(
            base_url
                .map(|url| OllamaConfig::with_host(url, &model.model))
                .unwrap_or_else(|| OllamaConfig::new(&model.model)),
        )?),
    })
}

// The ADK OpenAIClient wrapper does not expose default headers. Preserve its
// schema adapter when constructing the shared compatible transport directly.
struct HeaderOpenAi(adk_rust::model::openai::OpenAICompatible);

#[async_trait::async_trait]
impl Llm for HeaderOpenAi {
    fn name(&self) -> &str {
        self.0.name()
    }
    fn schema_adapter(&self) -> &dyn adk_rust::SchemaAdapter {
        static ADAPTER: adk_rust::model::openai::OpenAiSchemaAdapter = adk_rust::model::openai::OpenAiSchemaAdapter;
        &ADAPTER
    }
    async fn generate_content(
        &self,
        request: adk_rust::LlmRequest,
        stream: bool,
    ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        self.0.generate_content(request, stream).await
    }
}

struct InstrumentedLlm {
    inner: Arc<dyn Llm>,
    node_id: String,
    model: String,
    on_event: Option<Channel<StreamEvent>>,
}

fn model_response_is_final(response: &adk_rust::LlmResponse) -> bool {
    !response.partial
}

/// Measures the provider request stream itself, excluding the Agent's tool work
/// and output processing that happen around it.
#[async_trait::async_trait]
impl Llm for InstrumentedLlm {
    fn name(&self) -> &str {
        self.inner.name()
    }

    async fn generate_content(
        &self,
        request: adk_rust::prelude::LlmRequest,
        stream: bool,
    ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        let started_at = chrono::Utc::now();
        let started_elapsed = Instant::now();
        let response_stream = self.inner.generate_content(request, stream).await?;
        let node_id = self.node_id.clone();
        let model = self.model.clone();
        let on_event = self.on_event.clone();
        Ok(Box::pin(async_stream::stream! {
            tokio::pin!(response_stream);
            let mut emitted_model_call = false;
            while let Some(response) = response_stream.next().await {
                match response {
                    Ok(response) => {
                        // A tool-call response finishes this model request but
                        // keeps the Agent turn open. `partial`, not
                        // `turn_complete`, marks the final provider chunk.
                        if model_response_is_final(&response) && !emitted_model_call {
                            if let Some(on_event) = &on_event {
                                let ended_at = chrono::Utc::now();
                                send_guarded_event(
                                    on_event,
                                    StreamEvent::custom(
                                        &node_id,
                                        "agent.model_call",
                                        model_call_telemetry(
                                            &response,
                                            &model,
                                            started_at,
                                            ended_at,
                                            started_elapsed.elapsed().as_millis().try_into().unwrap_or(i64::MAX),
                                        ),
                                    ),
                                );
                            }
                            emitted_model_call = true;
                        }
                        yield Ok(response);
                    }
                    Err(error) => {
                        yield Err(error);
                        return;
                    }
                }
            }
        }))
    }

    fn schema_adapter(&self) -> &dyn adk_rust::SchemaAdapter {
        self.inner.schema_adapter()
    }

    fn uses_interactions_api(&self) -> bool {
        self.inner.uses_interactions_api()
    }
}

pub(super) fn instrumented_model(
    model: Arc<dyn Llm>,
    node_id: &str,
    model_label: &str,
    on_event: Option<Channel<StreamEvent>>,
) -> Arc<dyn Llm> {
    Arc::new(InstrumentedLlm {
        inner: model,
        node_id: node_id.to_string(),
        model: model_label.to_string(),
        on_event,
    })
}

/// ADK 2.0 executes this node once through `execute_stream`. Cache the agent
/// events from that run, then emit the corresponding workflow trace and state
/// updates without issuing another model request.
pub(super) struct StreamingAgentNode {
    id: String,
    inner: AdkAgentNode,
    #[cfg(test)]
    tracking_storage: Option<(sqlx::SqlitePool, Vec<u8>)>,
    codeact_workspace: Option<Arc<super::codeact_agent::CodeActWorkspace>>,
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
    #[cfg(test)]
    pub(super) fn with_tracking_storage(mut self, pool: sqlx::SqlitePool, key: Vec<u8>) -> Self {
        self.tracking_storage = Some((pool, key));
        self
    }

    pub(super) fn new(inner: AdkAgentNode, config: StreamingAgentNodeConfig) -> Self {
        Self {
            id: config.id,
            inner,
            #[cfg(test)]
            tracking_storage: None,
            codeact_workspace: None,
            kind: config.kind,
            endpoint_or_model: config.endpoint_or_model,
            on_event: config.on_event,
            streamed_events: Mutex::new(HashMap::new()),
            tool_trace: config.tool_trace,
            output_key: config.output_key,
            output_schema: config.output_schema,
            state: config.state,
            global_keys: config.global_keys,
            sensitive_fields: config.sensitive_fields,
        }
    }

    pub(super) fn with_codeact_workspace(mut self, workspace: Arc<super::codeact_agent::CodeActWorkspace>) -> Self {
        self.codeact_workspace = Some(workspace);
        self
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

pub(super) struct StreamingAgentNodeConfig {
    pub(super) id: String,
    pub(super) kind: String,
    pub(super) endpoint_or_model: String,
    pub(super) on_event: Option<Channel<StreamEvent>>,
    pub(super) tool_trace: Option<Arc<Mutex<Vec<Value>>>>,
    pub(super) output_key: Option<String>,
    pub(super) output_schema: Option<Value>,
    pub(super) state: SharedWorkflowState,
    pub(super) global_keys: BTreeSet<String>,
    pub(super) sensitive_fields: BTreeSet<String>,
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
            AgentOutputContext {
                node_id: &self.id,
                kind: &self.kind,
                endpoint_or_model: &self.endpoint_or_model,
                on_event: self.on_event.as_ref(),
                tool_calls: &tool_calls,
                output_key: self.output_key.as_deref(),
                output_schema: self.output_schema.as_ref(),
            },
        )
        .map_err(|error| graph_node_error(&self.id, error))?;
        if let Some(workspace) = &self.codeact_workspace {
            let workspace = Arc::clone(workspace);
            let artifacts = tokio::task::spawn_blocking(move || workspace.collect())
                .await
                .map_err(|error| graph_node_error(&self.id, error))?
                .map_err(|error| graph_node_error(&self.id, error))?;
            updates.insert("artifacts".into(), artifacts);
        }
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
        if self.codeact_workspace.is_some() {
            self.state
                .lock()
                .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
                .set_codeact_files(&self.id, None);
        }
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
        let node = self;

        Box::pin(async_stream::stream! {
            if let Some(workspace) = &node.codeact_workspace {
                let input = match node.state.lock().ok().and_then(|state| state.agent_input(&node.id).ok()) {
                    Some(input) => input,
                    None => { yield Err(graph_node_error(&node.id, "CodeAct input unavailable")); return; }
                };
                let snapshot = node.state.lock().ok().and_then(|state| state.codeact_files(&node.id));
                let workspace = Arc::clone(workspace);
                let prepared = tokio::task::spawn_blocking(move || {
                    workspace.prepare(&input, snapshot.as_ref())
                }).await;
                match prepared {
                    Ok(Ok(())) => {},
                    Ok(Err(error)) => { yield Err(graph_node_error(&node.id, error)); return; },
                    Err(error) => { yield Err(graph_node_error(&node.id, error)); return; },
                }
            }
            // Scope every poll, rather than only stream creation: ADK invokes
            // tools while its lazy stream is being polled on this task.
            let journal = if node.kind == "agent"
                && let Some(run_id) = context.config.metadata.get("workrun.run_id").and_then(Value::as_str)
            {
                let prepared = async {
                    #[cfg(test)]
                    let storage = node.tracking_storage.clone();
                    #[cfg(not(test))]
                    let storage: Option<(sqlx::SqlitePool, Vec<u8>)> = None;
                    let (pool, key) = match storage {
                        Some(storage) => storage,
                        None => (crate::core::db::DBManager::global().pool()?, crate::utils::dirs::get_encryption_key()?),
                    };
                    let execution_id = context.config.metadata.get("workrun.execution_id").and_then(Value::as_str).unwrap_or(run_id);
                    let scope = context.config.metadata.get("workrun.execution_path").and_then(Value::as_str).unwrap_or("root");
                    super::tool_journal::validate_recovery(&pool, execution_id, scope, &node.id, context.step).await?;
                    super::tool_journal::ToolJournal::new(pool, key, execution_id, run_id, scope, &node.id, context.step).await
                }.await;
                match prepared {
                    Ok(journal) => Some(Arc::new(journal)),
                    Err(error) => { yield Err(graph_node_error(&node.id, error)); return; }
                }
            } else { None };
            let stream = node.inner.execute_stream(context);
            tokio::pin!(stream);

            let mut events = Vec::new();
            loop {
                let result = if let Some(journal) = &journal {
                    super::tool_journal::CURRENT.scope(Arc::clone(journal), stream.next()).await
                } else { stream.next().await };
                let Some(result) = result else { break };
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
                            if let Some(workspace) = &node.codeact_workspace {
                                let workspace = Arc::clone(workspace);
                                let snapshot = tokio::task::spawn_blocking(move || {
                                    workspace.snapshot()
                                }).await;
                                match snapshot {
                                    Ok(Ok(files)) => {
                                        let saved = node.state.lock().map(|mut state| state.set_codeact_files(&node.id, Some(files))).map_err(|_| graph_node_error(&node.id, "workflow state lock is poisoned"));
                                        if let Err(error) = saved { yield Err(error); return; }
                                    },
                                    Ok(Err(error)) => { yield Err(graph_node_error(&node.id, error)); return; },
                                    Err(error) => { yield Err(graph_node_error(&node.id, error)); return; },
                                }
                            }
                            yield Ok(event);
                            return;
                        }
                        // Forward Agent text immediately; internal payloads remain private.
                        // CodeAct retains its existing complete-response redaction.
                        if matches!(&event, StreamEvent::Message { .. }) && node.kind == "agent" {
                            yield Ok(event);
                        } else if !matches!(event, StreamEvent::Updates { .. } | StreamEvent::Message { .. })
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

            if let Some(journal) = &journal && let Err(error) = journal.check(true) {
                yield Err(graph_node_error(&node.id, error));
                return;
            }
            let parsed_events = events
                .iter()
                .filter_map(|event| serde_json::from_value::<Event>(event.clone()).ok())
                .collect::<Vec<_>>();
            if node.kind == "agent" {
                // Earlier messages already contain the text; only close the stream.
                yield Ok(StreamEvent::message(node.name(), "", true));
            } else {
                let response = redact_text(&agent_response_text(&parsed_events));
                if !response.is_empty() {
                    yield Ok(StreamEvent::message(node.name(), &response, true));
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
            .and_then(|state| state.agent_input(&node_id).ok())
            .unwrap_or(Value::Null);
        Content::new("user").with_text(serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string()))
    }
}

fn agent_response_text(events: &[adk_rust::Event]) -> String {
    // ADK 2.3 terminal events contain the full response, after earlier partial chunks.
    let mut deltas = adk_rust::EventTextDeltas::default();
    let mut text = String::new();
    for event in events {
        let event = deltas.push(event);
        if let Some(content) = event.content() {
            for part in &content.parts {
                if let Some(chunk) = part.text() {
                    text.push_str(chunk);
                }
            }
        }
    }
    text
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
    context: AgentOutputContext<'_>,
) -> Result<HashMap<String, Value>> {
    let tool_confirmation_denied = tool_confirmation_was_denied(events);
    // A denied tool call is returned to the model as a function response. Do
    // not let a later model turn invent the data that the user explicitly denied.
    let raw_response = if tool_confirmation_denied {
        "Tool execution was denied by the user.".to_string()
    } else {
        agent_response_text(events)
    };
    let response = if context.kind == "agent" {
        raw_response.clone()
    } else {
        redact_text(&raw_response)
    };
    let messages = (!response.is_empty())
        .then(|| json!({ "role": "assistant", "content": response }))
        .into_iter()
        .collect::<Vec<_>>();
    let mut event = json!({
        "nodeId": context.node_id,
        "type": context.kind,
        "endpointOrModel": context.endpoint_or_model,
        "messages": messages,
    });
    if !context.tool_calls.is_empty() {
        event["toolCalls"] = redact_json(&Value::Array(context.tool_calls.to_vec()));
    }
    let event = redact_node_result(event);
    if let Some(on_event) = context.on_event {
        send_guarded_event(
            on_event,
            StreamEvent::custom(context.node_id, "workflow.node_result", event.clone()),
        );
    }
    let mut updates = HashMap::from([
        ("workflow.last_node".to_string(), json!(context.node_id)),
        ("workflow.node".to_string(), event.clone()),
        ("workflow.trace".to_string(), event),
    ]);
    if !tool_confirmation_denied {
        let mut artifacts = Vec::new();
        for part in events
            .iter()
            .filter_map(|event| event.content())
            .filter(|content| matches!(content.role.as_str(), "model" | "assistant"))
            .flat_map(|content| &content.parts)
        {
            if let Part::InlineData { mime_type, data, .. } = part {
                let extension = match mime_type.as_str() {
                    "image/png" => "png",
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "application/pdf" => "pdf",
                    "video/mp4" => "mp4",
                    _ => "bin",
                };
                let reference = crate::module::artifact::ArtifactStore::active()?
                    .save_bytes(&format!("generated-{}.{}", artifacts.len() + 1, extension), data)?;
                artifacts.push(serde_json::to_value(reference)?);
            }
        }
        if !artifacts.is_empty() {
            updates.insert("artifacts".into(), Value::Array(artifacts));
        }
    }
    let output_content = context.output_key.map(|_| {
        messages
            .iter()
            .filter_map(|message| message.get("content").and_then(Value::as_str))
            .collect::<String>()
    });
    if !messages.is_empty() {
        updates.insert("messages".to_string(), Value::Array(messages));
    }
    if let (Some(output_key), Some(content)) = (context.output_key, output_content) {
        updates.insert(output_key.to_string(), Value::String(content));
    }
    if context.output_schema.is_some() {
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

pub(super) struct AgentOutputContext<'a> {
    pub(super) node_id: &'a str,
    pub(super) kind: &'a str,
    pub(super) endpoint_or_model: &'a str,
    pub(super) on_event: Option<&'a Channel<StreamEvent>>,
    pub(super) tool_calls: &'a [Value],
    pub(super) output_key: Option<&'a str>,
    pub(super) output_schema: Option<&'a Value>,
}

#[derive(Debug, PartialEq)]
struct WorkrunUsageSnapshot {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    total_tokens_estimated: bool,
    cache_read_tokens: Option<i64>,
    cache_write_tokens: Option<i64>,
    reasoning_tokens: Option<i64>,
    audio_input_tokens: Option<i64>,
    audio_output_tokens: Option<i64>,
    estimated_cost_microusd: Option<i64>,
    is_byok: Option<bool>,
}

impl WorkrunUsageSnapshot {
    fn from_adk(usage: &adk_rust::UsageMetadata) -> Self {
        let input_tokens = usage.prompt_token_count.max(0) as i64;
        let output_tokens = usage.candidates_token_count.max(0) as i64;
        let reported_total_tokens = usage.total_token_count.max(0) as i64;
        // ADK's total count is not optional. Treat a zero total with nonzero
        // input/output as omitted provider data, rather than reporting zero.
        let total_tokens_estimated = reported_total_tokens == 0 && input_tokens + output_tokens > 0;
        Self {
            input_tokens,
            output_tokens,
            total_tokens: if total_tokens_estimated {
                input_tokens + output_tokens
            } else {
                reported_total_tokens
            },
            total_tokens_estimated,
            cache_read_tokens: usage.cache_read_input_token_count.map(|value| value.max(0) as i64),
            cache_write_tokens: usage.cache_creation_input_token_count.map(|value| value.max(0) as i64),
            reasoning_tokens: usage.thinking_token_count.map(|value| value.max(0) as i64),
            audio_input_tokens: usage.audio_input_token_count.map(|value| value.max(0) as i64),
            audio_output_tokens: usage.audio_output_token_count.map(|value| value.max(0) as i64),
            estimated_cost_microusd: usage
                .cost
                .filter(|cost| cost.is_finite() && *cost >= 0.0)
                .map(|cost| (cost * 1_000_000.0).round() as i64),
            is_byok: usage.is_byok,
        }
    }
}

fn model_call_telemetry(
    response: &adk_rust::LlmResponse,
    model: &str,
    started_at: chrono::DateTime<chrono::Utc>,
    ended_at: chrono::DateTime<chrono::Utc>,
    duration_ms: i64,
) -> Value {
    let usage = response.usage_metadata.as_ref().map(WorkrunUsageSnapshot::from_adk);
    json!({
        "modelCallId": uuid::Uuid::new_v4().to_string(),
        "model": model,
        "startedAt": started_at.to_rfc3339(),
        "endedAt": ended_at.to_rfc3339(),
        "durationMs": duration_ms,
        "inputTokens": usage.as_ref().map(|usage| usage.input_tokens),
        "outputTokens": usage.as_ref().map(|usage| usage.output_tokens),
        "totalTokens": usage.as_ref().map(|usage| usage.total_tokens),
        "totalTokensEstimated": usage.as_ref().map(|usage| usage.total_tokens_estimated).unwrap_or(false),
        "cacheReadTokens": usage.as_ref().and_then(|usage| usage.cache_read_tokens),
        "cacheWriteTokens": usage.as_ref().and_then(|usage| usage.cache_write_tokens),
        "reasoningTokens": usage.as_ref().and_then(|usage| usage.reasoning_tokens),
        "audioInputTokens": usage.as_ref().and_then(|usage| usage.audio_input_tokens),
        "audioOutputTokens": usage.as_ref().and_then(|usage| usage.audio_output_tokens),
        "estimatedCostMicrousd": usage.as_ref().and_then(|usage| usage.estimated_cost_microusd),
        "isByok": usage.as_ref().and_then(|usage| usage.is_byok),
    })
}

#[cfg(test)]
mod usage_snapshot_tests {
    use super::*;
    use futures::{StreamExt, stream};

    #[tokio::test]
    async fn model_custom_headers_reach_openai_and_anthropic_requests() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        for provider in [ModelProvider::OpenAi, ModelProvider::Anthropic] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let anthropic = provider == ModelProvider::Anthropic;
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let mut buffer = [0u8; 4096];
                loop {
                    let count = socket.read(&mut buffer).await.unwrap();
                    assert_ne!(count, 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length: usize = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length: "))
                            .unwrap()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(bytes).unwrap();
                let body = if anthropic {
                    json!({"id":"msg-test","type":"message","role":"assistant","model":"test-model","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}})
                } else {
                    json!({"id":"chat-test","object":"chat.completion","created":0,"model":"test-model","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
                }.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await.unwrap();
                request
            });
            let credential = crate::config::ProviderCredential {
                provider: provider.clone(),
                base_url: Some(format!("http://{address}/v1")),
                api_key: Some("test-key".into()),
                headers: vec![crate::config::ProviderHeader {
                    name: "X-Tenant-ID".into(),
                    value: "team-test".into(),
                }],
            };
            let config = IWorkrun {
                provider_credentials: vec![credential],
                ..Default::default()
            };
            let model = create_model(
                &ModelDefinition {
                    id: "test".into(),
                    name: "test".into(),
                    provider,
                    model: "test-model".into(),
                },
                &config,
            )
            .unwrap();
            let request = adk_rust::LlmRequest::new("test-model", vec![Content::new("user").with_text("hello")]);
            let mut responses = model.generate_content(request, false).await.unwrap();
            let response = responses.next().await.unwrap().unwrap();
            assert_eq!(response.content.unwrap().parts[0].text(), Some("ok"));
            let request = server.await.unwrap().to_lowercase();
            assert!(request.contains("x-tenant-id: team-test\r\n"));
            if anthropic {
                assert!(request.contains("x-api-key: test-key\r\n"));
            } else {
                assert!(request.contains("authorization: bearer test-key\r\n"));
            }
        }
    }
    #[test]
    fn evaluation_limits_fixture_tools_to_one_call() {
        let profile = WorkflowExecutionProfile::Evaluation(EvaluationExecutionProfile {
            tool_fixtures: Vec::new(),
        });

        assert_eq!(effective_max_tool_calls(8, &profile), 1);
        assert_eq!(effective_max_tool_calls(8, &WorkflowExecutionProfile::Production), 8);
    }

    struct PausedStreamingLlm {
        resume: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl Llm for PausedStreamingLlm {
        fn name(&self) -> &str {
            "stream-fixture"
        }

        async fn generate_content(
            &self,
            _request: adk_rust::LlmRequest,
            streaming: bool,
        ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
            assert!(streaming);
            let resume = Arc::clone(&self.resume);
            Ok(Box::pin(async_stream::stream! {
                yield Ok(adk_rust::LlmResponse {
                    content: Some(Content::new("model").with_text("Contact alice@")),
                    partial: true,
                    ..Default::default()
                });
                resume.notified().await;
                yield Ok(adk_rust::LlmResponse {
                    content: Some(Content::new("model").with_text("example.com")),
                    partial: false,
                    turn_complete: true,
                    ..Default::default()
                });
            }))
        }
    }

    #[tokio::test]
    async fn forwards_agent_text_before_model_completion_without_repeating_it() {
        let resume = Arc::new(tokio::sync::Notify::new());
        let agent = LlmAgentBuilder::new("agent")
            .model(Arc::new(PausedStreamingLlm {
                resume: Arc::clone(&resume),
            }))
            .build()
            .unwrap();
        let node = StreamingAgentNode::new(
            AdkAgentNode::new(Arc::new(agent)),
            StreamingAgentNodeConfig {
                id: "agent".into(),
                kind: "agent".into(),
                endpoint_or_model: "fixture".into(),
                on_event: None,
                tool_trace: None,
                output_key: None,
                output_schema: None,
                state: Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap())),
                global_keys: BTreeSet::new(),
                sensitive_fields: BTreeSet::new(),
            },
        );
        let context = NodeContext::new(HashMap::new(), adk_rust::graph::ExecutionConfig::new("stream-test"), 0);
        let mut stream = node.execute_stream(&context);
        // The model cannot finish until this first frontend-bound message arrives.
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
            .await
            .expect("first chunk must arrive before completion")
            .unwrap()
            .unwrap();
        let StreamEvent::Message { content, is_final, .. } = redact_event_for_transport(first) else {
            panic!("expected streaming text");
        };
        assert_eq!(content, "Contact alice@");
        assert!(!is_final);
        resume.notify_one();
        let remaining = tokio::time::timeout(std::time::Duration::from_secs(2), stream.collect::<Vec<_>>())
            .await
            .unwrap();
        let mut text = content;
        let mut completed = 0;
        for event in remaining {
            if let StreamEvent::Message { content, is_final, .. } = redact_event_for_transport(event.unwrap()) {
                text.push_str(&content);
                completed += usize::from(is_final);
            }
        }
        assert_eq!(text, "Contact alice@example.com");
        assert_eq!(completed, 1);
    }

    struct FinalToolCallResponseLlm;

    #[async_trait::async_trait]
    impl Llm for FinalToolCallResponseLlm {
        fn name(&self) -> &str {
            "test"
        }

        async fn generate_content(
            &self,
            _request: adk_rust::LlmRequest,
            _stream: bool,
        ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
            Ok(Box::pin(stream::iter([Ok(adk_rust::LlmResponse {
                partial: false,
                turn_complete: false,
                ..Default::default()
            })])))
        }
    }

    #[test]
    fn maps_every_supported_adk_usage_field() {
        let snapshot = WorkrunUsageSnapshot::from_adk(&adk_rust::UsageMetadata {
            prompt_token_count: 100,
            candidates_token_count: 25,
            total_token_count: 160,
            cache_read_input_token_count: Some(80),
            cache_creation_input_token_count: Some(10),
            thinking_token_count: Some(35),
            audio_input_token_count: Some(4),
            audio_output_token_count: Some(5),
            cost: Some(0.000123),
            is_byok: Some(true),
            ..Default::default()
        });

        assert_eq!(
            snapshot,
            WorkrunUsageSnapshot {
                input_tokens: 100,
                output_tokens: 25,
                total_tokens: 160,
                total_tokens_estimated: false,
                cache_read_tokens: Some(80),
                cache_write_tokens: Some(10),
                reasoning_tokens: Some(35),
                audio_input_tokens: Some(4),
                audio_output_tokens: Some(5),
                estimated_cost_microusd: Some(123),
                is_byok: Some(true),
            }
        );
    }

    #[test]
    fn estimates_missing_total_without_inventing_optional_usage() {
        let snapshot = WorkrunUsageSnapshot::from_adk(&adk_rust::UsageMetadata {
            prompt_token_count: 4,
            candidates_token_count: 2,
            total_token_count: 0,
            cost: Some(-1.0),
            ..Default::default()
        });

        assert_eq!(snapshot.total_tokens, 6);
        assert!(snapshot.total_tokens_estimated);
        assert_eq!(snapshot.cache_read_tokens, None);
        assert_eq!(snapshot.reasoning_tokens, None);
        assert_eq!(snapshot.estimated_cost_microusd, None);
        assert_eq!(snapshot.is_byok, None);
    }

    #[test]
    fn includes_measured_duration_in_model_call_telemetry() {
        let response = adk_rust::LlmResponse {
            usage_metadata: Some(adk_rust::UsageMetadata {
                prompt_token_count: 10,
                candidates_token_count: 5,
                total_token_count: 15,
                ..Default::default()
            }),
            ..Default::default()
        };

        let now = chrono::Utc::now();
        let telemetry = model_call_telemetry(&response, "gemini-test", now, now, 321);

        assert_eq!(telemetry["durationMs"], 321);
        assert_eq!(telemetry["inputTokens"], 10);
        assert_eq!(telemetry["outputTokens"], 5);
    }

    #[test]
    fn tool_call_response_is_final_even_when_agent_turn_continues() {
        let response = adk_rust::LlmResponse {
            partial: false,
            turn_complete: false,
            ..Default::default()
        };

        assert!(model_response_is_final(&response));
    }

    #[tokio::test]
    async fn emits_model_telemetry_before_the_agent_stops_polling_after_a_tool_call() {
        let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
        let received = Arc::clone(&emitted);
        let on_event = Channel::new(move |payload| {
            if let tauri::ipc::InvokeResponseBody::Json(payload) = payload {
                received
                    .lock()
                    .expect("test event list is available")
                    .push(serde_json::from_str(&payload).expect("stream event is JSON"));
            }
            Ok(())
        });
        let model = instrumented_model(
            Arc::new(FinalToolCallResponseLlm),
            "agent",
            "gemini-test",
            Some(on_event),
        );
        let mut responses = model
            .generate_content(adk_rust::LlmRequest::new("test", vec![]), true)
            .await
            .expect("test model creates a response stream");

        let response = responses
            .next()
            .await
            .expect("final response is yielded")
            .expect("final response succeeds");

        assert!(model_response_is_final(&response));
        let emitted = emitted.lock().expect("test event list is available");
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0]["event_type"], "agent.model_call");
        assert_eq!(emitted[0]["data"]["model"], "gemini-test");
        assert!(emitted[0]["data"]["durationMs"].is_i64());
    }
}

fn attachment_parts(
    store: &crate::module::artifact::ArtifactStore,
    input: &Value,
    paths: &[String],
    provider: &crate::config::ModelProvider,
) -> Result<Vec<Part>> {
    use crate::config::ModelProvider;
    let mut selected = Vec::new();
    for path in paths {
        let value = path
            .split('.')
            .try_fold(input, |value, segment| value.get(segment))
            .ok_or_else(|| anyhow!("Attachment State path `{path}` is missing or inaccessible"))?;
        let references = crate::module::artifact::references(value)?;
        if references.is_empty() {
            bail!("Attachment State path `{path}` contains no files");
        }
        for reference in references {
            if !selected.contains(&reference) {
                selected.push(reference);
            }
        }
    }
    let mut total = 0u64;
    let mut parts = Vec::new();
    for reference in selected {
        let supported = match reference.mime_type.as_str() {
            "image/png" | "image/jpeg" | "image/webp" | "image/gif" => matches!(
                provider,
                ModelProvider::Gemini
                    | ModelProvider::OpenAi
                    | ModelProvider::OpenAiStrict
                    | ModelProvider::Anthropic
                    | ModelProvider::Ollama
            ),
            "application/pdf" => matches!(provider, ModelProvider::Gemini),
            _ => false,
        };
        if !supported {
            bail!(
                "Model adapter does not support attachment type {}. Use a Process Node to extract text or frames first.",
                reference.mime_type
            );
        }
        total += reference.size;
        if total > 20 * 1024 * 1024 {
            bail!("Model attachments exceed the 20 MiB request limit");
        }
        let data = std::fs::read(store.resolve(&reference)?)?;
        parts.push(Part::inline_data(reference.mime_type, data));
    }
    Ok(parts)
}

#[cfg(test)]
mod attachment_tests {
    use super::*;
    #[test]
    fn attachment_paths_use_only_visible_input_and_enforce_adapter_support() {
        let temp = tempfile::tempdir().unwrap();
        let store = crate::module::artifact::ArtifactStore::new(temp.path().join("store"));
        let reference = store.save_bytes("report.pdf", b"%PDF-report").unwrap();
        let input = json!({"document": reference});
        assert!(
            attachment_parts(
                &store,
                &input,
                &["document".into()],
                &crate::config::ModelProvider::Gemini
            )
            .is_ok()
        );
        assert!(
            attachment_parts(
                &store,
                &input,
                &["document".into()],
                &crate::config::ModelProvider::OpenAi
            )
            .is_err()
        );
        assert!(
            attachment_parts(
                &store,
                &input,
                &["private".into()],
                &crate::config::ModelProvider::Gemini
            )
            .is_err()
        );
        assert!(
            attachment_parts(
                &store,
                &json!({"document":"[SENSITIVE REDACTED]"}),
                &["document".into()],
                &crate::config::ModelProvider::Gemini
            )
            .is_err()
        );
    }
}

#[cfg(test)]
mod conversation_thinking_tests {
    use super::conversation_thinking_config;
    #[test]
    fn flash_lite_chat_requests_thinking_in_addition_to_summaries() {
        let lite = serde_json::to_value(conversation_thinking_config("gemini-3.5-flash-lite")).unwrap();
        assert_eq!(lite["includeThoughts"], true);
        assert_eq!(lite["thinkingLevel"], "medium");
        let pro = serde_json::to_value(conversation_thinking_config("gemini-3.1-pro-preview")).unwrap();
        assert_eq!(pro["includeThoughts"], true);
        assert!(pro.get("thinkingLevel").is_none_or(serde_json::Value::is_null));
    }
}
