use crate::{
    core::handle,
    logging,
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

    // let _ = server::stop_http_server().await;

    let app_handle = handle::Handle::app_handle();
    app_handle.exit(0);
}
