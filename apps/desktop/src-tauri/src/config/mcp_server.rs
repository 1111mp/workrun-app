use crate::{
    logging,
    utils::{dirs, help, logging::Type},
};
use anyhow::Result;
use rmcp::transport::StoredCredentials;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum McpServerTransport {
    #[default]
    Stdio,
    StreamableHttp,
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IMcpServer {
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
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth: McpServerAuth,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::config::serialize_encrypted",
        deserialize_with = "crate::config::deserialize_encrypted"
    )]
    pub bearer_token: Option<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "crate::config::serialize_encrypted",
        deserialize_with = "crate::config::deserialize_encrypted"
    )]
    pub oauth_credentials: Option<StoredCredentials>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IMcpServers {
    #[serde(default)]
    servers: Vec<IMcpServer>,
}

impl Default for IMcpServers {
    fn default() -> Self {
        Self { servers: vec![] }
    }
}

impl IMcpServers {
    pub async fn new() -> Self {
        match dirs::mcp_server_catalog_path() {
            Ok(path) => match help::read_json::<Self>(&path).await {
                Ok(servers) => servers,
                Err(error) => {
                    logging!(error, Type::Config, "{error}");
                    Self::default()
                },
            },
            Err(err) => {
                logging!(error, Type::Config, "{err}");
                return Self::default();
            },
        }
    }

    /// Save the MCP server catalog to file
    pub async fn save_file(&self) -> Result<()> {
        help::save_json(&dirs::mcp_server_catalog_path()?, self, None).await
    }

    /// Returns a detached list so callers cannot mutate the committed snapshot.
    pub fn get_mcp_servers(&self) -> Vec<IMcpServer> {
        self.servers.clone()
    }

    pub fn get_mcp_server(&self, id: &str) -> Option<IMcpServer> {
        self.servers.iter().find(|server| server.id == id).cloned()
    }

    #[cfg(test)]
    pub(crate) fn from_servers(servers: Vec<IMcpServer>) -> Self {
        Self { servers }
    }

    pub(crate) fn add_mcp_server(&mut self, server: IMcpServer) {
        self.servers.push(server);
    }

    pub(crate) fn replace_mcp_server(&mut self, server: IMcpServer) -> bool {
        let Some(position) = self.servers.iter().position(|current| current.id == server.id) else {
            return false;
        };
        self.servers[position] = server;
        true
    }

    pub(crate) fn remove_mcp_server(&mut self, id: &str) -> bool {
        let original_len = self.servers.len();
        self.servers.retain(|server| server.id != id);
        self.servers.len() != original_len
    }

    pub(crate) fn update_oauth_credentials(
        &mut self,
        id: &str,
        credentials: StoredCredentials,
        updated_at: String,
    ) -> bool {
        let Some(server) = self.servers.iter_mut().find(|server| server.id == id) else {
            return false;
        };
        server.oauth_credentials = Some(credentials);
        server.updated_at = updated_at;
        true
    }
}
