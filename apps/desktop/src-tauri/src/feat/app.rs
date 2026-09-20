use crate::{
    config::{BaseConfig, Config},
    core::{handle, telemetry},
    logging,
    module::{mcp_server::McpServerRegistry, run_manager},
    utils::{dirs, logging::Type},
};
use anyhow::Result;

/// open app config dir
pub async fn open_config_dir() -> Result<()> {
    let data_dir = dirs::app_home_dir()?;
    open::that(data_dir)?;
    Ok(())
}

/// open app logs dir
pub async fn open_logs_dir() -> Result<()> {
    let logs_dir = dirs::app_logs_dir()?;
    open::that(logs_dir)?;
    Ok(())
}

pub async fn restart_app() {
    logging!(debug, Type::System, "Startup and Restart Application Process");

    handle::Handle::global().set_is_exiting();

    BaseConfig::apply_and_save_file().await;
    Config::apply_all_and_save_file().await;

    run_manager::shutdown_supervisor().await;
    telemetry::shutdown();

    if let Err(error) = McpServerRegistry::shutdown_all().await {
        logging!(error, Type::System, "Failed to stop MCP servers: {}", error);
    }

    let app_handle = handle::Handle::app_handle();
    app_handle.restart();
}
