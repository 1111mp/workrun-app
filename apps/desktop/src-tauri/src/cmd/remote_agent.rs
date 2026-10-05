use super::{CmdResult, StringifyErr};
use crate::config::{
    BaseConfig, RemoteAgentCredential, RemoteCredentialKind, RemoteCredentialSummary, encrypt_data,
    remote_credential_origin,
};
use serde::Deserialize;

// Secrets are write-only IPC inputs; neither save nor list returns ciphertext or plaintext.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveCredential {
    id: Option<String>,
    name: String,
    kind: RemoteCredentialKind,
    service_url: String,
    secret: Option<String>,
}

#[tauri::command]
pub async fn remote_credentials_list() -> CmdResult<Vec<RemoteCredentialSummary>> {
    Ok(BaseConfig::workrun()
        .await
        .data_arc()
        .remote_agent_credentials
        .iter()
        .map(|c| c.summary())
        .collect())
}

#[tauri::command]
pub async fn remote_credential_save(payload: SaveCredential) -> CmdResult<RemoteCredentialSummary> {
    let origin = remote_credential_origin(&payload.service_url).stringify_err()?;
    let name = payload.name.trim().to_string();
    if name.is_empty() || name.len() > 100 {
        return Err("Credential name must contain 1–100 characters".into());
    }
    let encrypted = match payload.secret {
        Some(secret) => {
            crate::module::workflow::validate_remote_secret(&payload.kind, &secret).stringify_err()?;
            Some(encrypt_data(&secret).map_err(|_| "Cannot encrypt A2A credential".to_string())?)
        },
        None => None,
    };
    let draft = BaseConfig::workrun().await;
    draft
        .with_data_modify(move |mut config| async move {
            let existing = payload
                .id
                .as_ref()
                .and_then(|id| config.remote_agent_credentials.iter().find(|c| &c.id == id));
            if payload.id.is_some() && existing.is_none() {
                anyhow::bail!("A2A credential no longer exists");
            }
            // Retaining a secret never changes its type/origin. A new value is required for that.
            let secret = match encrypted {
                Some(value) => value,
                None => {
                    let old = existing.ok_or_else(|| anyhow::anyhow!("A new credential requires a secret"))?;
                    if old.kind != payload.kind || old.origin != origin {
                        anyhow::bail!("Changing credential type or origin requires a new secret");
                    }
                    old.encrypted_secret.clone()
                },
            };
            let credential = RemoteAgentCredential {
                id: payload.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                name,
                kind: payload.kind,
                origin,
                encrypted_secret: secret,
            };
            let summary = credential.summary();
            config.remote_agent_credentials.retain(|c| c.id != credential.id);
            config.remote_agent_credentials.push(credential);
            config.save_config().await?;
            Ok((config, summary))
        })
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn remote_credential_delete(id: String) -> CmdResult {
    BaseConfig::workrun()
        .await
        .with_data_modify(move |mut config| async move {
            config.remote_agent_credentials.retain(|c| c.id != id);
            config.save_config().await?;
            Ok((config, ()))
        })
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn remote_agent_test_connection(
    url: String,
    authentication: Option<crate::module::workflow::RemoteAuthentication>,
) -> CmdResult {
    let config = BaseConfig::workrun().await.data_arc();
    crate::module::workflow::test_remote_connection(&url, authentication.as_ref(), &config)
        .await
        .stringify_err()
}
