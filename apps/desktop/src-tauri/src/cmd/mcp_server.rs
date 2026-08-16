use crate::{
    cmd::{CmdResult, StringifyErr as _},
    module::mcp_server::{
        CreateMcpServerRequest, McpServer, McpServerConnectionTest, McpServerDefinition, McpServerRegistry,
        McpServerWorkflowReference, TestMcpServerConnectionRequest,
    },
};

#[tauri::command]
pub async fn mcp_server_list() -> CmdResult<Vec<McpServer>> {
    McpServerRegistry::list().await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_create(request: CreateMcpServerRequest) -> CmdResult<McpServer> {
    McpServerRegistry::create(request).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_update(definition: McpServerDefinition) -> CmdResult<McpServer> {
    McpServerRegistry::update(definition).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_delete(id: String) -> CmdResult {
    McpServerRegistry::delete(&id).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_test_connection(request: TestMcpServerConnectionRequest) -> CmdResult<McpServerConnectionTest> {
    McpServerRegistry::test_connection(request).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_workflow_references(id: String) -> CmdResult<Vec<McpServerWorkflowReference>> {
    McpServerRegistry::workflow_references(&id).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_start(id: String) -> CmdResult<McpServer> {
    McpServerRegistry::start(&id).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_stop(id: String) -> CmdResult<McpServer> {
    McpServerRegistry::stop(&id).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_reconnect(id: String) -> CmdResult<McpServer> {
    McpServerRegistry::reconnect(&id).await.stringify_err()
}

#[tauri::command]
pub async fn mcp_server_authorize(id: String) -> CmdResult {
    McpServerRegistry::authorize(&id).await.stringify_err()
}
