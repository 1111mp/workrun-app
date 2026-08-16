//! Persistent configuration and lifecycle management for local stdio MCP servers.

use crate::{
    config::{deserialize_encrypted, serialize_encrypted},
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
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, OnceLock},
};
use uuid::Uuid;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    bearer_token: Option<&'a str>,
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
        bearer_token: definition.bearer_token.as_deref(),
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

fn runtimes() -> &'static Mutex<HashMap<String, Arc<McpRuntime>>> {
    RUNTIMES.get_or_init(|| Mutex::new(HashMap::new()))
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
        let catalog =
            serde_json::from_slice(&bytes).with_context(|| format!("invalid MCP Server catalog {}", path.display()))?;
        validate_catalog(&catalog)?;
        Ok(catalog)
    }

    async fn write_catalog(catalog: &McpServerCatalog) -> Result<()> {
        validate_catalog(catalog)?;
        let path = dirs::mcp_server_catalog_path()?;
        let parent = path.parent().context("MCP Server catalog has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        tokio::fs::write(&path, serde_json::to_vec_pretty(catalog)?)
            .await
            .with_context(|| format!("failed to write MCP Server catalog {}", path.display()))
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
    fn returns_the_bearer_token_to_the_frontend() {
        let mut definition = definition();
        definition.bearer_token = Some("secret-token".into());
        let server = McpServer {
            definition,
            status: ServerStatus::Stopped,
        };

        assert_eq!(
            serde_json::to_value(server).unwrap()["definition"]["bearerToken"],
            "secret-token"
        );
    }
}
