use crate::{
    config::Config,
    core::handle,
    logging, logging_error,
    utils::{logging::Type, resolve::window_script::build_window_initial_script},
};
use anyhow::Result;
use dark_light::{Mode as SystemTheme, detect as detect_system_theme};
use tauri::{Theme, WebviewWindow, window::Color};

const DARK_BACKGROUND_COLOR: Color = Color(0, 0, 0, 255); // #000000
const LIGHT_BACKGROUND_COLOR: Color = Color(255, 255, 255, 255); // #ffffff

#[cfg(target_os = "linux")]
const DEFAULT_DECORATIONS: bool = false;
#[cfg(not(target_os = "linux"))]
const DEFAULT_DECORATIONS: bool = true;

pub async fn build_new_window() -> Result<WebviewWindow, String> {
    let app_handle = handle::Handle::app_handle();

    let config = Config::workrun().await;
    let workrun = config.latest_arc();
    let initial_theme_mode = match workrun.theme.as_deref() {
        Some("dark") => "dark",
        Some("light") => "light",
        _ => "system",
    };

    let system_theme = detect_system_theme().ok();
    let resolved_theme = match initial_theme_mode {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => match system_theme {
            Some(SystemTheme::Dark) => Some(Theme::Dark),
            Some(SystemTheme::Light) | Some(SystemTheme::Unspecified) | None => Some(Theme::Light),
        },
    };

    let prefers_dark_background = matches!(resolved_theme, Some(Theme::Dark));
    let background_color = if prefers_dark_background {
        DARK_BACKGROUND_COLOR
    } else {
        LIGHT_BACKGROUND_COLOR
    };

    let initial_theme_str = match resolved_theme {
        Some(Theme::Dark) => "dark",
        Some(Theme::Light) => "light",
        _ => "light",
    };

    let workrun_settings_json_str = serde_json::to_string(&workrun).map_err(|e| e.to_string())?;
    let initial_script = build_window_initial_script(&workrun_settings_json_str, initial_theme_str);

    let mut builder = tauri::WebviewWindowBuilder::new(app_handle, "main", tauri::WebviewUrl::App("index.html".into()))
        .title("Workrun")
        .decorations(DEFAULT_DECORATIONS)
        .inner_size(1080.0, 800.0)
        .min_inner_size(1080.0, 800.0)
        .resizable(true)
        .visible(false)
        // Because we use a self-signed certificate
        .additional_browser_args("--ignore-certificate-errors")
        .initialization_script(&initial_script)
        // Disable native OS drag-and-drop interception.
        // This allows HTML5 drag & drop events (e.g., react-dropzone) to work inside the Webview.
        .disable_drag_drop_handler()
        .center();

    #[cfg(target_os = "macos")]
    {
        builder = builder
            .hidden_title(true)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(11.0, 16.0));
    }

    #[cfg(target_os = "windows")]
    {
        builder = builder.title("");
    }

    if let Some(theme) = resolved_theme {
        builder = builder.theme(Some(theme));
    }

    builder = builder.background_color(background_color);

    match builder.build() {
        Ok(window) => {
            // logging_error!(
            //     Type::Window,
            //     window.set_background_color(Some(background_color))
            // );

            #[cfg(target_os = "macos")]
            take_webview_needs_reload();

            #[cfg(debug_assertions)]
            window.open_devtools();

            Ok(window)
        },
        Err(e) => Err(e.to_string()),
    }
}

/// Renderer process termination and pending page reload flag (macOS)
///
/// Set when the renderer process is terminated by the system while the window
/// is not visible. The flag is consumed when the window becomes active again,
/// triggering a reload.
#[cfg(target_os = "macos")]
static WEBVIEW_NEEDS_RELOAD: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Take and clear the "page needs reload" flag.
///
/// # Returns
/// * `bool` - Whether the renderer process was previously terminated while the
///   window was hidden and the page needs to be reloaded.
#[cfg(target_os = "macos")]
pub fn take_webview_needs_reload() -> bool {
    WEBVIEW_NEEDS_RELOAD.swap(false, std::sync::atomic::Ordering::SeqCst)
}

/// Handle WebView renderer process termination and recovery on macOS.
///
/// macOS may terminate the WKWebView WebContent renderer process under memory
/// pressure:
/// 1. The page content layer disappears, causing a blank window when reopened.
///
/// Recovery strategy:
/// * Window visible (rare foreground termination case) — reload immediately;
/// * Window hidden/minimized (common tray app scenario) — only mark as pending
///   reload and reload when the user opens the window again.
///
/// The system terminates hidden windows due to memory pressure. Reloading
/// immediately would unnecessarily allocate memory again and may create a
/// "system kills → app restores → system kills again" loop.
///
/// Note:
/// Registering `on_web_content_process_terminate` at the application level
/// overrides the default automatic reload behavior in `tauri-runtime-wry`.
/// Therefore, the page remains in the terminated state until we explicitly
/// reload it.
///
/// # Arguments
/// * `webview` - The WebView whose renderer process was terminated.
#[cfg(target_os = "macos")]
pub fn on_web_content_process_terminated(webview: &tauri::Webview) {
    if handle::Handle::global().is_exiting() {
        return;
    }

    logging!(
        warn,
        Type::Window,
        "WebView renderer process terminated by system (label={}), starting recovery",
        webview.label()
    );

    let window = webview.window();
    let is_user_visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);

    // The pending reload flag is only consumed by the main window.
    // Other webviews (such as update-splash) have no consumer path, so they
    // reload immediately when not visible as a fallback.
    let is_main_window = webview.label() == "main";
    let reload_now = is_user_visible || !is_main_window;

    if !reload_now {
        // Main window is hidden: mark pending reload and wait until the next
        // activate_window / reload_main_window_if_needed call.

        WEBVIEW_NEEDS_RELOAD.store(true, std::sync::atomic::Ordering::SeqCst);
        logging!(
            info,
            Type::Window,
            "Window is hidden, page reload will be performed when opened next time"
        );
    }

    let webview = webview.clone();
    crate::process::AsyncHandler::spawn(move || async move {
        if reload_now {
            logging_error!(Type::Window, webview.reload());
        }
    });
}

/// Consume pending reload flag and reload the main window (macOS).
///
/// Handles cases where native window restoration (Dock thumbnail, Mission
/// Control, or window menu) only triggers `Focused(true)` without calling
/// `activate_window`.
///
/// Shares the same atomic flag with `activate_window`; whichever path consumes
/// the flag first performs the reload to avoid duplicate reloads.
#[cfg(target_os = "macos")]
pub fn reload_main_window_if_needed() {
    if !take_webview_needs_reload() {
        return;
    }
    let Some(window) = crate::utils::window_manager::WindowManager::get_main_window() else {
        return;
    };

    logging!(
        info,
        Type::Window,
        "Renderer process was terminated previously, reloading page after window focus"
    );

    if let Err(e) = window.reload() {
        logging!(warn, Type::Window, "Failed to reload page: {e}");
    }
}
