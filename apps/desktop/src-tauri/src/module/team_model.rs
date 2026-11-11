//! Workrun Server model access. Only Workrun session tokens enter this module.
use crate::config::{BaseConfig, IWorkrun, ModelDefinition, ModelProvider};
use adk_rust::{Llm, LlmRequest, LlmResponseStream, SchemaAdapter};
use anyhow::{Context, Result, bail, ensure};
use futures::StreamExt;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tauri_plugin_http::reqwest::{Client, Url, redirect::Policy};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ApiProtocol {
    ChatCompletions,
    Responses,
}

#[derive(Debug, Clone)]
pub(crate) struct ModelBinding {
    pub server: String,
    pub owner: String,
    pub protocol: ApiProtocol,
    pub effort_options: Vec<String>,
    pub tools: Option<bool>,
    pub structured_output: Option<bool>,
    pub vision: Option<bool>,
}

#[derive(Clone)]
struct Session {
    server: String,
    owner: String,
    token: String,
    cancel: CancellationToken,
}
struct AuthState {
    revision: u64,
    session: Option<Session>,
    pending: CancellationToken,
}
static WORKSPACE_READY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn workspace_ready() -> bool {
    WORKSPACE_READY.load(std::sync::atomic::Ordering::Acquire)
}

pub(crate) fn has_session() -> bool {
    AUTH.read().session.is_some()
}

pub(crate) fn finish_workspace_change(workspace: &str) -> Result<()> {
    let state = AUTH.read();
    ensure!(
        state.session.is_some() && crate::utils::dirs::active_workspace_id() == workspace,
        "Team account changed"
    );
    WORKSPACE_READY.store(true, std::sync::atomic::Ordering::Release);
    drop(state);
    crate::module::schedule::notify_scheduler();
    crate::module::run_manager::notify_supervisor();
    Ok(())
}

static AUTH: LazyLock<RwLock<AuthState>> = LazyLock::new(|| {
    RwLock::new(AuthState {
        revision: 0,
        session: None,
        pending: CancellationToken::new(),
    })
});
struct CachedCatalog {
    revision: u64,
    at: Instant,
    models: Vec<ModelDefinition>,
}
static CATALOG: LazyLock<RwLock<Option<CachedCatalog>>> = LazyLock::new(|| RwLock::new(None));

fn server_url(server: &str) -> Result<String> {
    let url = Url::parse(server.trim()).context("Invalid Workrun Server URL")?;
    ensure!(
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "Invalid Workrun Server URL"
    );
    Ok(url.to_string().trim_end_matches('/').to_owned())
}
fn http() -> Result<Client> {
    Ok(Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(20))
        .build()?)
}

