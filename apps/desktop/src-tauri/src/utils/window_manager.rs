use tauri::{Manager as _, WebviewWindow, Wry};

use crate::{
    core::handle,
    logging,
    utils::{logging::Type, resolve::window::build_new_window},
};
use std::pin::Pin;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowOperationResult {
    /// 窗口已显示并获得焦点
    Shown,
    /// 窗口已隐藏
    Hidden,
    /// 创建了新窗口
    Created,
    /// 摧毁了窗口
    Destroyed,
    /// 操作失败
    Failed,
    /// 无需操作
    NoAction,
}

/// 窗口状态
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum WindowState {
    /// 窗口可见且有焦点
    VisibleFocused,
    /// 窗口可见但无焦点
    VisibleUnfocused,
    /// 窗口最小化
    Minimized,
    /// 窗口隐藏
    Hidden,
    /// 窗口不存在
    NotExist,
}

pub struct WindowManager;

impl WindowManager {
    #[cfg(target_os = "macos")]
    fn set_macos_activation_policy_regular() {
        handle::Handle::global().set_activation_policy_regular();
    }

    pub fn get_main_window_with_state() -> (Option<WebviewWindow<Wry>>, WindowState) {
        let Some(window) = Self::get_main_window() else {
            return (None, WindowState::NotExist);
        };

        let is_minimized = window.is_minimized().unwrap_or(false);
        let is_visible = window.is_visible().unwrap_or(false);
        let is_focused = window.is_focused().unwrap_or(false);

        let state = if is_minimized {
            WindowState::Minimized
        } else if !is_visible {
            WindowState::Hidden
        } else if is_focused {
            WindowState::VisibleFocused
        } else {
            WindowState::VisibleUnfocused
        };

        (Some(window), state)
    }

    pub fn get_main_window_state() -> WindowState {
        match Self::get_main_window() {
            Some(window) => {
                let is_minimized = window.is_minimized().unwrap_or(false);
                let is_visible = window.is_visible().unwrap_or(false);
                let is_focused = window.is_focused().unwrap_or(false);

                if is_minimized {
                    return WindowState::Minimized;
                }

                if !is_visible {
                    return WindowState::Hidden;
                }

                if is_focused {
                    WindowState::VisibleFocused
                } else {
                    WindowState::VisibleUnfocused
                }
            },
            None => WindowState::NotExist,
        }
    }

    /// 获取主窗口实例
    pub fn get_main_window() -> Option<WebviewWindow<Wry>> {
        let app_handle = handle::Handle::app_handle();
        app_handle.get_webview_window("main")
    }

    pub fn create_window(should_create: bool) -> Pin<Box<dyn Future<Output = bool> + Send>> {
        Box::pin(async move {
            logging!(
                info,
                Type::Window,
                "Starting to create main window, should_create={}",
                should_create
            );

            if !should_create {
                return false;
            }

            #[cfg(target_os = "macos")]
            Self::set_macos_activation_policy_regular();

            match build_new_window().await {
                Ok(_) => {
                    logging!(
                        info,
                        Type::Window,
                        "New window created successfully, waiting for frontend rendering before showing"
                    );

                    true
                },
                Err(e) => {
                    logging!(error, Type::Window, "Failed to create new window: {}", e);
                    false
                },
            }
        })
    }

    pub async fn show_main_window() -> WindowOperationResult {
        logging!(info, Type::Window, "Launch the Smart Display main window.");
        logging!(debug, Type::Window, "{}", Self::get_window_status_info());

        let current_state = Self::get_main_window_state();

        match current_state {
            WindowState::NotExist => {
                logging!(info, Type::Window, "Window does not exist; creating a new window.");
                if Self::create_window(true).await {
                    logging!(info, Type::Window, "Window created successfully.");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    WindowOperationResult::Created
                } else {
                    logging!(warn, Type::Window, "Window creation failed.");
                    WindowOperationResult::Failed
                }
            },
            WindowState::VisibleFocused => {
                logging!(
                    info,
                    Type::Window,
                    "The window is already visible and has focus; no action is required."
                );
                WindowOperationResult::NoAction
            },
            WindowState::VisibleUnfocused | WindowState::Minimized | WindowState::Hidden => {
                let (window, state_after_check) = Self::get_main_window_with_state();
                if state_after_check == WindowState::VisibleFocused {
                    logging!(
                        info,
                        Type::Window,
                        "The window became visible and gained focus during the check."
                    );
                    return WindowOperationResult::NoAction;
                }
                if let Some(window) = window {
                    Self::activate_window(&window)
                } else {
                    WindowOperationResult::Failed
                }
            },
        }
    }

