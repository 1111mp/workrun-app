use crate::{
    cmd::{CmdResult, StringifyErr},
    config::{Config, ModelProfile, ModelProvider},
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicModelProfile {
    pub id: String,
    pub name: String,
    pub provider: ModelProvider,
    pub model: String,
    pub base_url: Option<String>,
    pub has_api_key: bool,
}

impl From<&ModelProfile> for PublicModelProfile {
    fn from(value: &ModelProfile) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            provider: value.provider.clone(),
            model: value.model.clone(),
            base_url: value.base_url.clone(),
            has_api_key: value
                .api_key
                .as_deref()
                .is_some_and(|api_key| !api_key.trim().is_empty()),
        }
    }
}

#[tauri::command]
pub async fn model_profiles_list() -> CmdResult<Vec<PublicModelProfile>> {
    Ok(Config::workrun()
        .await
        .latest_arc()
        .model_profiles
        .iter()
        .map(PublicModelProfile::from)
        .collect())
}

#[tauri::command]
pub async fn model_profile_save(profile: ModelProfile) -> CmdResult<()> {
    if profile.id.trim().is_empty() || profile.name.trim().is_empty() || profile.model.trim().is_empty() {
        return Err("profile id, name and model are required".into());
    }
    if profile.provider != ModelProvider::Ollama
        && profile
            .api_key
            .as_deref()
            .is_none_or(|api_key| api_key.trim().is_empty())
    {
        return Err("API key is required for this provider".into());
    }
    let draft = Config::workrun().await;
    draft
        .with_data_modify(|mut config| async move {
            if let Some(existing) = config.model_profiles.iter_mut().find(|item| item.id == profile.id) {
                *existing = profile;
            } else {
                config.model_profiles.push(profile);
            }
            config.save_config().await?;
            Ok((config, ()))
        })
        .await
        .stringify_err()
}
