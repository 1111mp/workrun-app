mod cmd;
mod config;
mod core;
mod feat;
mod module;
mod process;
mod utils;

use crate::{
    core::handle,
    process::AsyncHandler,
    utils::{resolve, window_manager::WindowManager},
};
use once_cell::sync::OnceCell;
use tauri::{AppHandle, Manager as _};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::MacosLauncher;
use utils::logging::Type;

pub static APP_HANDLE: OnceCell<AppHandle> = OnceCell::new();

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = utils::dirs::init_portable_flag();

    #[cfg(target_os = "linux")]
    utils::linux::workarounds::apply_nvidia_dmabuf_renderer_workaround();
    #[cfg(target_os = "linux")]
    utils::linux::workarounds::apply_wayland_webkit_fix();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        // The deep-link feature requires this plugin to be registered first.
        .plugin(
            tauri_plugin_single_instance::Builder::new()
                // Set a custom D-Bus ID, used on Linux
                // Defaults to the app's bundle identifier set in tauri.conf.json.
                .dbus_id("io.github.mp1111.workrun")
                .callback(|app_handle, _argc, _cwd| {
                    if let Some(window) = app_handle.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            APP_HANDLE
                .set(app.app_handle().clone())
                .expect("failed to set global app handle");

            resolve::init_work_dir_and_logger()?;

            logging!(info, Type::Setup, "Starting application initialization...");

            if let Err(e) = setup_autostart(app) {
                logging!(error, Type::Setup, "Failed to setup autostart: {}", e);
            }

            if let Err(e) = setup_window_state(app) {
                logging!(error, Type::Setup, "Failed to setup window state: {}", e);
            }

            resolve::resolve_setup_async();
            resolve::resolve_server_setup_async();

            logging!(info, Type::Setup, "Setup has started.");

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // workrun
            cmd::workrun::get_workrun_config,
            cmd::workrun::patch_workrun_config,
            cmd::model::model_catalog_list,
            cmd::mcp_server::mcp_server_list,
            cmd::mcp_server::mcp_server_create,
            cmd::mcp_server::mcp_server_update,
            cmd::mcp_server::mcp_server_delete,
            cmd::mcp_server::mcp_server_test_connection,
            cmd::mcp_server::mcp_server_workflow_references,
            cmd::mcp_server::mcp_server_start,
            cmd::mcp_server::mcp_server_stop,
            cmd::mcp_server::mcp_server_reconnect,
            cmd::mcp_server::mcp_server_authorize,
            cmd::tool_registry::tool_list,
            cmd::skill::skill_list,
            cmd::skill::skill_inspect,
            cmd::skill::skill_create,
            cmd::skill::skill_update,
            cmd::skill::skill_delete,
            cmd::skill::skill_open_directory,
            cmd::skill::skill_open_folder,
            cmd::ipc::python_ui_respond,
            // statically provisioned Process Nodes
            cmd::process_node::process_node_list,
            cmd::process_node::process_node_tool_list,
            cmd::process_node::process_node_inspect,
            cmd::process_node::process_node_open_project,
            cmd::process_node::process_node_default_root,
            cmd::process_node::process_node_create,
            cmd::process_node::process_node_update,
            cmd::process_node::process_node_delete,
            cmd::process_node::process_node_workflow_references,
            cmd::process_node::process_node_run,
            // workflow
            cmd::workflow::workflow_compile,
            cmd::workflow::workflow_run,
            cmd::workflow::workflow_resolve_human_review,
            cmd::workflow::workflow_resolve_ask_user_question,
            cmd::workflow_catalog::workflow_catalog_list,
            cmd::workflow_catalog::workflow_catalog_create,
            cmd::workflow_catalog::workflow_catalog_inspect,
            cmd::workflow_catalog::workflow_catalog_update,
            // Python runtime
            cmd::python_runtime::uv_version,
            cmd::python_runtime::ensure_python,
            cmd::python_runtime::ensure_venv,
            cmd::python_runtime::sync_dependencies,
            cmd::python_runtime::run_project_python,
            // system
            cmd::system::get_system_theme,
        ]);

    // Under memory pressure on macOS, the WKWebView rendering process may be
    // terminated by the system (resulting in a blank window).
    // Register a recovery hook: reload immediately if the window is visible;
    // otherwise, defer the reload until the next time the user opens the window.
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(resolve::window::on_web_content_process_terminated);

    // Devtools plugin only in debug mode with feature tauri-dev
    // to avoid duplicated registering of logger since the devtools plugin also registers a logger
    #[cfg(all(debug_assertions, not(feature = "tokio-trace"), feature = "tauri-dev"))]
    {
        builder = builder.plugin(tauri_plugin_devtools::init());
    }

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while running tauri application");

    #[allow(unused)]
    app.run(|app_handle, evt| match evt {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen {
            has_visible_windows, ..
        } => {
            if core::handle::Handle::global().is_exiting() {
                return;
            }
            AsyncHandler::spawn(move || async move {
                if !has_visible_windows {
                    handle::Handle::global().set_activation_policy_regular();
                    let _ = WindowManager::show_main_window().await;
                }
            });
        },
        tauri::RunEvent::Exit => AsyncHandler::block_on(async {
            // Windows session ending currently reaches Tao as WM_ENDSESSION and
            // destroys the loop without a preventable ExitRequested event.
            if !handle::Handle::global().is_exiting() {
                feat::quit().await;
            }
            logging!(info, Type::System, "Application exited");
        }),
        #[allow(unused_variables)]
        tauri::RunEvent::ExitRequested { api, code, .. } => {
            if code.is_none() {
                api.prevent_exit();
                if !handle::Handle::global().is_exiting() {
                    AsyncHandler::block_on(async {
                        feat::quit().await;
                    });
                }
            }
        },
        tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                #[cfg(target_os = "macos")]
                handle::Handle::global().set_activation_policy_accessory();

                if core::handle::Handle::global().is_exiting() {
                    return;
                }

                api.prevent_close();
                if let Some(window) = WindowManager::get_main_window() {
                    let _ = window.hide();
                }
            },
            tauri::WindowEvent::Focused(focused) =>
            {
                #[cfg(target_os = "macos")]
                if focused {
                    resolve::window::reload_main_window_if_needed();
                }
            },
            #[cfg(target_os = "macos")]
            tauri::WindowEvent::Destroyed => {},
            _ => {},
        },
        _ => {},
    });
}

/// Setup autostart plugin
pub fn setup_autostart(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    let mut auto_start_plugin_builder = tauri_plugin_autostart::Builder::new();
    #[cfg(not(target_os = "macos"))]
    let auto_start_plugin_builder = tauri_plugin_autostart::Builder::new();

    #[cfg(target_os = "macos")]
    {
        auto_start_plugin_builder = auto_start_plugin_builder
            .macos_launcher(MacosLauncher::LaunchAgent)
            .app_name(&app.config().identifier);
    }
    app.handle().plugin(auto_start_plugin_builder.build())?;
    Ok(())
}

pub fn setup_window_state(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    logging!(info, Type::Setup, "Set up window state management...");
    let window_state_plugin = tauri_plugin_window_state::Builder::new()
        .with_state_flags(tauri_plugin_window_state::StateFlags::default())
        .build();
    app.handle().plugin(window_state_plugin)?;
    Ok(())
}
