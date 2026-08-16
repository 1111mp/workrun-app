//! Source-agnostic Tool catalog used by Agent nodes.
//!
//! Individual sources own discovery and execution. This module keeps the
//! Agent-facing contract stable as Process Apps are joined by MCP tools.

use crate::module::{
    mcp_server::McpServerRegistry,
    process_node::{ProcessNodeRegistry, ToolExecutionPolicy},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Process,
    Mcp,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolRiskLevel {
    #[default]
    Low,
    Medium,
    High,
}

/// A Tool definition that can be selected by an Agent independent of its
/// implementation source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDefinition {
    /// Stable source-local id. Existing workflow `toolIds` use this value.
    pub id: String,
    pub source: ToolSource,
    /// Identifier of the server or other source that published this tool.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// Human-readable name of the source used by the selection UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_name: Option<String>,
    pub display_name: String,
    pub name: String,
    pub description: String,
    pub version: String,
    pub input_schema: Value,
    pub output_schema: Value,
    pub risk_level: ToolRiskLevel,
    pub permissions: Vec<String>,
    pub execution_policy: ToolExecutionPolicy,
}

/// Resolves tools for Agent nodes. New sources extend this registry rather
/// than requiring changes to the Agent UI or workflow compiler.
pub struct ToolRegistry;

impl ToolRegistry {
    pub async fn list() -> Result<Vec<ToolDefinition>> {
        let mut tools = ProcessNodeRegistry::list_tool_definitions().await?;
        tools.extend(McpServerRegistry::list_tool_definitions().await?);
        Ok(tools)
    }

    pub async fn resolve(ids: &[String]) -> Result<Vec<ToolDefinition>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let process_tools = ProcessNodeRegistry::list_tool_definitions().await?;
        let mut tools = Vec::with_capacity(ids.len());
        for id in ids {
            if id.starts_with("mcp:") {
                tools.push(McpServerRegistry::resolve_tool(id).await?.0);
            } else {
                tools.push(
                    process_tools
                        .iter()
                        .find(|tool| tool.id == *id)
                        .cloned()
                        .ok_or_else(|| anyhow::anyhow!("Tool is not in the catalog: {id}"))?,
                );
            }
        }
        Ok(tools)
    }
}
