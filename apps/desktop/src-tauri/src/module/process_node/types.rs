//! Catalog and local-project state for Python Process Nodes.
//!
//! The catalog is the source of truth for local Process Node metadata and is
//! stored at `<app-data>/process-nodes/catalog.json`. Each catalog entry owns
//! one uv project at `<app-data>/process-nodes/<id>`.

use crate::module::{python_runtime::StreamingPythonExecutionResult, tool_registry::ToolRiskLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, path::PathBuf};

/// How an App is invoked by Workrun.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessNodeKind {
    /// A deterministic workflow step placed directly on the canvas.
    #[default]
    Workflow,
    /// A callable function made available to selected Agent nodes.
    Tool,
}

/// Whether each Agent invocation needs an explicit user confirmation.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolExecutionPolicy {
    #[default]
    AskEveryTime,
    Auto,
}

/// The full set of Process Nodes available from the current source.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeCatalog {
    #[serde(default)]
    pub nodes: Vec<ProcessNodeDefinition>,
}

/// Source-owned metadata for one uv-managed Python Process Node.
///
/// Python versions and dependencies remain in the installed project's
/// `pyproject.toml` and `uv.lock`, so they are not duplicated here.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeDefinition {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
    /// UTC timestamp (RFC 3339) when this definition was created.
    #[serde(default)]
    pub created_at: String,
    /// UTC timestamp (RFC 3339) when this definition was last updated.
    #[serde(default)]
    pub updated_at: String,
    /// Project-relative Python script that implements the Process Node work.
    pub entry: PathBuf,
    /// Absolute directory under which this App's id-named project is stored.
    /// Older catalog entries use the workspace default directory instead.
    #[serde(default)]
    pub project_root: Option<PathBuf>,
    #[serde(default)]
    pub kind: ProcessNodeKind,
    #[serde(default)]
    pub tool_execution_policy: ToolExecutionPolicy,
    #[serde(default)]
    pub tool_risk_level: ToolRiskLevel,
    #[serde(default)]
    pub tool_permissions: Vec<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
}

/// Metadata collected when a local Process Node project is first created.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProcessNodeRequest {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub kind: ProcessNodeKind,
    /// Optional absolute directory under which to create this App project.
    #[serde(default)]
    pub project_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessNodeCreateStage {
    CreatingProject,
    AddingSdkDependency,
    InitializingEnvironment,
    SavingApp,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeCreateProgress {
    pub stage: ProcessNodeCreateStage,
}

/// Whether a catalog node has a local project directory.
///
/// Listing deliberately does not validate project files. Dependency, entrypoint
/// and lockfile validation belongs to the later install/execute workflow.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessNodeInstallStatus {
    NotInstalled,
    Installed,
    Invalid,
}

/// A catalog node together with its local installation state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNode {
    pub definition: ProcessNodeDefinition,
    pub project_path: PathBuf,
    pub install_status: ProcessNodeInstallStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeWorkflowReference {
    pub id: String,
    pub name: String,
}

/// Result produced when a Process Node is executed inside a workflow. Logs are
/// intentionally separate from the structured result sent over local IPC.
pub struct WorkflowProcessNodeRun {
    pub definition: ProcessNodeDefinition,
    pub execution: StreamingPythonExecutionResult,
    pub stdout: String,
    pub stderr: String,
    pub result: Value,
}

/// Stateless access to the source-owned catalog and the local installation cache.
pub struct ProcessNodeRegistry;
