use crate::config::{BaseConfig, Config, WorkrunPatch};
use crate::{
    core::{autostart, logger::Logger, tray},
    logging,
    utils::{dirs, init, logging::Type},
};
use anyhow::Result;
use bitflags::bitflags;

bitflags! {
    #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
    struct UpdateFlags: u16 {
        const LAUNCH = 1 << 0;
        const LOCALE = 1 << 1;
        const LOG_LEVEL = 1 << 2;
        const LOG_FILE = 1 << 3;
        const INITIALIZE_WORKSPACE = 1 << 4;
        const RESET_TEAM_SESSION = 1 << 5;
    }
}

/// Patch Workrun Configuration
pub async fn patch_workrun(patch: &WorkrunPatch, need_save_file: bool) -> Result<()> {
    if let Some(credentials) = &patch.provider_credentials {
        anyhow::ensure!(dirs::workspace_available(), "Sign in to edit Team credentials");
        for credential in credentials {
            credential.request_headers()?;
        }
    }
    // Resolve flags before staging: session changes must be compared with the
    // existing authenticated connection, not with the updated configuration.
    let update_flags = determine_update_flags(patch);
    logging!(debug, Type::Setup, "Determined update flags: {:?}", update_flags);

    let workrun = BaseConfig::workrun().await;
    workrun.edit_draft(|config| config.patch_config(patch));
    if let Err(error) = process_update_flags(update_flags).await {
        workrun.discard();
        return Err(error);
    }
    workrun.apply();
    if need_save_file {
        logging!(debug, Type::Setup, "Saving Workrun configuration to file...");
        workrun.data_arc().save_config().await?;
    }
    Ok(())
}

fn determine_update_flags(patch: &WorkrunPatch) -> UpdateFlags {
    let auto_launch = patch.enable_auto_launch;
    let locale = &patch.locale;
    let log_level = &patch.app_log_level;
    let log_max_size = patch.app_log_max_size;
    let log_max_count = patch.app_log_max_count;
    let workspace_mode = &patch.workspace_mode;

    let mut update_flags = UpdateFlags::empty();

    if auto_launch.is_some() {
        update_flags.insert(UpdateFlags::LAUNCH);
    }
    if locale.is_some() {
        update_flags.insert(UpdateFlags::LOCALE);
    }
    if log_level.is_some() {
        update_flags.insert(UpdateFlags::LOG_LEVEL);
    }
    if log_max_size.is_some() || log_max_count.is_some() {
        update_flags.insert(UpdateFlags::LOG_FILE);
    }
    if workspace_mode.is_some() {
        update_flags.insert(UpdateFlags::INITIALIZE_WORKSPACE);
    }

    if patch.workspace_mode.is_some()
        || patch.team.as_ref().is_some_and(|team| {
            // Changing only the summary model keeps the authenticated connection.
            crate::module::team_model::configured_server_changed(&team.server_url)
        })
    {
        update_flags.insert(UpdateFlags::RESET_TEAM_SESSION);
    }

    update_flags
}

async fn process_update_flags(update_flags: UpdateFlags) -> Result<()> {
    // Side effects consume merged settings so a partial patch cannot reset
    // another field (for example log count when only log size changed).
    let config = BaseConfig::workrun().await.latest_arc();
    if update_flags.contains(UpdateFlags::LAUNCH) {
        autostart::update_launch().await?;
    }
    if update_flags.contains(UpdateFlags::LOCALE) {
        tray::Tray::global().update_menu().await?;
    }
    if update_flags.contains(UpdateFlags::LOG_LEVEL) {
        Logger::global().update_log_level(config.get_log_level())?;
    }
    if update_flags.contains(UpdateFlags::LOG_FILE) {
        let log_max_size = config.app_log_max_size.unwrap_or(128);
        let log_max_count = config.app_log_max_count.unwrap_or(8);
        Logger::global().update_log_config(log_max_size, log_max_count).await?;
    }
    // Clear the old account before choosing/reloading its replacement workspace.
    // Do this after the independent fallible updates, avoiding an early logout
    // when a logger/tray update has already failed.
    if update_flags.contains(UpdateFlags::RESET_TEAM_SESSION) {
        crate::module::team_model::clear();
    }
    if update_flags.contains(UpdateFlags::INITIALIZE_WORKSPACE)
        && let Some(workspace_mode) = &config.workspace_mode
    {
        let scope = match workspace_mode {
            crate::config::WorkspaceMode::Team => dirs::default_team_workspace_scope(),
            crate::config::WorkspaceMode::Personal => dirs::WorkspaceScope::Personal,
        };
        dirs::initialize_active_workspace_scope(scope);
        if dirs::workspace_available() {
            init::ensure_active_workspace_directories().await?;
        }
        Config::reload_workspace().await;
        crate::module::run_manager::notify_supervisor();
        crate::module::deeplink::DeeplinkManager::global().notify_frontend();
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: serde_json::Value) -> WorkrunPatch {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn metadata_and_telemetry_updates_do_not_change_runtime_services() {
        assert_eq!(determine_update_flags(&patch(json!({}))), UpdateFlags::empty());
        assert_eq!(
            determine_update_flags(&patch(json!({"otlp_endpoint":"http://localhost:4317","theme":"dark"}))),
            UpdateFlags::empty()
        );
    }

    #[test]
    fn workspace_changes_also_reset_the_authenticated_team_connection() {
        for mode in ["personal", "team"] {
            assert_eq!(
                determine_update_flags(&patch(json!({"workspace_mode":mode}))),
                UpdateFlags::INITIALIZE_WORKSPACE | UpdateFlags::RESET_TEAM_SESSION
            );
        }
    }

    #[test]
    fn independent_changes_combine_without_workspace_side_effects() {
        assert_eq!(
            determine_update_flags(&patch(
                json!({"enable_auto_launch":false,"locale":"zh-CN","app_log_level":"debug","app_log_max_size":256})
            )),
            UpdateFlags::LAUNCH | UpdateFlags::LOCALE | UpdateFlags::LOG_LEVEL | UpdateFlags::LOG_FILE
        );
        assert_eq!(
            determine_update_flags(&patch(json!({"app_log_max_count":3}))),
            UpdateFlags::LOG_FILE
        );
    }
}
