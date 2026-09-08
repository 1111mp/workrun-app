use super::{
    McpRuntime, McpServer, McpServerAuth, McpServerConnectionTest, McpServerHealth, McpServerRuntimeStore,
    McpServerTransport, McpServerWorkflowReference, OAuthCredentialStore, stdio_restart_policy, tool_definition,
    validate_definition, validate_id, workflow_uses_mcp_server,
};
use crate::{
    config::IMcpServer,
    feat::{self, TestMcpServerConnectionRequest},
    module::tool_registry::ToolDefinition,
};
use adk_rust::{
    ReadonlyContext,
    tool::{
        McpAuth, McpHttpClientBuilder, SimpleToolContext, Tool, Toolset,
        mcp::{
            McpServerConfig, McpServerManager, ServerStatus,
            rmcp::{
                self,
                transport::auth::{AuthorizationManager, AuthorizationRequest, CredentialStore},
            },
        },
    },
};
use anyhow::{Context, Result, bail};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use url::Url;
use uuid::Uuid;

pub struct McpServerRegistry;

impl McpServerRegistry {
    /// Adds process-local runtime state without reading or changing persisted configuration.
    pub async fn describe(definition: IMcpServer) -> McpServer {
        let status = Self::status(&definition).await;
        if status == ServerStatus::Crashed {
            Self::record_health_error_if_absent(
                &definition.id,
                "MCP process exited unexpectedly; automatic restart is pending.".into(),
            );
        } else if status == ServerStatus::FailedToStart {
            Self::record_health_error_if_absent(
                &definition.id,
                "MCP process stopped after automatic restart attempts.".into(),
            );
        }
        McpServer {
            health: Self::health(&definition.id),
            status,
            definition,
        }
    }

