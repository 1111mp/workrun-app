//! Runtime and IPC types for Python Process Nodes.

use crate::{config::IProcessNode, module::python_runtime::StreamingPythonExecutionResult};
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

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
    pub definition: IProcessNode,
    pub project_path: PathBuf,
    pub install_status: ProcessNodeInstallStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_error: Option<String>,
}

/// Result produced when a Process Node is executed inside a workflow. Logs are
/// intentionally separate from the structured result sent over local IPC.
pub struct WorkflowProcessNodeRun {
    pub definition: IProcessNode,
    pub execution: StreamingPythonExecutionResult,
    pub stdout: String,
    pub stderr: String,
    pub result: Value,
}

/// Stateless access to the source-owned catalog and the local installation cache.
pub struct ProcessNodeRegistry;
