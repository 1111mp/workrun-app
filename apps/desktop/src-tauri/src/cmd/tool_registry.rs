use crate::{
    cmd::{CmdResult, StringifyErr as _},
    module::tool_registry::{ToolDefinition, ToolRegistry},
};

/// List every currently available Tool, independent of its implementation
/// source. MCP tools appear only while their server is running.
#[tauri::command]
pub async fn tool_list() -> CmdResult<Vec<ToolDefinition>> {
    ToolRegistry::list().await.stringify_err()
}
