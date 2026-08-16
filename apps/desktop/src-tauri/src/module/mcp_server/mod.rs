//! MCP server configuration, lifecycle, and tool discovery.
//!
//! The implementation is organized by responsibility under `mcp_server/`.

mod registry;
mod types;
mod validation;

#[cfg(test)]
mod tests;

pub use registry::*;
pub use types::*;

use validation::*;
