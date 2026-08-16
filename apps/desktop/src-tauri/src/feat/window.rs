use crate::{
    core::handle,
    logging,
    module::mcp_server::McpServerRegistry,
    utils::{logging::Type, window_manager::WindowManager},
};

pub fn open_devtools() {
    if let Some(window) = WindowManager::get_main_window() {
        if !window.is_devtools_open() {
            window.open_devtools();
        } else {
            window.close_devtools();
        }
    }
}

pub async fn quit() {
    logging!(debug, Type::System, "Starting shutdown process");

    handle::Handle::global().set_is_exiting();

    if let Err(error) = McpServerRegistry::shutdown_all().await {
        logging!(error, Type::System, "Failed to stop MCP servers: {}", error);
    }

    let app_handle = handle::Handle::app_handle();
    app_handle.exit(0);
}
