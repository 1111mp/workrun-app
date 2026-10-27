//! Shared Team release resolution for execution outside the editor.
use anyhow::{Context, Result, anyhow};
use serde_json::Value;
use std::time::Duration;

// Session credentials stay in memory and are refreshed/cleared by the auth handler.
// Binding them to the server prevents a configuration change from leaking a token.
static TEAM_SESSION: parking_lot::RwLock<Option<(String, String)>> = parking_lot::RwLock::new(None);

pub fn set_team_session(server_url: String, token: Option<String>) {
    *TEAM_SESSION.write() = token.filter(|token| !token.is_empty()).map(|token| (server_url, token));
}

pub(crate) async fn fetch_latest_published(workspace: &str, workflow_id: &str) -> Result<(Value, String)> {
    anyhow::ensure!(
        workspace.starts_with("team:"),
        "Published releases require a Team workspace"
    );
    let config = crate::config::BaseConfig::workrun().await.data_arc();
    let server = &config
        .team
        .as_ref()
        .context("Team server is not configured")?
        .server_url;
    let token = TEAM_SESSION
        .read()
        .as_ref()
        .filter(|(base, _)| base == server)
        .map(|(_, token)| token.clone())
        .context("Sign in to resolve the latest published Workflow")?;
    let published = fetch_published_from_server(server, &token, workflow_id).await?;
    Ok((published, token))
}

pub(crate) async fn fetch_published_from_server(server: &str, token: &str, workflow_id: &str) -> Result<Value> {
    let mut url =
        tauri_plugin_http::reqwest::Url::parse(&format!("{}/api/v1/workflow/team/", server.trim_end_matches('/')))?;
    url.set_query(None);
    url.set_fragment(None);
    url.path_segments_mut()
        .map_err(|_| anyhow!("Invalid Team server URL"))?
        .pop_if_empty()
        .push(workflow_id);
    let response = tauri_plugin_http::reqwest::Client::builder()
        .redirect(tauri_plugin_http::reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()?
        .get(url)
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?;
    let envelope: Value = response.json().await?;
    anyhow::ensure!(
        envelope["errorCode"].as_i64() == Some(0),
        "Failed to fetch the latest published Workflow"
    );
    Ok(envelope["payload"].clone())
}