/// Clear synchronously before verifying new credentials. The revision prevents a
/// slow login response from restoring a token after logout or another sign-in.
pub(crate) async fn set_session(server: String, token: Option<String>) -> Result<()> {
    let server = server_url(&server)?;
    let token = token.filter(|token| !token.is_empty());
    let (revision, cancel) = {
        let mut state = AUTH.write();
        if let (Some(current), Some(token)) = (&state.session, &token)
            && current.server == server
            && current.token == *token
        {
            return Ok(());
        }
        WORKSPACE_READY.store(false, std::sync::atomic::Ordering::Release);
        state.pending.cancel();
        if let Some(old) = state.session.take() {
            old.cancel.cancel();
        }
        state.revision += 1;
        state.pending = CancellationToken::new();
        *CATALOG.write() = None;
        (state.revision, state.pending.clone())
    };
    let Some(token) = token else {
        return Ok(());
    };
    let verify = async {
        let response = http()?
            .get(format!("{server}/api/v1/users/me"))
            .bearer_auth(&token)
            .send()
            .await?;
        ensure!(
            response.status().is_success(),
            "Sign in again to use team models (HTTP {})",
            response.status().as_u16()
        );
        let body: Value = response.json().await?;
        ensure!(body["errorCode"] == 0, "Workrun Server rejected the session");
        let owner = body["payload"]["user"]["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .context("Workrun Server returned no user identity")?
            .to_owned();
        Ok::<_, anyhow::Error>(owner)
    };
    let owner =
        tokio::select! { result = verify => result?, _ = cancel.cancelled() => bail!("Team authentication changed") };
    let mut state = AUTH.write();
    ensure!(
        state.revision == revision && !cancel.is_cancelled(),
        "Team authentication changed"
    );
    if crate::utils::dirs::is_team_workspace() {
        crate::utils::dirs::initialize_active_workspace_scope(crate::utils::dirs::team_account_scope(&server, &owner));
    }
    state.session = Some(Session {
        server,
        owner,
        token,
        cancel,
    });
    Ok(())
}

fn current(server: &str, owner: Option<&str>) -> Result<(u64, Session)> {
    if let Ok(expected) = EXPECTED_OWNER.try_with(Clone::clone) {
        let expected = expected.context("This team run has no original user; start a new run")?;
        ensure!(
            expected.server == server && owner.is_none_or(|owner| owner == expected.user_id),
            "Team run belongs to another user"
        );
        let state = AUTH.read();
        ensure!(
            state
                .session
                .as_ref()
                .is_some_and(|session| session.owner == expected.user_id),
            "Sign in with the original team run account"
        );
    }
    let state = AUTH.read();
    let session = state.session.as_ref().context("Sign in to use team models")?;
    ensure!(
        session.server == server && owner.is_none_or(|owner| session.owner == owner),
        "Team model belongs to another Server or user; sign in with the original account"
    );
    Ok((state.revision, session.clone()))
}

pub(crate) async fn catalog_for(config: &IWorkrun) -> Result<Vec<ModelDefinition>> {
    let server = server_url(
        &config
            .team
            .as_ref()
            .context("Team server is not configured")?
            .server_url,
    )?;
    let (revision, session) = current(&server, None)?;
    if let Some(cached) = CATALOG.read().as_ref()
        && cached.revision == revision
        && cached.at.elapsed() < Duration::from_secs(30)
    {
        return Ok(cached.models.clone());
    }
    let response = tokio::select! {
        response = http()?.get(format!("{server}/api/v1/llm/models")).bearer_auth(&session.token).send() => response?,
        _ = session.cancel.cancelled() => bail!("Team authentication changed"),
    };
    ensure!(
        response.status().is_success(),
        "Team model catalog unavailable (HTTP {}); check your sign-in and Server configuration",
        response.status().as_u16()
    );
    let body: Value = response.json().await?;
    let models = parse_catalog(body, &server, &session.owner)?;
    ensure!(AUTH.read().revision == revision, "Team authentication changed");
    *CATALOG.write() = Some(CachedCatalog {
        revision,
        at: Instant::now(),
        models: models.clone(),
    });
    Ok(models)
}

pub(crate) async fn active_catalog() -> Result<Vec<ModelDefinition>> {
    Ok(catalog_status(false).await.0)
}

pub(crate) async fn catalog_status(refresh: bool) -> (Vec<ModelDefinition>, Option<String>) {
    let mut models = crate::config::model_catalog();
    if !crate::utils::dirs::is_team_workspace() {
        return (models, None);
    }
    if refresh {
        *CATALOG.write() = None;
    }
    // Preserve diagnostics for Settings without disabling direct providers.
    match catalog_for(&BaseConfig::workrun().await.data_arc()).await {
        Ok(team_models) => {
            models.extend(team_models);
            (models, None)
        },
        Err(error) => (models, Some(error.to_string())),
    }
}

fn parse_catalog(body: Value, server: &str, owner: &str) -> Result<Vec<ModelDefinition>> {
    ensure!(body["object"] == "list", "Invalid team model catalog");
    let entries = body["data"].as_array().context("Invalid team model catalog")?;
    let scope = hex::encode(Sha256::digest(server.as_bytes()));
    let mut models = vec![];
    let mut ids = std::collections::HashSet::new();
    for entry in entries {
        let alias = entry["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .context("Invalid team model alias")?;
        ensure!(ids.insert(alias), "Duplicate team model alias");
        let protocols: Vec<ApiProtocol> = if entry.get("apiProtocols").is_some() {
            serde_json::from_value(entry["apiProtocols"].clone()).context("Unknown team model protocol")?
        } else {
            vec![ApiProtocol::ChatCompletions]
        };
        let capabilities = &entry["capabilities"];
        let effort_options: Vec<String> = capabilities["reasoningEfforts"]
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|value| matches!(*value, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"))
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        for protocol in protocols {
            let protocol_id = match protocol {
                ApiProtocol::ChatCompletions => "chat_completions",
                ApiProtocol::Responses => "responses",
            };
            models.push(ModelDefinition {
                id: format!("team/{scope}/{protocol_id}/{alias}"),
                name: format!("{} ({})", entry["name"].as_str().unwrap_or(alias), protocol_id),
                provider: ModelProvider::Team,
                model: alias.into(),
                team: Some(ModelBinding {
                    server: server.into(),
                    owner: owner.into(),
                    protocol,
                    effort_options: effort_options.clone(),
                    tools: capabilities["tools"].as_bool(),
                    structured_output: capabilities["structuredOutput"].as_bool(),
                    vision: capabilities["vision"].as_bool(),
                }),
            });
        }
    }
    Ok(models)
}

pub(crate) fn create_model(
    definition: &ModelDefinition,
    effort: Option<&str>,
    include_thoughts: bool,
) -> Result<Arc<dyn Llm>> {
    let binding = definition.team.clone().context("Missing team model binding")?;
    current(&binding.server, Some(&binding.owner))?;
    Ok(Arc::new(TeamModel {
        alias: definition.model.clone(),
        binding,
        effort: effort.map(str::to_owned),
        include_thoughts,
        workspace: crate::utils::dirs::active_workspace_id(),
    }))
}

struct TeamModel {
    alias: String,
    binding: ModelBinding,
    effort: Option<String>,
    include_thoughts: bool,
    workspace: String,
}
#[async_trait::async_trait]
impl Llm for TeamModel {
    fn name(&self) -> &str {
        &self.alias
    }
    fn schema_adapter(&self) -> &dyn SchemaAdapter {
        static ADAPTER: adk_rust::model::openai::OpenAiSchemaAdapter = adk_rust::model::openai::OpenAiSchemaAdapter;
        &ADAPTER
    }
    async fn generate_content(&self, mut request: LlmRequest, stream: bool) -> adk_rust::Result<LlmResponseStream> {
        use adk_rust::model::{
            RetryConfig,
            openai::{OpenAICompatible, OpenAICompatibleConfig, OpenAIResponsesClient, OpenAIResponsesConfig},
        };
        let failure = |error: anyhow::Error| adk_rust::AdkError::model(error.to_string());
        if self.workspace != crate::utils::dirs::active_workspace_id() {
            return Err(failure(anyhow::anyhow!("Model workspace changed")));
        }
        let (_, session) = current(&self.binding.server, Some(&self.binding.owner)).map_err(failure)?;
        if !request.tools.is_empty() && self.binding.tools == Some(false) {
            return Err(failure(anyhow::anyhow!("This team model does not support tools")));
        }
        if request
            .config
            .as_ref()
            .is_some_and(|config| config.response_schema.is_some())
            && self.binding.structured_output == Some(false)
        {
            return Err(failure(anyhow::anyhow!(
                "This team model does not support structured output"
            )));
        }
        request.previous_response_id = None;
        if self.binding.protocol == ApiProtocol::Responses {
            let config = request.config.get_or_insert_with(Default::default);
            let options = config.extensions.entry("openai").or_insert_with(|| json!({}));
            let options = options
                .as_object_mut()
                .ok_or_else(|| failure(anyhow::anyhow!("Invalid OpenAI options")))?;
            options.remove("previous_response_id");
            options.remove("conversation");
            options.remove("background");
            options.insert("include".into(), json!(["reasoning.encrypted_content"]));
        }
        if self.binding.protocol == ApiProtocol::Responses {
            for content in &mut request.contents {
                let has_reasoning = content.parts.iter().any(|part| matches!(part, adk_rust::Part::ServerToolCall { server_tool_call } if server_tool_call["type"] == "reasoning"));
                if has_reasoning {
                    // ADK also exposes the summary as Thinking. Replay the sealed
                    // item once, before its function calls, rather than fake text.
                    content
                        .parts
                        .retain(|part| !matches!(part, adk_rust::Part::Thinking { .. }));
                    content.parts.sort_by_key(|part| !matches!(part, adk_rust::Part::ServerToolCall { server_tool_call } if server_tool_call["type"] == "reasoning"));
                }
            }
        }
        let base = format!("{}/api/v1/llm", self.binding.server);
        // None means inherit the gateway/provider default, not an explicit effort.
        let effort: Option<adk_rust::model::openai::OpenAIReasoningEffort> = self
            .effort
            .as_ref()
            .map(|value| serde_json::from_value(json!(value)))
            .transpose()
            .map_err(|e| failure(e.into()))?;
        let model: Arc<dyn Llm> = match self.binding.protocol {
            ApiProtocol::ChatCompletions => {
                let config = OpenAICompatibleConfig::new(&session.token, &self.alias)
                    .with_base_url(&base)
                    .with_provider_name("workrun-team");
                Arc::new(
                    OpenAICompatible::new_with_reasoning_effort(config, effort)?
                        .with_retry_config(RetryConfig::disabled()),
                )
            },
            ApiProtocol::Responses => {
                let mut config = OpenAIResponsesConfig::new(&session.token, &self.alias)
                    .with_base_url(&base)
                    .with_open_responses_mode(true);
                if self.include_thoughts {
                    config = config.with_reasoning_summary(adk_rust::model::openai::ReasoningSummary::Auto);
                }
                let client = match effort {
                    Some(effort) => OpenAIResponsesClient::new_with_reasoning_effort(config, effort)?,
                    None => OpenAIResponsesClient::new(config)?,
                };
                Arc::new(client.with_retry_config(RetryConfig::disabled()))
            },
        };
        let cancel = session.cancel.clone();
        let mut responses = tokio::select! { result = model.generate_content(request, stream) => result?, _ = cancel.cancelled() => return Err(failure(anyhow::anyhow!("Team authentication changed"))) };
        Ok(Box::pin(async_stream::try_stream! {
            loop {
                let response = tokio::select! { result = responses.next() => result, _ = cancel.cancelled() => Some(Err(adk_rust::AdkError::model("Team authentication changed"))) };
                let Some(response) = response else { break; };
                yield response?;
            }
        }))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TeamOwner {
    pub server: String,
    pub user_id: String,
}
tokio::task_local! { static EXPECTED_OWNER: Option<TeamOwner>; }

pub(crate) fn owner_for(workspace: &str) -> Result<Option<TeamOwner>> {
    if !workspace.starts_with("team:") {
        return Ok(None);
    }
    if let Ok(owner) = EXPECTED_OWNER.try_with(Clone::clone) {
        // Server models validate this captured identity at dispatch. Direct
        // providers do not require a live Workrun Server session.
        return Ok(owner);
    }
    let state = AUTH.read();
    let Some(session) = state.session.as_ref() else {
        return Ok(None);
    };
    Ok(Some(TeamOwner {
        server: session.server.clone(),
        user_id: session.owner.clone(),
    }))
}

pub(crate) fn credential_workspace() -> String {
    EXPECTED_OWNER
        .try_with(|owner| match owner {
            Some(owner) => match crate::utils::dirs::team_account_scope(&owner.server, &owner.user_id) {
                crate::utils::dirs::WorkspaceScope::Team { account_key } => format!("team:{account_key}"),
                _ => unreachable!(),
            },
            None => "personal".into(),
        })
        .unwrap_or_else(|_| crate::utils::dirs::active_workspace_id())
}

pub(crate) fn with_owner<T>(
    owner: Option<TeamOwner>,
    future: impl std::future::Future<Output = T>,
) -> impl std::future::Future<Output = T> {
    // Box before building the scope future. An async wrapper would retain the
    // entire graph future inline, multiplying debug stack frames at each layer.
    EXPECTED_OWNER.scope(owner, Box::pin(future))
}

pub(crate) fn clear() {
    WORKSPACE_READY.store(false, std::sync::atomic::Ordering::Release);
    let mut state = AUTH.write();
    state.pending.cancel();
    if let Some(old) = state.session.take() {
        old.cancel.cancel();
    }
    state.revision += 1;
    *CATALOG.write() = None;
}

pub(crate) fn configured_server_changed(server: &str) -> bool {
    let state = AUTH.read();
    state
        .session
        .as_ref()
        .is_some_and(|session| server_url(server).map_or(true, |server| server != session.server))
}

/// Recipes store identity even if a later logout makes credentials unavailable.
/// Pure recipe construction never acquires or persists a session token.
pub(crate) fn stored_owner(workspace: &str) -> Option<TeamOwner> {
    if !workspace.starts_with("team:") {
        return None;
    }
    EXPECTED_OWNER.try_with(Clone::clone).unwrap_or_else(|_| {
        AUTH.read().session.as_ref().map(|session| TeamOwner {
            server: session.server.clone(),
            user_id: session.owner.clone(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::{Content, Part};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn directory() -> Value {
        json!({"object":"list","data":[{"id":"alias/custom","name":"Custom","apiProtocols":["chat_completions","responses"],"capabilities":{"tools":true,"structuredOutput":true,"reasoningEfforts":["none","minimal","low","medium","high","xhigh","max"]}}]})
    }

    #[test]
    fn catalog_namespaces_models_by_server_and_protocol_without_publishing_identity() {
        let a = parse_catalog(directory(), "https://a.example", "user-a").unwrap();
        let b = parse_catalog(directory(), "https://b.example", "user-b").unwrap();
        assert_eq!(a.len(), 2);
        assert_ne!(a[0].id, a[1].id);
        assert_ne!(a[0].id, b[0].id);
        assert_eq!(
            a[0].effort_options(),
            ["none", "minimal", "low", "medium", "high", "xhigh", "max"]
        );
        let public = serde_json::to_string(&a).unwrap();
        assert!(!public.contains("user-a"));
        assert!(!public.contains("a.example"));
        assert!(
            parse_catalog(
                json!({"object":"list","data":[{"id":"a","apiProtocols":["unknown"]}]}),
                "https://a.example",
                "user-a"
            )
            .is_err()
        );
        assert!(server_url("https://secret@example.com").is_err());
    }

    #[tokio::test]
    async fn authenticated_transports_refresh_and_account_boundaries() {
        tokio::time::timeout(Duration::from_secs(20), async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
            let captured = requests.clone();
            let server = tokio::spawn(async move {
                loop {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let captured = captured.clone();
                    tokio::spawn(async move {
                        let mut bytes = vec![];
                        let mut buffer = [0;4096];
                        let (headers, body) = loop {
                            let count = socket.read(&mut buffer).await.unwrap();
                            if count == 0 { return; }
                            bytes.extend_from_slice(&buffer[..count]);
                            if let Some(end) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                                let headers = String::from_utf8_lossy(&bytes[..end]).to_string();
                                let length = headers.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length:").map(|value| value.trim().parse::<usize>().unwrap())).unwrap_or(0);
                                if bytes.len() >= end + 4 + length {
                                    let body = if length > 0 { serde_json::from_slice(&bytes[end+4..end+4+length]).unwrap() } else { json!({}) };
                                    break (headers, body);
                                }
                            }
                        };
                        let path = headers.lines().next().unwrap().split_whitespace().nth(1).unwrap().to_owned();
                        let auth = headers.lines().find_map(|line| line.split_once(':').filter(|(name,_)| name.eq_ignore_ascii_case("authorization")).map(|(_,value)| value.trim().to_owned())).unwrap_or_default();
                        captured.lock().unwrap().push((path.clone(), auth.clone(), body.clone()));
                        if auth.contains("slow") { tokio::time::sleep(Duration::from_millis(100)).await; }
                        let payload = if path == "/api/v1/users/me" {
                            json!({"errorCode":0,"payload":{"user":{"id":if auth.contains("user-b") {"user-b"} else {"user-a"}}}})
                        } else if path == "/api/v1/llm/models" { directory() }
                        else if path == "/api/v1/llm/chat/completions" {
                            json!({"id":"chat-test","object":"chat.completion","created":1,"model":"alias/custom","choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}})
                        } else {
                            json!({"id":"resp-test","object":"response","created_at":1,"model":"alias/custom","status":"completed","output":[
                                {"id":"rs-test","type":"reasoning","summary":[{"type":"summary_text","text":"Thinking"}],"encrypted_content":"sealed-context"},
                                {"id":"fc-test","type":"function_call","call_id":"call-1","name":"lookup","arguments":"{\"value\":42}","status":"completed"}
                            ],"usage":{"input_tokens":4,"input_tokens_details":{"cached_tokens":0},"output_tokens":2,"output_tokens_details":{"reasoning_tokens":1},"total_tokens":6}})
                        };
                        if body["stream"] == true && path.ends_with("chat/completions") {
                            let data = "data: {\"id\":\"chunk\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"alias/custom\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"hello\"},\"finish_reason\":null}]}\n\n";
                            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n{data}").as_bytes()).await.unwrap();
                            tokio::time::sleep(Duration::from_millis(500)).await;
                            return;
                        }
                        let payload = payload.to_string();
                        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",payload.len()).as_bytes()).await.unwrap();
                    });
                }
            });
            set_session(base.clone(), Some("user-a-token-1".into())).await.unwrap();
            let config = IWorkrun { workspace_mode: Some(crate::config::WorkspaceMode::Team), team: Some(crate::config::TeamSettings { server_url: base.clone(), summary_model_id: None }), ..Default::default() };
            let definitions = catalog_for(&config).await.unwrap();
            let owner = owner_for("team:test").unwrap();
            let chat = crate::module::workflow::agent::create_model(&definitions[0], &config).unwrap();
            let mut unknown = definitions[1].clone();
            unknown.team.as_mut().unwrap().tools = None;
            let response = crate::module::workflow::agent::create_model_with_effort(&unknown, &config, true, Some("high")).unwrap();
            let request = LlmRequest::new("alias/custom", vec![Content::new("user").with_text("hello")]);
            let mut stream = chat.generate_content(request.clone(), false).await.unwrap();
            assert_eq!(stream.next().await.unwrap().unwrap().usage_metadata.unwrap().total_token_count, 6);
            for definition in &definitions {
                for effort in [None, Some("none"), Some("minimal"), Some("low"), Some("medium"), Some("high"), Some("xhigh"), Some("max")] {
                    let model = crate::module::workflow::agent::create_model_with_effort(definition, &config, false, effort).unwrap();
                    let mut stream = model.generate_content(request.clone(), false).await.unwrap();
                    assert!(stream.next().await.unwrap().is_ok());
                    let captured = requests.lock().unwrap().last().unwrap().2.clone();
                    let sent_effort = if definition.team.as_ref().unwrap().protocol == ApiProtocol::Responses {
                        captured.get("reasoning").and_then(|value| value.get("effort"))
                    } else { captured.get("reasoning_effort") };
                    assert_eq!(sent_effort.and_then(Value::as_str), effort);
                    if effort.is_none() { assert!(sent_effort.is_none(), "default must omit effort, not send null"); }
                }
            }
            let mut tools = request.clone();
            tools.tools.insert("lookup".into(), json!({"name":"lookup","parameters":{"type":"object","properties":{"value":{"type":"integer"}}}}));
            let mut unsupported = definitions[1].clone();
            unsupported.team.as_mut().unwrap().tools = Some(false);
            let blocked = crate::module::workflow::agent::create_model(&unsupported, &config).unwrap();
            assert!(blocked.generate_content(tools.clone(), false).await.is_err());
            let mut stream = response.generate_content(tools, false).await.unwrap();
            let result = stream.next().await.unwrap().unwrap();
            assert!(result.content.as_ref().unwrap().parts.iter().any(|part| matches!(part, Part::FunctionCall { id: Some(id), .. } if id == "call-1")));
            assert!(result.provider_metadata.as_ref().unwrap()["openai"]["conversation_history_parts"].to_string().contains("sealed-context"));
            let mut history = result.content.clone().unwrap();
            for part in result.provider_metadata.as_ref().unwrap()["openai"]["conversation_history_parts"].as_array().unwrap() {
                history.parts.push(serde_json::from_value(part.clone()).unwrap());
            }
            let tool_result: Content = serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{"name":"lookup","response":{"answer":42}},"id":"call-1"}]})).unwrap();
            let mut followup = LlmRequest::new("alias/custom", vec![history, tool_result]);
            followup.previous_response_id = Some("old-provider-id".into());
            followup.config = Some(adk_rust::GenerateContentConfig { extensions: serde_json::from_value(json!({"openai":{"previous_response_id":"old-provider-id"}})).unwrap(), ..Default::default() });
            let mut stream = response.generate_content(followup, false).await.unwrap();
            assert!(stream.next().await.unwrap().is_ok());
            let replay = requests.lock().unwrap().iter().rev().find(|(path,_,_)| path.ends_with("/responses")).unwrap().2.clone();
            assert_eq!(replay["input"][0]["type"], "reasoning");
            assert_eq!(replay["input"][0]["encrypted_content"], "sealed-context");
            assert!(replay["input"].as_array().unwrap().iter().any(|item| item["type"] == "function_call_output" && item["call_id"] == "call-1"));
            assert!(replay.get("previous_response_id").is_none());
            set_session(base.clone(), Some("user-a-token-2".into())).await.unwrap();
            let mut stream = chat.generate_content(request.clone(), false).await.unwrap();
            assert!(stream.next().await.unwrap().is_ok());
            let captured = requests.lock().unwrap().clone();
            assert!(captured.iter().any(|(path,auth,_)| path.ends_with("chat/completions") && auth == "Bearer user-a-token-2"));
            let sent = &captured.iter().find(|(path,_,body)| path.ends_with("/responses") && body["reasoning"]["effort"] == "high" && body.get("tools").is_some()).unwrap().2;
            assert_eq!(sent["reasoning"]["effort"], "high");
            assert_eq!(sent["include"], json!(["reasoning.encrypted_content"]));
            assert!(sent.get("previous_response_id").is_none());
            let mut stream = chat.generate_content(request.clone(), true).await.unwrap();
            assert!(stream.next().await.unwrap().is_ok());
            set_session(base.clone(), None).await.unwrap();
            assert!(stream.next().await.unwrap().is_err());
            assert!(chat.generate_content(request.clone(), false).await.is_err());
            set_session(base.clone(), Some("user-b-token".into())).await.unwrap();
            assert!(chat.generate_content(request.clone(), false).await.is_err());
            assert!(with_owner(owner, catalog_for(&config)).await.is_err());
            let direct = crate::config::model_catalog().into_iter().find(|model| model.provider == ModelProvider::Ollama).unwrap();
            assert!(crate::module::workflow::agent::create_model(&direct, &config).is_ok());
            clear();
            let slow_base = base.clone();
            let pending = tokio::spawn(async move { set_session(slow_base, Some("slow-user-a-token".into())).await });
            tokio::time::sleep(Duration::from_millis(20)).await;
            set_session(base.clone(), None).await.unwrap();
            assert!(pending.await.unwrap().is_err());
            assert!(current(&base, None).is_err());
            server.abort();
        }).await.unwrap();
    }
}
