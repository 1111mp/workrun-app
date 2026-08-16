//! Persistent configuration and lifecycle management for local stdio MCP servers.

use crate::{
    config::{deserialize_encrypted, serialize_encrypted, with_encryption},
    module::{
        process_node::ToolExecutionPolicy,
        tool_registry::{ToolDefinition, ToolRiskLevel, ToolSource},
    },
    utils::dirs,
};
use adk_rust::{
    ReadonlyContext,
    tool::{
        McpAuth, McpHttpClientBuilder, SimpleToolContext, Tool, Toolset,
        mcp::{McpServerConfig, McpServerManager, ServerStatus},
    },
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use rmcp::transport::auth::{AuthError, AuthorizationManager, CredentialStore, StoredCredentials};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
struct OAuthCredentialStore(Arc<tokio::sync::RwLock<Option<StoredCredentials>>>);

impl OAuthCredentialStore {
    fn from_credentials(credentials: StoredCredentials) -> Self {
        Self(Arc::new(tokio::sync::RwLock::new(Some(credentials))))
    }
}

#[async_trait::async_trait]
impl CredentialStore for OAuthCredentialStore {
    async fn load(&self) -> std::result::Result<Option<StoredCredentials>, AuthError> {
        Ok(self.0.read().await.clone())
    }

    async fn save(&self, credentials: StoredCredentials) -> std::result::Result<(), AuthError> {
        *self.0.write().await = Some(credentials);
        Ok(())
    }

    async fn clear(&self) -> std::result::Result<(), AuthError> {
        *self.0.write().await = None;
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerCatalog {
    #[serde(default)]
    pub servers: Vec<McpServerDefinition>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub transport: McpServerTransport,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: McpServerAuth,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_encrypted",
        deserialize_with = "deserialize_encrypted"
    )]
    pub bearer_token: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "serialize_encrypted",
        deserialize_with = "deserialize_encrypted"
    )]
    pub oauth_credentials: Option<StoredCredentials>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpServerAuth {
    #[default]
    None,
    Bearer,
    #[serde(rename = "oauth", alias = "o_auth")]
    OAuth,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpServerAuthorizationStatus {
    #[default]
    NotRequired,
    AuthorizationRequired,
    Authorizing,
    Authorized,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpServerTransport {
    #[default]
    Stdio,
    StreamableHttp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMcpServerRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub transport: McpServerTransport,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: McpServerAuth,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(serialize_with = "serialize_definition_for_frontend")]
    pub definition: McpServerDefinition,
    pub status: ServerStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServerFrontendDefinition<'a> {
    id: &'a str,
    name: &'a str,
    description: &'a str,
    transport: McpServerTransport,
    command: &'a str,
    args: &'a [String],
    url: &'a str,
    auth: McpServerAuth,
    authorization_status: McpServerAuthorizationStatus,
    enabled: bool,
    created_at: &'a str,
    updated_at: &'a str,
}

fn serialize_definition_for_frontend<S>(definition: &McpServerDefinition, serializer: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    McpServerFrontendDefinition {
        id: &definition.id,
        name: &definition.name,
        description: &definition.description,
        transport: definition.transport,
        command: &definition.command,
        args: &definition.args,
        url: &definition.url,
        auth: definition.auth,
        authorization_status: if definition.transport != McpServerTransport::StreamableHttp
            || definition.auth != McpServerAuth::OAuth
        {
            McpServerAuthorizationStatus::NotRequired
        } else if oauth_pending()
            .lock()
            .ok()
            .is_some_and(|pending| pending.contains(&definition.id))
        {
            McpServerAuthorizationStatus::Authorizing
        } else if definition.oauth_credentials.is_some() {
            McpServerAuthorizationStatus::Authorized
        } else {
            McpServerAuthorizationStatus::AuthorizationRequired
        },
        enabled: definition.enabled,
        created_at: &definition.created_at,
        updated_at: &definition.updated_at,
    }
    .serialize(serializer)
}

enum McpRuntime {
    Stdio(Arc<McpServerManager>),
    Http(Arc<dyn Toolset>),
}

static RUNTIMES: OnceLock<Mutex<HashMap<String, Arc<McpRuntime>>>> = OnceLock::new();
static OAUTH_PENDING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn runtimes() -> &'static Mutex<HashMap<String, Arc<McpRuntime>>> {
    RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn oauth_pending() -> &'static Mutex<HashSet<String>> {
    OAUTH_PENDING.get_or_init(|| Mutex::new(HashSet::new()))
}

