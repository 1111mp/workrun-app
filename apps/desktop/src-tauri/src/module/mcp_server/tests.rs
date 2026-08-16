use super::*;
use crate::module::{process_node::ToolExecutionPolicy, tool_registry::ToolRiskLevel};
use adk_rust::{
    ToolContext,
    tool::{Tool, mcp::ServerStatus},
};
use serde_json::Value;
use std::{collections::HashMap, sync::Arc};

struct TestTool {
    name: String,
}

#[async_trait::async_trait]
impl Tool for TestTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        "Test MCP Tool"
    }

    async fn execute(&self, _context: Arc<dyn ToolContext>, _args: Value) -> adk_rust::Result<Value> {
        Ok(serde_json::json!({}))
    }
}

fn definition() -> McpServerDefinition {
    McpServerDefinition {
        id: "019b812d-4958-7d37-8a45-47e1e20a4744".into(),
        name: "Everything".into(),
        description: "MCP test server".into(),
        transport: McpServerTransport::Stdio,
        command: "npx".into(),
        args: vec!["-y".into(), "@modelcontextprotocol/server-everything".into()],
        env: HashMap::new(),
        url: String::new(),
        auth: McpServerAuth::None,
        bearer_token: None,
        oauth_credentials: None,
        enabled: true,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

#[test]
fn accepts_a_valid_stdio_server_definition() {
    assert!(validate_definition(&definition()).is_ok());
}

#[test]
fn accepts_a_valid_streamable_http_server_definition() {
    let mut server = definition();
    server.transport = McpServerTransport::StreamableHttp;
    server.command.clear();
    server.args.clear();
    server.url = "https://example.com/mcp".into();
    assert!(validate_definition(&server).is_ok());
}

#[test]
fn rejects_invalid_environment_variable_names() {
    let mut server = definition();
    server.env.insert("INVALID=NAME".into(), "value".into());
    assert!(validate_definition(&server).is_err());
}

#[test]
fn stdio_servers_use_a_bounded_restart_policy() {
    let policy = stdio_restart_policy();
    assert_eq!(policy.initial_delay_ms, 2_000);
    assert_eq!(policy.max_delay_ms, 15_000);
    assert_eq!(policy.max_restart_attempts, 3);
}

#[test]
fn health_records_the_latest_connection_result() {
    let id = "mcp-health-test";
    McpServerRegistry::record_health_success(id, Some(3));
    let healthy = McpServerRegistry::health(id);
    assert_eq!(healthy.tool_count, Some(3));
    assert!(healthy.last_error.is_none());
    assert!(healthy.last_checked_at.is_some());

    McpServerRegistry::record_health_error(id, "connection refused".into());
    let unhealthy = McpServerRegistry::health(id);
    assert_eq!(unhealthy.last_error.as_deref(), Some("connection refused"));
    assert_eq!(unhealthy.tool_count, Some(3));
}

#[test]
fn serializes_oauth_auth_with_a_stable_wire_value() {
    assert_eq!(serde_json::to_string(&McpServerAuth::OAuth).unwrap(), "\"oauth\"");
    assert_eq!(
        serde_json::from_str::<McpServerAuth>("\"oauth\"").unwrap(),
        McpServerAuth::OAuth
    );
    assert_eq!(
        serde_json::from_str::<McpServerAuth>("\"o_auth\"").unwrap(),
        McpServerAuth::OAuth
    );
}

#[test]
fn catalog_rejects_duplicate_server_ids() {
    let definition = definition();
    assert!(
        validate_catalog(&McpServerCatalog {
            servers: vec![definition.clone(), definition],
        })
        .is_err()
    );
}

#[test]
fn parses_stable_mcp_tool_ids() {
    assert_eq!(
        parse_tool_id("mcp:019b812d-4958-7d37-8a45-47e1e20a4744:echo").unwrap(),
        ("019b812d-4958-7d37-8a45-47e1e20a4744", "echo")
    );
    assert!(parse_tool_id("echo").is_err());
    assert!(parse_tool_id("mcp:server:").is_err());
}

#[test]
fn finds_mcp_tool_references_in_workflow_nodes() {
    let server_id = "019b812d-4958-7d37-8a45-47e1e20a4744";
    let prefix = format!("mcp:{server_id}:");
    assert!(workflow_uses_mcp_server(
        &serde_json::json!({
            "nodes": [{ "data": { "toolIds": [format!("{prefix}search")] } }],
        }),
        &prefix,
    ));
    assert!(!workflow_uses_mcp_server(
        &serde_json::json!({
            "nodes": [{ "data": { "toolIds": ["mcp:other:search"] } }],
        }),
        &prefix,
    ));
}

#[test]
fn namespaces_model_tool_names_by_server() {
    let first = definition();
    let mut second = definition();
    second.id = "019b812d-4958-7d37-8a45-47e1e20a4745".into();
    let tool = || Arc::new(TestTool { name: "search".into() }) as Arc<dyn Tool>;

    let first_tool = tool_definition(&first, tool());
    let second_tool = tool_definition(&second, tool());

    assert_eq!(first_tool.id, format!("mcp:{}:search", first.id));
    assert_ne!(first_tool.name, second_tool.name);
    assert_eq!(first_tool.risk_level, ToolRiskLevel::High);
    assert_eq!(first_tool.execution_policy, ToolExecutionPolicy::AskEveryTime);
}

#[test]
fn does_not_return_the_bearer_token_to_the_frontend() {
    let mut definition = definition();
    definition.bearer_token = Some("secret-token".into());
    let server = McpServer {
        definition,
        status: ServerStatus::Stopped,
        health: McpServerHealth::default(),
    };

    assert!(
        serde_json::to_value(server).unwrap()["definition"]
            .get("bearerToken")
            .is_none()
    );
}
