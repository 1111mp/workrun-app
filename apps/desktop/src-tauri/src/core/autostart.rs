#[cfg(not(target_os = "windows"))]
use crate::logging_error;
#[cfg(target_os = "windows")]
use crate::utils::schtasks;
#[allow(unused_imports)]
use crate::{config::Config, core::handle::Handle, logging, utils::logging::Type};
use anyhow::Result;
#[cfg(windows)]
use deelevate::{PrivilegeLevel, Token};
#[cfg(unix)]
pub use libc;
#[cfg(not(target_os = "windows"))]
use tauri_plugin_autostart::ManagerExt as _;

pub async fn update_launch() -> Result<()> {
    let enable_auto_launch = { Config::workrun().await.latest_arc().enable_auto_launch };
    let is_enable = enable_auto_launch.unwrap_or(false);
    logging!(info, Type::System, "Setting auto-launch enabled state to: {is_enable}");

    #[cfg(target_os = "windows")]
    {
        let is_admin = is_binary_admin();
        schtasks::set_auto_launch(is_enable, is_admin).await?;
    }

    #[cfg(not(target_os = "windows"))]
    {
        let app_handle = Handle::app_handle();
        let autostart_manager = app_handle.autolaunch();
        if is_enable {
            logging_error!(Type::System, "{:?}", autostart_manager.enable());
        } else {
            logging_error!(Type::System, "{:?}", autostart_manager.disable());
        }
    }

    Ok(())
}

pub fn is_binary_admin() -> bool {
    #[cfg(not(windows))]
    unsafe {
        libc::geteuid() == 0
    }

    #[cfg(windows)]
    Token::with_current_process()
        .and_then(|token| token.privilege_level())
        .map(|level| level != PrivilegeLevel::NotPrivileged)
        .unwrap_or(false)
}