pub struct McpServerRegistry;

impl McpServerRegistry {
    pub async fn list() -> Result<Vec<McpServer>> {
        let catalog = Self::read_catalog().await?;
        let mut servers = Vec::with_capacity(catalog.servers.len());
        for definition in catalog.servers {
            servers.push(McpServer {
                status: Self::status(&definition).await,
                definition,
            });
        }
        Ok(servers)
    }

    pub async fn create(request: CreateMcpServerRequest) -> Result<McpServer> {
        let now = Utc::now().to_rfc3339();
        let definition = McpServerDefinition {
            id: Uuid::now_v7().to_string(),
            name: request.name.trim().to_string(),
            description: request.description.trim().to_string(),
            transport: request.transport,
            command: request.command.trim().to_string(),
            args: request.args,
            url: request.url.trim().to_string(),
            auth: request.auth,
            bearer_token: request.bearer_token.filter(|token| !token.trim().is_empty()),
            oauth_credentials: None,
            enabled: request.enabled,
            created_at: now.clone(),
            updated_at: now,
        };
        validate_definition(&definition)?;
        let mut catalog = Self::read_catalog().await?;
        catalog.servers.push(definition.clone());
        Self::write_catalog(&catalog).await?;
        Ok(McpServer {
            status: ServerStatus::Stopped,
            definition,
        })
    }

    pub async fn update(mut definition: McpServerDefinition) -> Result<McpServer> {
        validate_definition(&definition)?;
        let mut catalog = Self::read_catalog().await?;
        let existing = catalog
            .servers
            .iter_mut()
            .find(|server| server.id == definition.id)
            .ok_or_else(|| anyhow::anyhow!("MCP Server is not in the catalog: {}", definition.id))?;
        // The API deliberately omits saved tokens when returning a definition.
        // Keep the existing token when an edit changes other fields but does not
        // supply a replacement.
        if definition.auth == McpServerAuth::Bearer && definition.bearer_token.is_none() {
            definition.bearer_token = existing.bearer_token.clone();
        }
        if definition.auth == McpServerAuth::OAuth && definition.oauth_credentials.is_none() {
            definition.oauth_credentials = existing.oauth_credentials.clone();
        }
        if definition.auth != McpServerAuth::Bearer {
            definition.bearer_token = None;
        }
        if definition.auth != McpServerAuth::OAuth {
            definition.oauth_credentials = None;
        }
        definition.created_at = existing.created_at.clone();
        definition.updated_at = Utc::now().to_rfc3339();
        *existing = definition.clone();
        Self::stop_runtime(&definition.id).await?;
        Self::write_catalog(&catalog).await?;
        Ok(McpServer {
            status: ServerStatus::Stopped,
            definition,
        })
    }

    pub async fn delete(id: &str) -> Result<()> {
        let mut catalog = Self::read_catalog().await?;
        let original_len = catalog.servers.len();
        catalog.servers.retain(|server| server.id != id);
        if catalog.servers.len() == original_len {
            bail!("MCP Server is not in the catalog: {id}");
        }
        Self::stop_runtime(id).await?;
        Self::write_catalog(&catalog).await
    }

    pub async fn start(id: &str) -> Result<McpServer> {
        let definition = Self::definition(id).await?;
        if !definition.enabled {
            bail!("MCP Server `{}` is disabled", definition.name);
        }
        let runtime = Self::runtime(&definition).await?;
        Self::start_runtime(&runtime, &definition.id).await?;
        Ok(McpServer {
            status: Self::runtime_status(&runtime, &definition.id).await?,
            definition,
        })
    }

