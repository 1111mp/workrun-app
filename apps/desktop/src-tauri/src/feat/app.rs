use crate::{config::Config, core::handle, utils::dirs};
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
    handle::Handle::global().set_is_exiting();

    Config::apply_all_and_save_file().await;

    let app_handle = handle::Handle::app_handle();
    app_handle.restart();
}
