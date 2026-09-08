use crate::{
    config::{Config, IMcpServer, McpServerTransport},
    module::mcp_server::{
        McpServer, McpServerAuth, McpServerConnectionTest, McpServerRegistry, parse_tool_id, validate_catalog,
        validate_definition, validate_id,
    },
    module::tool_registry::ToolDefinition,
};
use adk_rust::tool::Tool;
use anyhow::{Result, bail};
use chrono::Utc;
use rmcp::transport::StoredCredentials;
use serde::Deserialize;
use std::{collections::HashMap, sync::Arc};
use uuid::Uuid;

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
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: McpServerAuth,
    #[serde(default)]
    pub bearer_token: Option<String>,
    #[serde(default = "enabled_by_default")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestMcpServerConnectionRequest {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub transport: McpServerTransport,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: McpServerAuth,
    #[serde(default)]
    pub bearer_token: Option<String>,
}

fn enabled_by_default() -> bool {
    true
}

/// Get the list of MCP servers from the catalog, along with their current status and health information.
pub async fn get_mcp_servers() -> Result<Vec<McpServer>> {
    let draft = Config::mcp_servers().await;
    let mcp_servers = draft.data_arc();
    let servers = mcp_servers.get_mcp_servers();
    let mut listed = Vec::with_capacity(servers.len());

    for server in servers {
        listed.push(McpServerRegistry::describe(server).await);
    }

    Ok(listed)
}

/// Create a new MCP server definition and add it to the catalog.
pub async fn create_mcp_server(request: CreateMcpServerRequest) -> Result<McpServer> {
    let now = Utc::now().to_rfc3339();
    let definition = IMcpServer {
        id: Uuid::now_v7().to_string(),
        name: request.name.trim().to_string(),
        description: request.description.trim().to_string(),
        transport: request.transport,
        command: request.command.trim().to_string(),
        args: request.args,
        env: request.env,
        url: request.url.trim().to_string(),
        auth: request.auth,
        bearer_token: request.bearer_token.filter(|token| !token.trim().is_empty()),
        oauth_credentials: None,
        enabled: request.enabled,
        created_at: now.clone(),
        updated_at: now,
    };
    validate_definition(&definition)?;

    let servers = Config::mcp_servers().await;
    let definition = servers
        .with_data_modify(|mut data| async move {
            data.add_mcp_server(definition.clone());
            validate_catalog(&data)?;
            data.save_file().await?;
            Ok((data, definition))
        })
        .await?;

    Ok(McpServerRegistry::stopped(definition))
}

/// Update an existing MCP server definition in the catalog.
pub async fn update_mcp_server(mut definition: IMcpServer) -> Result<McpServer> {
    validate_definition(&definition)?;

    let servers = Config::mcp_servers().await;
    let definition = servers
        .with_data_modify(|mut data| async move {
            let existing = data
                .get_mcp_server(&definition.id)
                .ok_or_else(|| anyhow::anyhow!("MCP Server is not in the catalog: {}", definition.id))?;

            // API responses omit stored credentials, so retain them unless replaced.
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
            debug_assert!(data.replace_mcp_server(definition.clone()));
            validate_catalog(&data)?;
            data.save_file().await?;
            Ok((data, definition))
        })
        .await?;

    McpServerRegistry::stop_runtime(&definition.id).await?;
    Ok(McpServerRegistry::stopped(definition))
}

/// Delete an existing MCP server definition from the catalog.
pub async fn delete_mcp_server(id: &str) -> Result<()> {
    let id = id.to_string();
    let catalog_id = id.clone();
    let servers = Config::mcp_servers().await;
    servers
        .with_data_modify(|mut data| async move {
            if !data.remove_mcp_server(&catalog_id) {
                bail!("MCP Server is not in the catalog: {catalog_id}");
            }
            data.save_file().await?;
            Ok((data, ()))
        })
        .await?;

    McpServerRegistry::stop_runtime(&id).await
}

/// Start, stop, reconnect, and authorize an MCP server runtime.
pub async fn start_mcp_server(id: &str) -> Result<McpServer> {
    McpServerRegistry::start(get_mcp_server(id).await?).await
}

pub async fn stop_mcp_server(id: &str) -> Result<McpServer> {
    McpServerRegistry::stop(get_mcp_server(id).await?).await
}

pub async fn reconnect_mcp_server(id: &str) -> Result<McpServer> {
    McpServerRegistry::reconnect(get_mcp_server(id).await?).await
}

