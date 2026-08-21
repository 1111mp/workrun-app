use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::{Config, IWorkrun, ProviderCredential, WorkrunPatch},
    feat,
};
use serde::Serialize;

/// The portion of Workrun configuration that is safe to return over IPC.
///
/// CodeAct secrets intentionally do not appear here: their plaintext values are
/// only used while constructing a Monty runtime in the backend.
#[derive(Serialize)]
pub struct PublicWorkrunConfig {
    provider_credentials: Vec<ProviderCredential>,
    app_log_level: Option<String>,
    app_log_max_size: Option<u64>,
    app_log_max_count: Option<usize>,
    locale: Option<String>,
    theme: Option<String>,
    enable_auto_launch: Option<bool>,
    enable_silent_start: Option<bool>,
    auto_check_update: Option<bool>,
    auto_log_clean: Option<i32>,
}

impl From<&IWorkrun> for PublicWorkrunConfig {
    fn from(config: &IWorkrun) -> Self {
        Self {
            provider_credentials: config.provider_credentials.clone(),
            app_log_level: config.app_log_level.clone(),
            app_log_max_size: config.app_log_max_size,
            app_log_max_count: config.app_log_max_count,
            locale: config.locale.clone(),
            theme: config.theme.clone(),
            enable_auto_launch: config.enable_auto_launch,
            enable_silent_start: config.enable_silent_start,
            auto_check_update: config.auto_check_update,
            auto_log_clean: config.auto_log_clean,
        }
    }
}

/// get workrun configuration
#[tauri::command]
pub async fn get_workrun_config() -> CmdResult<PublicWorkrunConfig> {
    let draft = Config::workrun().await;
    let config = draft.data_arc();
    Ok(PublicWorkrunConfig::from(config.as_ref().as_ref()))
}

/// patch workrun configuration
#[tauri::command]
pub async fn patch_workrun_config(payload: WorkrunPatch) -> CmdResult {
    feat::patch_workrun(&payload, true).await.stringify_err()
}