    pub async fn stop(id: &str) -> Result<McpServer> {
        let definition = Self::definition(id).await?;
        Self::stop_runtime(id).await?;
        Ok(McpServer {
            status: ServerStatus::Stopped,
            definition,
        })
    }

    /// Starts the OAuth authorization-code flow for a remote MCP server. The
    /// callback listener is local-only and accepts exactly one redirect.
    pub async fn authorize(id: &str) -> Result<()> {
        let definition = Self::definition(id).await?;
        if definition.transport != McpServerTransport::StreamableHttp || definition.auth != McpServerAuth::OAuth {
            bail!("MCP Server `{}` does not use OAuth", definition.name);
        }
        if !oauth_pending()
            .lock()
            .map_err(|_| anyhow::anyhow!("OAuth authorization registry is unavailable"))?
            .insert(definition.id.clone())
        {
            bail!("OAuth authorization is already in progress for `{}`", definition.name);
        }

        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) => {
                let _ = oauth_pending().lock().map(|mut pending| pending.remove(&definition.id));
                return Err(error).context("failed to start the local OAuth callback listener");
            },
        };
        let redirect_uri = format!("http://{}/oauth/callback", listener.local_addr()?);
        let manager = AuthorizationManager::new(&definition.url)
            .await
            .map_err(|error| anyhow::anyhow!("OAuth setup failed: {error}"))?;
        let store = OAuthCredentialStore(Arc::new(tokio::sync::RwLock::new(None)));
        let mut manager = manager;
        manager.set_credential_store(store.clone());
        let metadata = manager
            .discover_metadata()
            .await
            .map_err(|error| anyhow::anyhow!("OAuth metadata discovery failed: {error}"))?;
        manager.set_metadata(metadata);
        let session =
            rmcp::transport::auth::AuthorizationSession::new(manager, &[], &redirect_uri, Some("Workrun"), None)
                .await
                .map_err(|error| anyhow::anyhow!("OAuth authorization setup failed: {error}"))?;
        let authorization_url = session.get_authorization_url().to_string();
        open::that(&authorization_url).context("failed to open the OAuth authorization page")?;

        tokio::spawn(async move {
            let outcome = async {
                let (mut stream, _) = tokio::time::timeout(std::time::Duration::from_secs(300), listener.accept())
                    .await
                    .context("OAuth authorization timed out")??;
                let mut request = vec![0; 8192];
                let count = stream.read(&mut request).await?;
                let request = std::str::from_utf8(&request[..count]).context("OAuth callback is not valid UTF-8")?;
                let target = request.split_whitespace().nth(1).context("OAuth callback request is invalid")?;
                let callback = Url::parse(&format!("http://localhost{target}"))?;
                let code = callback.query_pairs().find(|(key, _)| key == "code").map(|(_, value)| value.into_owned());
                let state = callback.query_pairs().find(|(key, _)| key == "state").map(|(_, value)| value.into_owned());
                let result = match (code, state) {
                    (Some(code), Some(state)) => session.handle_callback(&code, &state).await.map_err(|error| anyhow::anyhow!("OAuth authorization failed: {error}")),
                    _ => bail!("OAuth authorization was denied or returned an invalid callback"),
                };
                let response = if result.is_ok() { "Authorization complete. You can return to Workrun." } else { "Authorization failed. You can close this page and try again in Workrun." };
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await?;
                result?;
                let credentials = store.load().await.map_err(|error| anyhow::anyhow!("OAuth credential storage failed: {error}"))?
                    .context("OAuth authorization did not return credentials")?;
                Self::store_oauth_credentials(&definition.id, credentials).await
            }.await;
            if let Err(error) = outcome {
                log::warn!("OAuth authorization for MCP Server {} failed: {error:#}", definition.id);
            }
            let _ = oauth_pending().lock().map(|mut pending| pending.remove(&definition.id));
        });
        Ok(())
    }

    /// Gracefully stop every local MCP server owned by this application.
    pub async fn shutdown_all() -> Result<()> {
        let active = std::mem::take(
            &mut *runtimes()
                .lock()
                .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?,
        );
        for runtime in active.into_values() {
            Self::shutdown_runtime(runtime).await?;
        }
        Ok(())
    }

    /// Discover the tools currently advertised by running MCP servers.
    /// Stopped, disabled, and temporarily unreachable servers are omitted so
    /// Agents cannot persist a selection that is not presently usable.
    pub async fn list_tool_definitions() -> Result<Vec<ToolDefinition>> {
        let catalog = Self::read_catalog().await?;
        let context: Arc<dyn ReadonlyContext> = Arc::new(SimpleToolContext::new("mcp-discovery"));
        let mut definitions = Vec::new();

        for server in catalog.servers {
            let manager = runtimes()
                .lock()
                .ok()
                .and_then(|active| active.get(&server.id).cloned());
            let Some(manager) = manager else { continue };
            if Self::runtime_status(&manager, &server.id)
                .await
                .unwrap_or(ServerStatus::Stopped)
                != ServerStatus::Running
            {
                continue;
            }

            let Ok(tools) = Self::runtime_tools(&manager, Arc::clone(&context)).await else {
                continue;
            };
            definitions.extend(tools.into_iter().map(|tool| tool_definition(&server, tool)));
        }
        Ok(definitions)
    }

    /// Start an enabled server if necessary and resolve one of its currently
    /// advertised tools. A workflow stores the stable `mcp:<server>:<tool>` id,
    /// so discovery is repeated here to avoid executing a stale declaration.
    pub async fn resolve_tool(id: &str) -> Result<(ToolDefinition, Arc<dyn Tool>)> {
        let (server_id, tool_name) = parse_tool_id(id)?;
        let server = Self::definition(server_id).await?;
        if !server.enabled {
            bail!("MCP Server `{}` is disabled", server.name);
        }
        let manager = Self::runtime(&server).await?;
        if Self::runtime_status(&manager, server_id).await? != ServerStatus::Running {
            Self::start_runtime(&manager, server_id).await?;
        }
        let context: Arc<dyn ReadonlyContext> = Arc::new(SimpleToolContext::new("mcp-tool-resolution"));
        let tool = Self::runtime_tools(&manager, context)
            .await?
            .into_iter()
            .find(|tool| tool.name() == tool_name)
            .ok_or_else(|| anyhow::anyhow!("MCP Server `{}` does not advertise Tool `{tool_name}`", server.name))?;
        Ok((tool_definition(&server, Arc::clone(&tool)), tool))
    }

    async fn definition(id: &str) -> Result<McpServerDefinition> {
        validate_id(id)?;
        Self::read_catalog()
            .await?
            .servers
            .into_iter()
            .find(|server| server.id == id)
            .ok_or_else(|| anyhow::anyhow!("MCP Server is not in the catalog: {id}"))
    }

    async fn runtime(definition: &McpServerDefinition) -> Result<Arc<McpRuntime>> {
        if let Some(runtime) = runtimes()
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?
            .get(&definition.id)
            .cloned()
        {
            return Ok(runtime);
        }
        let runtime = match definition.transport {
            McpServerTransport::Stdio => {
                let config = McpServerConfig {
                    command: definition.command.clone(),
                    args: definition.args.clone(),
                    env: HashMap::new(),
                    disabled: !definition.enabled,
                    auto_approve: Vec::new(),
                    restart_policy: None,
                };
                let manager = Arc::new(McpServerManager::new(HashMap::from([(definition.id.clone(), config)])));
                manager.start_monitoring();
                Arc::new(McpRuntime::Stdio(manager))
            },
            McpServerTransport::StreamableHttp => {
                let builder = McpHttpClientBuilder::new(&definition.url);
                let builder = match definition.auth {
                    McpServerAuth::None => builder,
                    McpServerAuth::Bearer => {
                        builder.with_auth(McpAuth::bearer(definition.bearer_token.as_deref().ok_or_else(
                            || anyhow::anyhow!("MCP Server `{}` needs a Bearer Token", definition.name),
                        )?))
                    },
                    McpServerAuth::OAuth => {
                        builder.with_auth(McpAuth::bearer(Self::oauth_access_token(definition).await?))
                    },
                };
                let toolset = match tokio::time::timeout(std::time::Duration::from_secs(30), builder.connect()).await {
                    Ok(Ok(toolset)) => toolset,
                    Ok(Err(error)) => {
                        let details = format!("{error:?}");
                        if details.contains("AuthRequired") || details.contains("Auth required") {
                            bail!(
                                "MCP Server `{}` requires authentication. Configure a Bearer Token before starting it",
                                definition.name
                            );
                        }
                        bail!("MCP Server `{}` connection failed: {details}", definition.name);
                    },
                    Err(_) => bail!("MCP Server `{}` connection timed out after 30 seconds", definition.name),
                };
                Arc::new(McpRuntime::Http(Arc::new(toolset)))
            },
        };
        let mut active = runtimes()
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?;
        Ok(Arc::clone(active.entry(definition.id.clone()).or_insert(runtime)))
    }

    async fn stop_runtime(id: &str) -> Result<()> {
        let manager = runtimes()
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?
            .remove(id);
        if let Some(runtime) = manager {
            Self::shutdown_runtime(runtime).await?;
        }
        Ok(())
    }

    async fn status(definition: &McpServerDefinition) -> ServerStatus {
        let manager = runtimes()
            .lock()
            .ok()
            .and_then(|active| active.get(&definition.id).cloned());
        match manager {
            Some(manager) => Self::runtime_status(&manager, &definition.id)
                .await
                .unwrap_or(ServerStatus::Stopped),
            None if !definition.enabled => ServerStatus::Disabled,
            None => ServerStatus::Stopped,
        }
    }

    async fn start_runtime(runtime: &McpRuntime, id: &str) -> Result<()> {
        if let McpRuntime::Stdio(manager) = runtime {
            manager.start_server(id).await?;
        }
        Ok(())
    }

    async fn runtime_status(runtime: &McpRuntime, id: &str) -> Result<ServerStatus> {
        match runtime {
            McpRuntime::Stdio(manager) => Ok(manager.server_status(id).await?),
            McpRuntime::Http(_) => Ok(ServerStatus::Running),
        }
    }

    async fn runtime_tools(runtime: &McpRuntime, context: Arc<dyn ReadonlyContext>) -> Result<Vec<Arc<dyn Tool>>> {
        match runtime {
            McpRuntime::Stdio(manager) => Ok(manager.tools(context).await?),
            McpRuntime::Http(toolset) => Ok(toolset.tools(context).await?),
        }
    }

    async fn shutdown_runtime(runtime: Arc<McpRuntime>) -> Result<()> {
        if let McpRuntime::Stdio(manager) = runtime.as_ref() {
            manager.shutdown().await?;
        }
        Ok(())
    }

    async fn read_catalog() -> Result<McpServerCatalog> {
        let path = dirs::mcp_server_catalog_path()?;
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(McpServerCatalog::default()),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to read MCP Server catalog {}", path.display()));
            },
        };
        let encrypted = with_encryption(|| async { serde_json::from_slice::<McpServerCatalog>(&bytes) }).await;
        let (catalog, migrated_from_plaintext) = match encrypted {
            Ok(catalog) => (catalog, false),
            Err(encrypted_error) => {
                let catalog = serde_json::from_slice::<McpServerCatalog>(&bytes).with_context(|| {
                    format!(
                        "invalid MCP Server catalog {} (encrypted read also failed: {encrypted_error})",
                        path.display()
                    )
                })?;
                (catalog, true)
            },
        };
        validate_catalog(&catalog)?;
        if migrated_from_plaintext {
            log::warn!("Migrating plaintext MCP Server credentials to encrypted storage");
            Self::write_catalog(&catalog).await?;
        }
        Ok(catalog)
    }

    async fn write_catalog(catalog: &McpServerCatalog) -> Result<()> {
        validate_catalog(catalog)?;
        let path = dirs::mcp_server_catalog_path()?;
        let parent = path.parent().context("MCP Server catalog has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let bytes = with_encryption(|| async { serde_json::to_vec_pretty(catalog) }).await?;
        tokio::fs::write(&path, bytes)
            .await
            .with_context(|| format!("failed to write MCP Server catalog {}", path.display()))
    }

    async fn store_oauth_credentials(id: &str, credentials: StoredCredentials) -> Result<()> {
        let mut catalog = Self::read_catalog().await?;
        let definition = catalog
            .servers
            .iter_mut()
            .find(|server| server.id == id)
            .ok_or_else(|| anyhow::anyhow!("MCP Server is not in the catalog: {id}"))?;
        definition.oauth_credentials = Some(credentials);
        definition.updated_at = Utc::now().to_rfc3339();
        Self::stop_runtime(id).await?;
        Self::write_catalog(&catalog).await
    }

    async fn oauth_access_token(definition: &McpServerDefinition) -> Result<String> {
        let credentials = definition
            .oauth_credentials
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("MCP Server `{}` needs OAuth authorization", definition.name))?;
        let mut manager = AuthorizationManager::new(&definition.url)
            .await
            .map_err(|error| anyhow::anyhow!("OAuth setup failed: {error}"))?;
        let store = OAuthCredentialStore::from_credentials(credentials.clone());
        manager.set_credential_store(store.clone());
        if !manager
            .initialize_from_store()
            .await
            .map_err(|error| anyhow::anyhow!("OAuth credential restoration failed: {error}"))?
        {
            bail!("MCP Server `{}` needs OAuth authorization", definition.name);
        }
        let access_token = manager
            .get_access_token()
            .await
            .map_err(|error| anyhow::anyhow!("OAuth token refresh failed: {error}"))?;
        if let Some(refreshed) = store
            .load()
            .await
            .map_err(|error| anyhow::anyhow!("OAuth credential storage failed: {error}"))?
        {
            if refreshed.token_received_at != credentials.token_received_at {
                Self::store_oauth_credentials(&definition.id, refreshed).await?;
            }
        }
        Ok(access_token)
    }
}

