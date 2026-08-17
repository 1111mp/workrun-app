//! Persistent configuration and lifecycle management for local stdio MCP servers.

use crate::{
    config::{deserialize_encrypted, serialize_encrypted},
    singleton,
};
use adk_rust::tool::{
    Toolset,
    mcp::{
        McpServerManager, RestartPolicy, ServerStatus,
        rmcp::transport::auth::{AuthError, CredentialStore, StoredCredentials},
    },
};
use anyhow::Result;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

#[derive(Clone)]
pub(super) struct OAuthCredentialStore(Arc<tokio::sync::RwLock<Option<StoredCredentials>>>);

impl OAuthCredentialStore {
    pub(super) fn empty() -> Self {
        Self(Arc::new(tokio::sync::RwLock::new(None)))
    }

    pub(super) fn from_credentials(credentials: StoredCredentials) -> Self {
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
    pub env: HashMap<String, String>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    #[serde(serialize_with = "serialize_definition_for_frontend")]
    pub definition: McpServerDefinition,
    pub status: ServerStatus,
    pub health: McpServerHealth,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerHealth {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConnectionTest {
    pub tool_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerWorkflowReference {
    pub id: String,
    pub name: String,
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
    env: &'a HashMap<String, String>,
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
        env: &definition.env,
        url: &definition.url,
        auth: definition.auth,
        authorization_status: if definition.transport != McpServerTransport::StreamableHttp
            || definition.auth != McpServerAuth::OAuth
        {
            McpServerAuthorizationStatus::NotRequired
        } else if McpServerRuntimeStore::global().is_oauth_pending(&definition.id) {
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

pub(super) enum McpRuntime {
    Stdio(Arc<McpServerManager>),
    Http(Arc<dyn Toolset>),
}

/// Process-local, thread-safe state for MCP server runtimes and their lifecycle.
pub(super) struct McpServerRuntimeStore {
    runtimes: Mutex<HashMap<String, Arc<McpRuntime>>>,
    oauth_pending: Mutex<HashSet<String>>,
    health: Mutex<HashMap<String, McpServerHealth>>,
}

singleton!(McpServerRuntimeStore, MCP_SERVER_RUNTIME_STORE);

impl McpServerRuntimeStore {
    fn new() -> Self {
        Self {
            runtimes: Mutex::new(HashMap::new()),
            oauth_pending: Mutex::new(HashSet::new()),
            health: Mutex::new(HashMap::new()),
        }
    }

    pub(super) fn begin_oauth(&self, id: String) -> Result<bool> {
        Ok(self
            .oauth_pending
            .lock()
            .map_err(|_| anyhow::anyhow!("OAuth authorization registry is unavailable"))?
            .insert(id))
    }

    pub(super) fn clear_oauth(&self, id: &str) {
        let _ = self.oauth_pending.lock().map(|mut pending| pending.remove(id));
    }

    fn is_oauth_pending(&self, id: &str) -> bool {
        self.oauth_pending
            .lock()
            .ok()
            .is_some_and(|pending| pending.contains(id))
    }

    pub(super) fn runtime(&self, id: &str) -> Result<Option<Arc<McpRuntime>>> {
        Ok(self
            .runtimes
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?
            .get(id)
            .cloned())
    }

    pub(super) fn insert_runtime_if_absent(&self, id: String, runtime: Arc<McpRuntime>) -> Result<Arc<McpRuntime>> {
        let mut runtimes = self
            .runtimes
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?;
        Ok(Arc::clone(runtimes.entry(id).or_insert(runtime)))
    }

    pub(super) fn remove_runtime(&self, id: &str) -> Result<Option<Arc<McpRuntime>>> {
        Ok(self
            .runtimes
            .lock()
            .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?
            .remove(id))
    }

    pub(super) fn take_runtimes(&self) -> Result<HashMap<String, Arc<McpRuntime>>> {
        Ok(std::mem::take(
            &mut *self
                .runtimes
                .lock()
                .map_err(|_| anyhow::anyhow!("MCP runtime registry is unavailable"))?,
        ))
    }

    pub(super) fn health(&self, id: &str) -> McpServerHealth {
        self.health
            .lock()
            .ok()
            .and_then(|health| health.get(id).cloned())
            .unwrap_or_default()
    }

    pub(super) fn record_health_success(&self, id: &str, tool_count: Option<usize>) {
        if let Ok(mut health) = self.health.lock() {
            let entry = health.entry(id.to_string()).or_default();
            entry.last_checked_at = Some(Utc::now().to_rfc3339());
            entry.last_error = None;
            if tool_count.is_some() {
                entry.tool_count = tool_count;
            }
        }
    }

    pub(super) fn record_health_error(&self, id: &str, error: String) {
        if let Ok(mut health) = self.health.lock() {
            let entry = health.entry(id.to_string()).or_default();
            entry.last_checked_at = Some(Utc::now().to_rfc3339());
            entry.last_error = Some(error);
        }
    }
}

pub(super) fn stdio_restart_policy() -> RestartPolicy {
    RestartPolicy {
        initial_delay_ms: 2_000,
        max_delay_ms: 15_000,
        backoff_multiplier: 2.5,
        max_restart_attempts: 3,
    }
}
