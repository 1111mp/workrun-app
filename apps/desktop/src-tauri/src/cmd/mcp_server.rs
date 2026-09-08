use crate::{
    cmd::{CmdResult, StringifyErr as _},
    config::IMcpServer,
    feat,
    module::mcp_server::{McpServer, McpServerConnectionTest, McpServerRegistry, McpServerWorkflowReference},
};

#[tauri::command]
pub async fn get_mcp_servers() -> CmdResult<Vec<McpServer>> {
    feat::get_mcp_servers().await.stringify_err()
}

#[tauri::command]
pub async fn create_mcp_server(request: feat::CreateMcpServerRequest) -> CmdResult<McpServer> {
    feat::create_mcp_server(request).await.stringify_err()
}

#[tauri::command]
pub async fn update_mcp_server(definition: IMcpServer) -> CmdResult<McpServer> {
    feat::update_mcp_server(definition).await.stringify_err()
}

#[tauri::command]
pub async fn delete_mcp_server(id: String) -> CmdResult {
    feat::delete_mcp_server(&id).await.stringify_err()
}

#[tauri::command]
pub async fn test_mcp_server_connection(
    request: feat::TestMcpServerConnectionRequest,
) -> CmdResult<McpServerConnectionTest> {
    feat::test_mcp_server_connection(request).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_workflow_references(id: String) -> CmdResult<Vec<McpServerWorkflowReference>> {
    McpServerRegistry::workflow_references(&id).await.stringify_err()
}

#[tauri::command]
pub async fn start_mcp_server(id: String) -> CmdResult<McpServer> {
    feat::start_mcp_server(&id).await.stringify_err()
}

#[tauri::command]
pub async fn stop_mcp_server(id: String) -> CmdResult<McpServer> {
    feat::stop_mcp_server(&id).await.stringify_err()
}

#[tauri::command]
pub async fn reconnect_mcp_server(id: String) -> CmdResult<McpServer> {
    feat::reconnect_mcp_server(&id).await.stringify_err()
}

#[tauri::command]
pub async fn authorize_mcp_server(id: String) -> CmdResult {
    feat::authorize_mcp_server(&id).await.stringify_err()
}