    pub async fn test_connection(
        request: TestMcpServerConnectionRequest,
        existing: Option<IMcpServer>,
    ) -> Result<McpServerConnectionTest> {
        let bearer_token = if request.auth == McpServerAuth::Bearer {
            request
                .bearer_token
                .or_else(|| existing.as_ref().and_then(|server| server.bearer_token.clone()))
        } else {
            None
        };
        let oauth_credentials = if request.auth == McpServerAuth::OAuth {
            existing.as_ref().and_then(|server| server.oauth_credentials.clone())
        } else {
            None
        };
        let definition = IMcpServer {
            id: Uuid::now_v7().to_string(),
            name: request.name.trim().to_string(),
            description: String::new(),
            transport: request.transport,
            command: request.command.trim().to_string(),
            args: request.args,
            env: request.env,
            url: request.url.trim().to_string(),
            auth: request.auth,
            bearer_token,
            oauth_credentials,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        validate_definition(&definition)?;
        let runtime = match Self::runtime(&definition).await {
            Ok(runtime) => runtime,
            Err(error) => {
                if let Some(id) = request.id.as_deref() {
                    Self::record_health_error(id, error.to_string());
                }
                return Err(error);
            },
        };
        let result = async {
            Self::start_runtime(&runtime, &definition.id).await?;
            let context: Arc<dyn ReadonlyContext> = Arc::new(SimpleToolContext::new("mcp-connection-test"));
            let mut tool_names = Self::runtime_tools(&runtime, context)
                .await?
                .into_iter()
                .map(|tool| tool.name().to_string())
                .collect::<Vec<_>>();
            tool_names.sort();
            Ok(McpServerConnectionTest { tool_names })
        }
        .await;
        Self::stop_runtime(&definition.id).await?;
        if let Some(id) = request.id.as_deref() {
            Self::record_health(id, &result);
        }
        result
    }

    pub async fn workflow_references(id: &str) -> Result<Vec<McpServerWorkflowReference>> {
        validate_id(id)?;
        let prefix = format!("mcp:{id}:");
        Ok(feat::get_workflows()
            .await?
            .into_iter()
            .filter(|workflow| workflow_uses_mcp_server(&workflow.document, &prefix))
            .map(|workflow| McpServerWorkflowReference {
                id: workflow.id,
                name: workflow
                    .document
                    .pointer("/settings/name")
                    .and_then(serde_json::Value::as_str)
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or("Untitled workflow")
                    .to_string(),
            })
            .collect())
    }

    pub async fn start(definition: IMcpServer) -> Result<McpServer> {
        if !definition.enabled {
            bail!("MCP Server `{}` is disabled", definition.name);
        }
        let runtime = match Self::runtime(&definition).await {
            Ok(runtime) => runtime,
            Err(error) => {
                Self::record_health_error(&definition.id, error.to_string());
                return Err(error);
            },
        };
        if let Err(error) = Self::start_runtime(&runtime, &definition.id).await {
            Self::record_health_error(&definition.id, error.to_string());
            return Err(error);
        }
        Self::record_health_success(&definition.id, None);
        Ok(McpServer {
            status: Self::runtime_status(&runtime, &definition.id).await?,
            health: Self::health(&definition.id),
            definition,
        })
    }

    pub async fn stop(definition: IMcpServer) -> Result<McpServer> {
        Self::stop_runtime(&definition.id).await?;
        Ok(McpServer {
            status: ServerStatus::Stopped,
            health: Self::health(&definition.id),
            definition,
        })
    }

    pub async fn reconnect(definition: IMcpServer) -> Result<McpServer> {
        Self::stop(definition.clone()).await?;
        Self::start(definition).await
    }

    /// Starts the OAuth authorization-code flow for a remote MCP server. The
    /// callback listener is local-only and accepts exactly one redirect.
    pub async fn authorize(definition: IMcpServer) -> Result<()> {
        if definition.transport != McpServerTransport::StreamableHttp || definition.auth != McpServerAuth::OAuth {
            bail!("MCP Server `{}` does not use OAuth", definition.name);
        }
        if !McpServerRuntimeStore::global().begin_oauth(definition.id.clone())? {
            bail!("OAuth authorization is already in progress for `{}`", definition.name);
        }

        let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => listener,
            Err(error) => {
                McpServerRuntimeStore::global().clear_oauth(&definition.id);
                return Err(error).context("failed to start the local OAuth callback listener");
            },
        };
        let redirect_uri = format!("http://{}/oauth/callback", listener.local_addr()?);
        let manager = AuthorizationManager::new(&definition.url)
            .await
            .map_err(|error| anyhow::anyhow!("OAuth setup failed: {error}"))?;
        let store = OAuthCredentialStore::empty();
        let mut manager = manager;
        manager.set_credential_store(store.clone());
        let metadata = manager
            .resolve_metadata()
            .await
            .map_err(|error| anyhow::anyhow!("OAuth metadata discovery failed: {error}"))?;
        manager.set_metadata(metadata.metadata);
        let session = rmcp::transport::auth::AuthorizationSession::new(
            manager,
            AuthorizationRequest::new(&redirect_uri).with_client_name("Workrun"),
        )
        .await
        .map_err(|(_, error)| anyhow::anyhow!("OAuth authorization setup failed: {error}"))?;
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
                let result = session
                    .handle_callback_url(callback.as_str())
                    .await
                    .map_err(|error| anyhow::anyhow!("OAuth authorization failed: {error}"));
                let response = if result.is_ok() { "Authorization complete. You can return to Workrun." } else { "Authorization failed. You can close this page and try again in Workrun." };
                stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await?;
                result?;
                let credentials = store.load().await.map_err(|error| anyhow::anyhow!("OAuth credential storage failed: {error}"))?
                    .context("OAuth authorization did not return credentials")?;
                feat::store_oauth_credentials(&definition.id, credentials).await
            }.await;
            if let Err(error) = outcome {
                log::warn!("OAuth authorization for MCP Server {} failed: {error:#}", definition.id);
            }
            McpServerRuntimeStore::global().clear_oauth(&definition.id);
        });
        Ok(())
    }

    /// Gracefully stop every local MCP server owned by this application.
    pub async fn shutdown_all() -> Result<()> {
        let active = McpServerRuntimeStore::global().take_runtimes()?;
        for runtime in active.into_values() {
            Self::shutdown_runtime(runtime).await?;
        }
        Ok(())
    }

    /// Discover the tools currently advertised by running MCP servers.
    /// Stopped, disabled, and temporarily unreachable servers are omitted so
    /// Agents cannot persist a selection that is not presently usable.
    pub async fn list_tool_definitions(servers: Vec<IMcpServer>) -> Result<Vec<ToolDefinition>> {
        let context: Arc<dyn ReadonlyContext> = Arc::new(SimpleToolContext::new("mcp-discovery"));
        let mut definitions = Vec::new();

        for server in servers {
            let manager = McpServerRuntimeStore::global().runtime(&server.id).ok().flatten();
            let Some(manager) = manager else { continue };
            if Self::runtime_status(&manager, &server.id)
                .await
                .unwrap_or(ServerStatus::Stopped)
                != ServerStatus::Running
            {
                continue;
            }

            match Self::runtime_tools(&manager, Arc::clone(&context)).await {
                Ok(tools) => {
                    Self::record_health_success(&server.id, Some(tools.len()));
                    definitions.extend(tools.into_iter().map(|tool| tool_definition(&server, tool)));
                },
                Err(error) => Self::record_health_error(&server.id, error.to_string()),
            }
        }
        Ok(definitions)
    }

    /// Start an enabled server if necessary and resolve one of its currently
    /// advertised tools. A workflow stores the stable `mcp:<server>:<tool>` id,
    /// so discovery is repeated here to avoid executing a stale declaration.
    pub async fn resolve_tool(server: IMcpServer, tool_name: &str) -> Result<(ToolDefinition, Arc<dyn Tool>)> {
        if !server.enabled {
            bail!("MCP Server `{}` is disabled", server.name);
        }
        let manager = Self::runtime(&server).await?;
        if Self::runtime_status(&manager, &server.id).await? != ServerStatus::Running {
            Self::start_runtime(&manager, &server.id).await?;
        }
        let context: Arc<dyn ReadonlyContext> = Arc::new(SimpleToolContext::new("mcp-tool-resolution"));
        let tool = Self::runtime_tools(&manager, context)
            .await?
            .into_iter()
            .find(|tool| tool.name() == tool_name)
            .ok_or_else(|| anyhow::anyhow!("MCP Server `{}` does not advertise Tool `{tool_name}`", server.name))?;
        Ok((tool_definition(&server, Arc::clone(&tool)), tool))
    }

    async fn runtime(definition: &IMcpServer) -> Result<Arc<McpRuntime>> {
        if let Some(runtime) = McpServerRuntimeStore::global().runtime(&definition.id)? {
            return Ok(runtime);
        }
        let runtime = match definition.transport {
            McpServerTransport::Stdio => {
                let config = McpServerConfig {
                    command: definition.command.clone(),
                    args: definition.args.clone(),
                    env: definition.env.clone(),
                    disabled: !definition.enabled,
                    auto_approve: Vec::new(),
                    restart_policy: Some(stdio_restart_policy()),
                    lifecycle: Default::default(),
                    task_config: Default::default(),
                };
                let manager = Arc::new(
                    McpServerManager::new(HashMap::from([(definition.id.clone(), config)]))
                        .with_health_check_interval(Duration::from_secs(10)),
                );
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
        McpServerRuntimeStore::global().insert_runtime_if_absent(definition.id.clone(), runtime)
    }

    pub(crate) async fn stop_runtime(id: &str) -> Result<()> {
        let manager = McpServerRuntimeStore::global().remove_runtime(id)?;
        if let Some(runtime) = manager {
            Self::shutdown_runtime(runtime).await?;
        }
        Ok(())
    }

    async fn status(definition: &IMcpServer) -> ServerStatus {
        let manager = McpServerRuntimeStore::global().runtime(&definition.id).ok().flatten();
        match manager {
            Some(manager) => Self::runtime_status(&manager, &definition.id)
                .await
                .unwrap_or(ServerStatus::Stopped),
            None if !definition.enabled => ServerStatus::Disabled,
            None => ServerStatus::Stopped,
        }
    }

    pub(super) fn health(id: &str) -> McpServerHealth {
        McpServerRuntimeStore::global().health(id)
    }

    pub(crate) fn stopped(definition: IMcpServer) -> McpServer {
        McpServer {
            status: ServerStatus::Stopped,
            health: Self::health(&definition.id),
            definition,
        }
    }

    fn record_health(id: &str, result: &Result<McpServerConnectionTest>) {
        match result {
            Ok(result) => Self::record_health_success(id, Some(result.tool_names.len())),
            Err(error) => Self::record_health_error(id, error.to_string()),
        }
    }

    pub(super) fn record_health_success(id: &str, tool_count: Option<usize>) {
        McpServerRuntimeStore::global().record_health_success(id, tool_count);
    }

    pub(super) fn record_health_error(id: &str, error: String) {
        McpServerRuntimeStore::global().record_health_error(id, error);
    }

    fn record_health_error_if_absent(id: &str, error: String) {
        if Self::health(id).last_error.is_none() {
            Self::record_health_error(id, error);
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

    async fn oauth_access_token(definition: &IMcpServer) -> Result<String> {
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
                feat::store_oauth_credentials(&definition.id, refreshed).await?;
            }
        }
        Ok(access_token)
    }
}
