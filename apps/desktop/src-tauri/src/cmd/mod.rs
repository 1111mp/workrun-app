use anyhow::Result;

// Common result type used by command functions
pub type CmdResult<T = ()> = Result<T, String>;

pub mod app;
pub mod artifact;
pub mod assistant;
pub mod chat_session;
pub mod deeplink;
pub mod evaluation;
pub mod ipc;
pub mod mcp_server;
pub mod model;
pub mod model_usage;
pub mod process_node;
pub mod python_runtime;
pub mod remote_agent;
pub mod run_history;
pub mod run_manager;
pub mod schedule;
pub mod skill;
pub mod system;
pub mod tool_registry;
pub mod workflow;
pub mod workflow_catalog;
pub mod workflow_share;
pub mod workrun;

#[allow(unused)]
pub trait StringifyErr<T> {
    fn stringify_err(self) -> CmdResult<T>;
    fn stringify_err_log<F>(self, log_fn: F) -> CmdResult<T>
    where
        F: Fn(&str);
}

impl<T, E: std::fmt::Display> StringifyErr<T> for Result<T, E> {
    fn stringify_err(self) -> CmdResult<T> {
        self.map_err(|e| e.to_string())
    }

    fn stringify_err_log<F>(self, log_fn: F) -> CmdResult<T>
    where
        F: Fn(&str),
    {
        self.map_err(|e| {
            let msg = e.to_string();
            log_fn(&msg);
            msg
        })
    }
}

pub mod schedule_agent;

// Authentication/configuration remains available before a Team workspace exists.
fn requires_workspace(command: &str) -> bool {
    !matches!(
        command,
        "get_workrun_config"
            | "patch_workrun_config"
            | "get_system_theme"
            | "schedule_set_team_session"
            | "restart_app"
    )
}

pub(crate) fn require_workspace<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if !crate::utils::dirs::workspace_available() && requires_workspace(invoke.message.command()) {
            invoke.resolver.reject("Sign in to access Team data");
            return true;
        }
        handler(invoke)
    }
}

#[cfg(test)]
mod workspace_gate_tests {
    #[test]
    fn login_and_settings_are_available_but_business_commands_require_a_workspace() {
        for command in [
            "schedule_set_team_session",
            "get_workrun_config",
            "patch_workrun_config",
            "get_system_theme",
        ] {
            assert!(!super::requires_workspace(command));
        }
        for command in [
            "chat_session_get",
            "run_history_list",
            "workflow_run_start",
            "process_node_install_archive",
            "skill_list",
            "schedule_list",
            "remote_credentials_list",
            "unknown_command",
        ] {
            assert!(super::requires_workspace(command));
        }
    }
}