pub async fn authorize_mcp_server(id: &str) -> Result<()> {
    McpServerRegistry::authorize(get_mcp_server(id).await?).await
}

pub async fn test_mcp_server_connection(request: TestMcpServerConnectionRequest) -> Result<McpServerConnectionTest> {
    let existing = match request.id.as_deref() {
        Some(id) => Some(get_mcp_server(id).await?),
        None => None,
    };
    McpServerRegistry::test_connection(request, existing).await
}

pub async fn list_mcp_tool_definitions() -> Result<Vec<ToolDefinition>> {
    let servers = Config::mcp_servers().await.data_arc().get_mcp_servers();
    McpServerRegistry::list_tool_definitions(servers).await
}

pub async fn resolve_mcp_tool(id: &str) -> Result<(ToolDefinition, Arc<dyn Tool>)> {
    let (server_id, tool_name) = parse_tool_id(id)?;
    McpServerRegistry::resolve_tool(get_mcp_server(server_id).await?, tool_name).await
}

async fn get_mcp_server(id: &str) -> Result<IMcpServer> {
    validate_id(id)?;
    let servers = Config::mcp_servers().await.data_arc();
    servers
        .get_mcp_server(id)
        .ok_or_else(|| anyhow::anyhow!("MCP Server is not in the catalog: {id}"))
}

pub(crate) async fn store_oauth_credentials(id: &str, credentials: StoredCredentials) -> Result<()> {
    let id = id.to_string();
    let catalog_id = id.clone();
    let servers = Config::mcp_servers().await;
    servers
        .with_data_modify(|mut data| async move {
            if !data.update_oauth_credentials(&catalog_id, credentials, Utc::now().to_rfc3339()) {
                bail!("MCP Server is not in the catalog: {catalog_id}");
            }
            data.save_file().await?;
            Ok((data, ()))
        })
        .await?;

    McpServerRegistry::stop_runtime(&id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Draft, IMcpServers};

    fn server() -> IMcpServer {
        IMcpServer {
            id: "019b812d-4958-7d37-8a45-47e1e20a4744".into(),
            name: "Everything".into(),
            description: String::new(),
            transport: McpServerTransport::Stdio,
            command: "npx".into(),
            args: vec![],
            env: HashMap::new(),
            url: String::new(),
            auth: McpServerAuth::None,
            bearer_token: None,
            oauth_credentials: None,
            enabled: true,
            created_at: "created".into(),
            updated_at: "created".into(),
        }
    }

    #[tokio::test]
    async fn failed_persistence_does_not_commit_server_changes() {
        let draft = Draft::new(IMcpServers::default());
        let server = server();

        let result: Result<()> = draft
            .with_data_modify(|mut data| async move {
                data.add_mcp_server(server);
                Err(anyhow::anyhow!("disk write failed"))
            })
            .await;

        assert!(result.is_err());
        assert!(draft.data_arc().get_mcp_servers().is_empty());
    }

    #[test]
    fn server_collection_supports_create_update_and_delete() {
        let mut servers = IMcpServers::default();
        let server = server();
        servers.add_mcp_server(server.clone());
        assert_eq!(servers.get_mcp_server(&server.id).unwrap().name, "Everything");

        let mut updated = server.clone();
        updated.name = "Updated".into();
        assert!(servers.replace_mcp_server(updated));
        assert_eq!(servers.get_mcp_server(&server.id).unwrap().name, "Updated");

        assert!(servers.remove_mcp_server(&server.id));
        assert!(servers.get_mcp_servers().is_empty());
        assert!(!servers.remove_mcp_server(&server.id));
    }

    #[test]
    fn oauth_credential_update_replaces_credentials_and_timestamp() {
        let mut servers = IMcpServers::default();
        let mut server = server();
        server.auth = McpServerAuth::OAuth;
        servers.add_mcp_server(server.clone());
        let credentials: StoredCredentials = serde_json::from_value(serde_json::json!({
            "client_id": "workrun",
            "token_response": null,
            "granted_scopes": [],
            "token_received_at": null,
        }))
        .unwrap();

        assert!(servers.update_oauth_credentials(&server.id, credentials, "updated".into()));
        let updated = servers.get_mcp_server(&server.id).unwrap();
        assert_eq!(updated.updated_at, "updated");
        assert_eq!(updated.oauth_credentials.unwrap().client_id, "workrun");
    }
}
