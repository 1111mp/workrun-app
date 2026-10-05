//! Installation-local A2A credentials. Workflow documents carry only IDs.
use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use tauri_plugin_http::reqwest::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RemoteCredentialKind {
    Bearer,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAgentCredential {
    pub id: String,
    pub name: String,
    pub kind: RemoteCredentialKind,
    /// Binding prevents a changed/imported workflow URL from exporting a key.
    pub origin: String,
    pub encrypted_secret: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCredentialSummary {
    pub id: String,
    pub name: String,
    pub kind: RemoteCredentialKind,
    pub origin: String,
}

impl RemoteAgentCredential {
    pub fn summary(&self) -> RemoteCredentialSummary {
        RemoteCredentialSummary {
            id: self.id.clone(),
            name: self.name.clone(),
            kind: self.kind.clone(),
            origin: self.origin.clone(),
        }
    }
}

pub fn remote_credential_origin(url: &str) -> Result<String> {
    let url = Url::parse(url).map_err(|_| anyhow::anyhow!("Invalid A2A service URL"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.query().is_some()
    {
        bail!("A2A credential URL must be HTTP(S) without credentials, query or fragment");
    }
    // HTTP is useful for local fixtures, but must not expose credentials over a public network.
    let local = url.host_str().is_some_and(|h| {
        h == "localhost" || h.parse::<std::net::IpAddr>().is_ok_and(|a| a.is_loopback()) || h == "[::1]"
    });
    if url.scheme() == "http" && !local {
        bail!("Authenticated A2A services require HTTPS (except loopback)");
    }
    Ok(url.origin().ascii_serialization())
}