fn validate_catalog(catalog: &McpServerCatalog) -> Result<()> {
    let mut ids = HashSet::new();
    for definition in &catalog.servers {
        validate_definition(definition)?;
        if !ids.insert(&definition.id) {
            bail!("MCP Server catalog contains duplicate id {:?}", definition.id);
        }
    }
    Ok(())
}

fn validate_definition(definition: &McpServerDefinition) -> Result<()> {
    validate_id(&definition.id)?;
    if definition.name.trim().is_empty() {
        bail!("MCP Server name must not be empty");
    }
    match definition.transport {
        McpServerTransport::Stdio => {
            if definition.command.trim().is_empty() {
                bail!("stdio MCP Server command must not be empty");
            }
            if definition.args.iter().any(|argument| argument.contains('\0')) {
                bail!("MCP Server arguments must not contain null bytes");
            }
        },
        McpServerTransport::StreamableHttp => {
            let url = definition.url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                bail!("Streamable HTTP MCP Server URL must start with http:// or https://");
            }
        },
    }
    Ok(())
}

fn validate_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).with_context(|| format!("MCP Server id must be a UUID, got {id:?}"))?;
    if uuid.hyphenated().to_string() != id {
        bail!("MCP Server id must be a lowercase, hyphenated UUID");
    }
    Ok(())
}

