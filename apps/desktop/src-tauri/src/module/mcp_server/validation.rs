use super::{McpServerDefinition, McpServerTransport};
use crate::module::{
    process_node::ToolExecutionPolicy,
    tool_registry::{ToolDefinition, ToolRiskLevel, ToolSource},
};
use adk_rust::tool::Tool;
use anyhow::{Context, Result, bail};
use std::{collections::HashSet, sync::Arc};
use uuid::Uuid;

pub(super) fn validate_catalog(catalog: &super::McpServerCatalog) -> Result<()> {
    let mut ids = HashSet::new();
    for definition in &catalog.servers {
        validate_definition(definition)?;
        if !ids.insert(&definition.id) {
            bail!("MCP Server catalog contains duplicate id {:?}", definition.id);
        }
    }
    Ok(())
}

pub(super) fn validate_definition(definition: &McpServerDefinition) -> Result<()> {
    validate_id(&definition.id)?;
    if definition.name.trim().is_empty() {
        bail!("MCP Server name must not be empty");
    }
    match definition.transport {
        McpServerTransport::Stdio => {
            if definition.command.trim().is_empty() {
                bail!("stdio MCP Server command must not be empty");
            }
            if definition.args.iter().any(|argument| argument.contains('\0')) {
                bail!("MCP Server arguments must not contain null bytes");
            }
            for (name, value) in &definition.env {
                if name.trim().is_empty() || name.contains(['=', '\0']) {
                    bail!("MCP Server environment variable names must not be empty or contain '='");
                }
                if value.contains('\0') {
                    bail!("MCP Server environment variable values must not contain null bytes");
                }
            }
        },
        McpServerTransport::StreamableHttp => {
            let url = definition.url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                bail!("Streamable HTTP MCP Server URL must start with http:// or https://");
            }
        },
    }
    Ok(())
}

pub(super) fn validate_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).with_context(|| format!("MCP Server id must be a UUID, got {id:?}"))?;
    if uuid.hyphenated().to_string() != id {
        bail!("MCP Server id must be a lowercase, hyphenated UUID");
    }
    Ok(())
}

pub(super) fn parse_tool_id(id: &str) -> Result<(&str, &str)> {
    let (server_id, tool_name) = id
        .strip_prefix("mcp:")
        .and_then(|value| value.split_once(':'))
        .ok_or_else(|| anyhow::anyhow!("MCP Tool id is invalid: {id}"))?;
    if tool_name.is_empty() {
        bail!("MCP Tool id is invalid: {id}");
    }
    Ok((server_id, tool_name))
}

pub(super) fn workflow_uses_mcp_server(document: &serde_json::Value, prefix: &str) -> bool {
    document
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|node| node.pointer("/data/toolIds").and_then(serde_json::Value::as_array))
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .any(|tool_id| tool_id.starts_with(prefix))
}

pub(super) fn tool_definition(server: &McpServerDefinition, tool: Arc<dyn Tool>) -> ToolDefinition {
    ToolDefinition {
        id: format!("mcp:{}:{}", server.id, tool.name()),
        source: ToolSource::Mcp,
        source_id: Some(server.id.clone()),
        source_name: Some(server.name.clone()),
        display_name: tool.name().to_string(),
        // MCP only guarantees uniqueness within one server. Agent tool names
        // must remain unambiguous when two selected servers expose `search`.
        name: format!("mcp_{}_{}", server.id.replace('-', ""), tool.name().replace('-', "_")),
        description: tool.description().to_string(),
        version: "mcp".to_string(),
        input_schema: tool
            .parameters_schema()
            .unwrap_or_else(|| serde_json::json!({ "type": "object" })),
        output_schema: tool.response_schema().unwrap_or_else(|| serde_json::json!({})),
        risk_level: if tool.is_read_only() {
            ToolRiskLevel::Low
        } else {
            ToolRiskLevel::High
        },
        permissions: Vec::new(),
        execution_policy: ToolExecutionPolicy::AskEveryTime,
    }
}