    fn get_window_status_info() -> String {
        let (window, state) = Self::get_main_window_with_state();
        let is_visible = Self::is_main_window_visible(window.as_ref());
        let is_focused = Self::is_main_window_focused(window.as_ref());
        let is_minimized = Self::is_main_window_minimized(window.as_ref());

        format!("Window state: {state:?} | Visible: {is_visible} | Focused: {is_focused} | Minimized: {is_minimized}")
    }

    /// 激活窗口（取消最小化、显示、设置焦点）
    fn activate_window(window: &WebviewWindow<Wry>) -> WindowOperationResult {
        logging!(info, Type::Window, "Starting window activation");
        #[cfg(target_os = "macos")]
        Self::set_macos_activation_policy_regular();

        // 渲染进程曾被系统终止：先 reload，并把 show+focus 交给 on_page_load(Finished)，
        // 内容就绪再显示，避免白屏闪烁。reload 成功才 defer，失败则走下方直接显示。
        #[allow(unused_mut)]
        let mut defer_show_to_page_load = false;
        #[cfg(target_os = "macos")]
        if crate::utils::resolve::window::take_webview_needs_reload() {
            logging!(
                info,
                Type::Window,
                "The rendering process was terminated by the system; the page was reloaded before the window was activated."
            );
            match window.reload() {
                Ok(()) => defer_show_to_page_load = true,
                Err(e) => logging!(
                    warn,
                    Type::Window,
                    "Failed to reload the page; reverting to direct display: {}",
                    e
                ),
            }
        }

        let mut operations_successful = true;

        // 1. 如果窗口最小化，先取消最小化
        if window.is_minimized().unwrap_or(false) {
            logging!(info, Type::Window, "The window has been minimized; restoring it now");
            if let Err(e) = window.unminimize() {
                logging!(warn, Type::Window, "Failed to restore from minimized state: {}", e);
                operations_successful = false;
            }
        }

        // 2/3. 显示 + 焦点（reload 分支跳过，交给 on_page_load）
        if !defer_show_to_page_load {
            if let Err(e) = window.show() {
                logging!(warn, Type::Window, "Failed to display window: {}", e);
                operations_successful = false;
            }
            if let Err(e) = window.set_focus() {
                logging!(warn, Type::Window, "Failed to set window focus: {}", e);
                operations_successful = false;
            }
        }

        #[cfg(target_os = "windows")]
        {
            // Windows 尝试额外的激活方法
            if let Err(e) = window.set_always_on_top(true) {
                logging!(debug, Type::Window, "Failed to set window always on top: {}", e);
            }
            // 立即取消置顶
            if let Err(e) = window.set_always_on_top(false) {
                logging!(debug, Type::Window, "Failed to remove window always on top: {}", e);
            }
        }

        if operations_successful {
            logging!(info, Type::Window, "Window activation succeeded");
            WindowOperationResult::Shown
        } else {
            logging!(warn, Type::Window, "Window activation failed");
            WindowOperationResult::Failed
        }
    }

    /// 检查窗口是否可见
    pub fn is_main_window_visible(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false)
    }

    /// 检查窗口是否有焦点
    pub fn is_main_window_focused(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_focused().unwrap_or(false)).unwrap_or(false)
    }

    /// 检查窗口是否最小化
    pub fn is_main_window_minimized(window: Option<&WebviewWindow<Wry>>) -> bool {
        window.map(|w| w.is_minimized().unwrap_or(false)).unwrap_or(false)
    }
}
