use super::{
    McpRuntime, McpServer, McpServerAuth, McpServerConnectionTest, McpServerHealth, McpServerRuntimeStore,
    McpServerTransport, McpServerWorkflowReference, OAuthCredentialStore, tool_definition, validate_definition,
    validate_id, workflow_uses_mcp_server,
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
            ServerStatus,
            rmcp::{
                self,
                transport::auth::{AuthorizationManager, AuthorizationRequest, CredentialStore},
            },
        },
    },
};
use anyhow::{Context, Result, bail};
use std::sync::Arc;
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
                if definition.transport == McpServerTransport::Stdio {
                    "MCP process exited unexpectedly; automatic restart is pending."
                } else {
                    "MCP connection closed; reconnect to restore the session."
                }
                .into(),
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

        // Setup errors occur before the callback task owns cleanup. Clear the
        // pending flag here too so a failed attempt does not prevent retrying.
        let setup = async {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
                .await
                .context("failed to start the local OAuth callback listener")?;
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

            Ok::<_, anyhow::Error>((listener, session, store))
        }
        .await;
        let (listener, session, store) = match setup {
            Ok(setup) => setup,
            Err(error) => {
                McpServerRuntimeStore::global().clear_oauth(&definition.id);
                return Err(error);
            },
        };

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
        let tools = match Self::runtime_tools(&manager, context).await {
            Ok(tools) => {
                Self::record_health_success(&server.id, Some(tools.len()));
                tools
            },
            Err(error) => {
                Self::record_health_error(&server.id, error.to_string());
                return Err(error);
            },
        };
        let tool = tools
            .into_iter()
            .find(|tool| tool.name() == tool_name)
            .ok_or_else(|| anyhow::anyhow!("MCP Server `{}` does not advertise Tool `{tool_name}`", server.name))?;
        Ok((tool_definition(&server, Arc::clone(&tool)), tool))
    }

    async fn runtime(definition: &IMcpServer) -> Result<Arc<McpRuntime>> {
        if let Some(runtime) = McpServerRuntimeStore::global().runtime(&definition.id)? {
            if let McpRuntime::Http(toolset) = runtime.as_ref()
                && toolset.is_closed().await
            {
                // The SDK cannot always refresh an already closed service.
                // Replace it only when Start or tool resolution requests it.
                Self::stop_runtime(&definition.id).await?;
            } else {
                return Ok(runtime);
            }
        }
        let runtime = match definition.transport {
            McpServerTransport::Stdio => {
                Arc::new(McpRuntime::Stdio(super::stdio::StdioRuntime::new(definition.clone())))
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
        super::notify_changed();
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

    async fn start_runtime(runtime: &McpRuntime, _id: &str) -> Result<()> {
        if let McpRuntime::Stdio(manager) = runtime {
            manager.start().await?;
        }
        Ok(())
    }

    async fn runtime_status(runtime: &McpRuntime, _id: &str) -> Result<ServerStatus> {
        match runtime {
            McpRuntime::Stdio(manager) => Ok(manager.status().await),
            // This is the last observed session state, not an idle reachability probe.
            McpRuntime::Http(toolset) => Ok(if toolset.is_closed().await {
                ServerStatus::Crashed
            } else {
                ServerStatus::Running
            }),
        }
    }

    async fn runtime_tools(runtime: &McpRuntime, context: Arc<dyn ReadonlyContext>) -> Result<Vec<Arc<dyn Tool>>> {
        match runtime {
            McpRuntime::Stdio(manager) => Ok(manager.tools(context).await?),
            McpRuntime::Http(toolset) => Ok(toolset.tools(context).await?),
        }
    }

    async fn shutdown_runtime(runtime: Arc<McpRuntime>) -> Result<()> {
        match runtime.as_ref() {
            McpRuntime::Stdio(manager) => manager.shutdown().await,
            McpRuntime::Http(toolset) => toolset.cancellation_token().await.cancel(),
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
            && refreshed.token_received_at != credentials.token_received_at
        {
            feat::store_oauth_credentials(&definition.id, refreshed).await?;
        }

        Ok(access_token)
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::atomic::{AtomicBool, Ordering};

    // Minimal stateless HTTP peer: exercise the real SDK without external services.
    async fn server() -> (IMcpServer, Arc<AtomicBool>, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let definition: IMcpServer = serde_json::from_value(json!({
            "id":Uuid::new_v4().to_string(), "name":"HTTP lifecycle test", "command":"",
            "transport":"streamable_http", "url":format!("http://{}/mcp", listener.local_addr().unwrap()),
            "enabled":true
        }))
        .unwrap();
        let fail = Arc::new(AtomicBool::new(false));
        let failure = fail.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let failure = failure.clone();
                tokio::spawn(async move {
                    let mut bytes = Vec::new();
                    let end = loop {
                        let mut chunk = [0; 4096];
                        let n = socket.read(&mut chunk).await.unwrap();
                        if n == 0 {
                            return;
                        }
                        bytes.extend_from_slice(&chunk[..n]);
                        if let Some(i) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    let (status, body) = if headers.starts_with("post ") {
                        let length: usize = headers
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length: "))
                            .unwrap()
                            .trim()
                            .parse()
                            .unwrap();
                        while bytes.len() < end + length {
                            let mut chunk = [0; 4096];
                            let n = socket.read(&mut chunk).await.unwrap();
                            if n == 0 {
                                return;
                            }
                            bytes.extend_from_slice(&chunk[..n]);
                        }
                        let request: Value = serde_json::from_slice(&bytes[end..end + length]).unwrap();
                        if request.get("id").is_none() {
                            ("202 Accepted", String::new())
                        } else {
                            let result = match request["method"].as_str().unwrap() {
                                "initialize" => {
                                    json!({"protocolVersion":request["params"]["protocolVersion"],"capabilities":{"tools":{}},"serverInfo":{"name":"test","version":"1"}})
                                },
                                "tools/list" => {
                                    json!({"tools":[{"name":"echo","description":"Echo","inputSchema":{"type":"object"}}]})
                                },
                                method => panic!("Unexpected MCP request: {method}"),
                            };
                            let reply = if request["method"] == "tools/list" && failure.load(Ordering::SeqCst) {
                                json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32603,"message":"discovery failed"}})
                            } else {
                                json!({"jsonrpc":"2.0","id":request["id"],"result":result})
                            };
                            ("200 OK", reply.to_string())
                        }
                    } else {
                        ("405 Method Not Allowed", String::new())
                    };
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        (definition, fail, task)
    }

    #[tokio::test]
    #[ignore = "requires loopback TCP sockets"]
    async fn http_session_status_health_recovery_and_stop() {
        let (definition, fail, server) = server().await;
        assert_eq!(
            McpServerRegistry::start(definition.clone()).await.unwrap().status,
            ServerStatus::Running
        );
        fail.store(true, Ordering::SeqCst);
        assert!(
            McpServerRegistry::resolve_tool(definition.clone(), "echo")
                .await
                .is_err()
        );
        let failed = McpServerRegistry::describe(definition.clone()).await;
        assert!(failed.health.last_error.is_some());
        // A protocol error does not mean the transport disconnected.
        assert_eq!(failed.status, ServerStatus::Running);
        fail.store(false, Ordering::SeqCst);
        McpServerRegistry::resolve_tool(definition.clone(), "echo")
            .await
            .unwrap();
        assert!(McpServerRegistry::health(&definition.id).last_error.is_none());
        let runtime = McpServerRuntimeStore::global()
            .runtime(&definition.id)
            .unwrap()
            .unwrap();
        let McpRuntime::Http(toolset) = runtime.as_ref() else {
            panic!("Expected HTTP runtime")
        };
        toolset.cancellation_token().await.cancel();
        assert_eq!(
            McpServerRegistry::describe(definition.clone()).await.status,
            ServerStatus::Crashed
        );
        // A closed session is replaced on demand; no background reconnect loop.
        McpServerRegistry::resolve_tool(definition.clone(), "echo")
            .await
            .unwrap();
        let recovered = McpServerRegistry::describe(definition.clone()).await;
        assert_eq!(recovered.status, ServerStatus::Running);
        assert!(recovered.health.last_error.is_none());
        let current = McpServerRuntimeStore::global()
            .runtime(&definition.id)
            .unwrap()
            .unwrap();
        let McpRuntime::Http(current_toolset) = current.as_ref() else {
            panic!("Expected HTTP runtime")
        };
        assert!(!Arc::ptr_eq(toolset, current_toolset));
        assert_eq!(
            McpServerRegistry::stop(definition.clone()).await.unwrap().status,
            ServerStatus::Stopped
        );
        assert!(toolset.is_closed().await);
        assert!(current_toolset.is_closed().await);
        assert_eq!(
            McpServerRegistry::describe(definition).await.status,
            ServerStatus::Stopped
        );
        server.abort();
    }

    #[tokio::test]
    #[ignore = "requires loopback TCP sockets"]
    async fn oauth_metadata_failure_clears_pending_and_allows_retry() {
        let (mut definition, _, server) = server().await;
        definition.auth = McpServerAuth::OAuth;
        for _ in 0..2 {
            let error = McpServerRegistry::authorize(definition.clone()).await.unwrap_err();
            assert!(!error.to_string().contains("already in progress"));
            let value = serde_json::to_value(McpServerRegistry::describe(definition.clone()).await).unwrap();
            assert_eq!(value["definition"]["authorizationStatus"], "authorization_required");
            assert!(
                McpServerRuntimeStore::global()
                    .begin_oauth(definition.id.clone())
                    .unwrap()
            );
            McpServerRuntimeStore::global().clear_oauth(&definition.id);
        }
        server.abort();
    }
}
