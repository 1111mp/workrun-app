//! MCP server configuration, lifecycle, and tool discovery.
//!
//! The implementation is organized by responsibility under `mcp_server/`.

mod registry;
mod shutdown;
mod stdio;
mod types;
mod validation;

#[cfg(test)]
mod tests;

pub use registry::*;
pub use types::*;

pub(crate) use validation::*;

pub(crate) fn notify_changed() {
    let _ = crate::module::run_manager::emit_on_main_thread("mcp-servers-changed", ());
}
