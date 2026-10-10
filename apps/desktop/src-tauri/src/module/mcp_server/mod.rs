//! MCP server configuration, lifecycle, and tool discovery.
//!
//! The implementation is organized by responsibility under `mcp_server/`.

mod registry;
mod stdio;
mod types;
mod validation;

#[cfg(test)]
mod tests;

pub use registry::*;
pub use types::*;

pub(crate) use validation::*;

pub(crate) fn notify_changed() {
    use tauri::Emitter;
    if let Some(app_handle) = crate::APP_HANDLE.get() {
        let _ = app_handle.emit("mcp-servers-changed", ());
    }
}