fn parse_tool_id(id: &str) -> Result<(&str, &str)> {
    let (server_id, tool_name) = id
        .strip_prefix("mcp:")
        .and_then(|value| value.split_once(':'))
        .ok_or_else(|| anyhow::anyhow!("MCP Tool id is invalid: {id}"))?;
    if tool_name.is_empty() {
        bail!("MCP Tool id is invalid: {id}");
    }
    Ok((server_id, tool_name))
}

fn tool_definition(server: &McpServerDefinition, tool: Arc<dyn Tool>) -> ToolDefinition {
    ToolDefinition {
        id: format!("mcp:{}:{}", server.id, tool.name()),
        source: ToolSource::Mcp,
        source_id: Some(server.id.clone()),
        source_name: Some(server.name.clone()),
        display_name: tool.name().to_string(),
        // MCP only guarantees uniqueness within one server. Agent tool names
        // must remain unambiguous when two selected servers expose `search`.
        name: format!("mcp_{}_{}", server.id.replace('-', ""), tool.name().replace('-', "_")),
        description: tool.description().to_string(),
        version: "mcp".to_string(),
        input_schema: tool
            .parameters_schema()
            .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
        output_schema: tool.response_schema().unwrap_or_else(|| serde_json::json!({})),
        risk_level: if tool.is_read_only() {
            ToolRiskLevel::Low
        } else {
            ToolRiskLevel::High
        },
        permissions: Vec::new(),
        execution_policy: ToolExecutionPolicy::AskEveryTime,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::ToolContext;
    use serde_json::Value;

    struct TestTool {
        name: String,
    }

    #[async_trait::async_trait]
    impl Tool for TestTool {
        fn name(&self) -> &str {
            &self.name
        }

        fn description(&self) -> &str {
            "Test MCP Tool"
        }

        async fn execute(&self, _context: Arc<dyn ToolContext>, _args: Value) -> adk_rust::Result<Value> {
            Ok(serde_json::json!({}))
        }
    }

    fn definition() -> McpServerDefinition {
        McpServerDefinition {
            id: "019b812d-4958-7d37-8a45-47e1e20a4744".into(),
            name: "Everything".into(),
            description: "MCP test server".into(),
            transport: McpServerTransport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "@modelcontextprotocol/server-everything".into()],
            url: String::new(),
            auth: McpServerAuth::None,
            bearer_token: None,
            oauth_credentials: None,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn accepts_a_valid_stdio_server_definition() {
        assert!(validate_definition(&definition()).is_ok());
    }

    #[test]
    fn accepts_a_valid_streamable_http_server_definition() {
        let mut server = definition();
        server.transport = McpServerTransport::StreamableHttp;
        server.command.clear();
        server.args.clear();
        server.url = "https://example.com/mcp".into();
        assert!(validate_definition(&server).is_ok());
    }

    #[test]
    fn serializes_oauth_auth_with_a_stable_wire_value() {
        assert_eq!(serde_json::to_string(&McpServerAuth::OAuth).unwrap(), "\"oauth\"");
        assert_eq!(
            serde_json::from_str::<McpServerAuth>("\"oauth\"").unwrap(),
            McpServerAuth::OAuth
        );
        assert_eq!(
            serde_json::from_str::<McpServerAuth>("\"o_auth\"").unwrap(),
            McpServerAuth::OAuth
        );
    }

    #[test]
    fn catalog_rejects_duplicate_server_ids() {
        let definition = definition();
        assert!(
            validate_catalog(&McpServerCatalog {
                servers: vec![definition.clone(), definition],
            })
            .is_err()
        );
    }

    #[test]
    fn parses_stable_mcp_tool_ids() {
        assert_eq!(
            parse_tool_id("mcp:019b812d-4958-7d37-8a45-47e1e20a4744:echo").unwrap(),
            ("019b812d-4958-7d37-8a45-47e1e20a4744", "echo")
        );
        assert!(parse_tool_id("echo").is_err());
        assert!(parse_tool_id("mcp:server:").is_err());
    }

    #[test]
    fn namespaces_model_tool_names_by_server() {
        let first = definition();
        let mut second = definition();
        second.id = "019b812d-4958-7d37-8a45-47e1e20a4745".into();
        let tool = || Arc::new(TestTool { name: "search".into() }) as Arc<dyn Tool>;

        let first_tool = tool_definition(&first, tool());
        let second_tool = tool_definition(&second, tool());

        assert_eq!(first_tool.id, format!("mcp:{}:search", first.id));
        assert_ne!(first_tool.name, second_tool.name);
        assert_eq!(first_tool.risk_level, ToolRiskLevel::High);
        assert_eq!(first_tool.execution_policy, ToolExecutionPolicy::AskEveryTime);
    }

    #[test]
    fn does_not_return_the_bearer_token_to_the_frontend() {
        let mut definition = definition();
        definition.bearer_token = Some("secret-token".into());
        let server = McpServer {
            definition,
            status: ServerStatus::Stopped,
        };

        assert!(
            serde_json::to_value(server).unwrap()["definition"]
                .get("bearerToken")
                .is_none()
        );
    }
}
