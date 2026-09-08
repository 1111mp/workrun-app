use crate::{
    config::BaseConfig,
    core::{db, logger::Logger, tray::Tray},
    logging, logging_error,
    module::{ipc::IpcServer, run_manager},
    process::AsyncHandler,
    utils::{init, logging::Type, window_manager::WindowManager},
};
use anyhow::Result;

pub mod window;
pub mod window_script;

pub fn init_work_dir_and_logger() -> Result<()> {
    AsyncHandler::block_on(async {
        init_work_config().await;
        logging!(info, Type::Setup, "Initializing logger");
        Logger::global().init().await?;
        Ok(())
    })
}

pub fn resolve_server_setup_async() {
    AsyncHandler::spawn(|| async {
        if let Err(error) = db::DBManager::global().init().await {
            logging!(error, Type::Setup, "Failed to initialize database: {error:#}");
            return;
        }
        if let Err(error) = IpcServer::global().start().await {
            logging!(error, Type::Setup, "Failed to initialize IPC server: {error:#}");
            return;
        }
        // Queued Apps can create an IPC session as soon as they are claimed.
        // Start dispatch only after every native dependency they need is ready.
        run_manager::start_supervisor();
    });
}

pub fn resolve_setup_async() {
    AsyncHandler::spawn(|| async {
        logging!(info, Type::Workrun, "Version: {}", env!("CARGO_PKG_VERSION"));

        #[cfg(target_os = "macos")]
        resolve_dock_show().await;
        init_window().await;

        let _ = futures::join!(init_tray());

        refresh_tray_menu().await;
    });
}

pub async fn init_work_config() {
    logging_error!(Type::Setup, init::init_config().await);
}

pub(super) async fn init_tray() {
    logging_error!(Type::Setup, Tray::global().init().await);
}

pub(super) async fn refresh_tray_menu() {
    logging_error!(Type::Setup, Tray::global().update_part().await);
}

pub(super) async fn init_window() {
    let is_silent_start = BaseConfig::workrun()
        .await
        .data_arc()
        .enable_silent_start
        .unwrap_or(false);
    WindowManager::create_window(!is_silent_start).await;
}

#[cfg(target_os = "macos")]
pub(super) async fn resolve_dock_show() {
    use crate::config::BaseConfig;

    let is_silent_start = BaseConfig::workrun()
        .await
        .data_arc()
        .enable_silent_start
        .unwrap_or(false);
    if is_silent_start {
        use crate::core::handle::Handle;
        Handle::global().set_activation_policy_accessory();
    }
}
