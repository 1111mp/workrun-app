use crate::{
    config::{
        Config, IProcessNode, ProcessNodeKind, ToolExecutionPolicy, validate_process_node_catalog,
        validate_process_node_definition, validate_process_node_id,
    },
    feat::ProjectPythonStreamRunResult,
    module::{
        process_node::{ProcessNode, ProcessNodeInstallStatus, ProcessNodeRegistry},
        python_runtime::PythonOutputChunk,
        tool_registry::{ToolDefinition, ToolRiskLevel},
    },
};
use anyhow::{Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};
use tauri::{AppHandle, ipc::Channel};
use uuid::Uuid;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeWorkflowReference {
    pub id: String,
    pub name: String,
}

pub async fn get_process_nodes() -> Result<Vec<ProcessNode>> {
    let mut definitions = Config::process_nodes().await.data_arc().get_process_nodes();
    definitions.sort_by(|left, right| {
        right
            .created_at
            .cmp(&left.created_at)
            .then_with(|| right.updated_at.cmp(&left.updated_at))
    });

    let mut nodes = Vec::with_capacity(definitions.len());
    for definition in definitions {
        nodes.push(ProcessNodeRegistry::with_installation(definition).await);
    }
    Ok(nodes)
}

pub async fn process_node_tool_list() -> Result<Vec<ToolDefinition>> {
    Config::process_nodes()
        .await
        .data_arc()
        .get_process_nodes()
        .into_iter()
        .filter(|node| node.kind == ProcessNodeKind::Tool)
        .map(ProcessNodeRegistry::tool_definition)
        .collect()
}

pub async fn process_node_inspect(id: &str) -> Result<ProcessNode> {
    Ok(ProcessNodeRegistry::with_installation(get_process_node(id).await?).await)
}

pub async fn process_node_open_project(id: &str) -> Result<()> {
    let node = process_node_inspect(id).await?;
    if !matches!(node.install_status, ProcessNodeInstallStatus::Installed) {
        bail!("Process Node project is not available: {id}");
    }
    ProcessNodeRegistry::open_project(&node.project_path)
}

/// Return the default root directory under which new Process Node projects are created.
pub fn process_node_default_root() -> Result<String> {
    Ok(ProcessNodeRegistry::root_dir()?.to_string_lossy().into_owned())
}

/// Create a new Process Node catalog entry and initialize its local project.
pub async fn create_process_node(
    request: CreateProcessNodeRequest,
    progress: Channel<ProcessNodeCreateProgress>,
) -> Result<ProcessNode> {
    let now = Utc::now().to_rfc3339();
    let definition = IProcessNode {
        id: Uuid::now_v7().to_string(),
        name: request.name.trim().to_string(),
        description: request.description.trim().to_string(),
        version: "0.1.0".to_string(),
        created_at: now.clone(),
        updated_at: now,
        entry: PathBuf::from("main.py"),
        project_root: request.project_root,
        kind: request.kind,
        tool_execution_policy: ToolExecutionPolicy::AskEveryTime,
        tool_risk_level: ToolRiskLevel::Low,
        tool_permissions: Vec::new(),
        inputs: BTreeMap::new(),
        outputs: BTreeMap::new(),
    };
    validate_process_node_definition(&definition)?;
    ProcessNodeRegistry::initialize_project(&definition, progress.clone()).await?;

    let cleanup_definition = definition.clone();
    let nodes = Config::process_nodes().await;
    let saved = nodes
        .with_data_modify(|mut data| async move {
            data.add_process_node(definition.clone());
            validate_process_node_catalog(&data)?;
            data.save_file().await?;
            Ok((data, definition))
        })
        .await;

    let definition = match saved {
        Ok(definition) => definition,
        Err(error) => {
            // The catalog was not committed, so leaving its newly-created project would orphan it.
            let _ = ProcessNodeRegistry::delete_project(&cleanup_definition).await;
            return Err(error);
        },
    };
    let node = ProcessNodeRegistry::with_installation(definition).await;
    let _ = progress.send(ProcessNodeCreateProgress {
        stage: ProcessNodeCreateStage::Completed,
    });
    Ok(node)
}

/// Update an existing Process Node catalog entry and its local project.
pub async fn update_process_node(mut definition: IProcessNode) -> Result<ProcessNode> {
    let nodes = Config::process_nodes().await;
    let definition = nodes
        .with_data_modify(|mut data| async move {
            let existing = data
                .get_process_node(&definition.id)
                .ok_or_else(|| anyhow::anyhow!("Process Node is not in the catalog: {}", definition.id))?;
            definition.created_at = existing.created_at;
            definition.updated_at = Utc::now().to_rfc3339();
            validate_process_node_definition(&definition)?;
            debug_assert!(data.replace_process_node(definition.clone()));
            validate_process_node_catalog(&data)?;
            data.save_file().await?;
            Ok((data, definition))
        })
        .await?;
    Ok(ProcessNodeRegistry::with_installation(definition).await)
}

/// Delete a Process Node catalog entry and optionally its local project.
pub async fn delete_process_node(id: &str, delete_project_files: bool) -> Result<()> {
    let definition = get_process_node(id).await?;
    let catalog_id = definition.id.clone();
    let nodes = Config::process_nodes().await;
    nodes
        .with_data_modify(|mut data| async move {
            if !data.remove_process_node(&catalog_id) {
                bail!("Process Node is not in the catalog: {catalog_id}");
            }
            data.save_file().await?;
            Ok((data, ()))
        })
        .await?;

    if delete_project_files {
        ProcessNodeRegistry::delete_project(&definition).await?;
    }
    Ok(())
}

pub async fn process_node_workflow_references(id: &str) -> Result<Vec<ProcessNodeWorkflowReference>> {
    validate_process_node_id(id)?;
    Ok(crate::feat::get_workflows()
        .await?
        .into_iter()
        .filter(|workflow| workflow_uses_process_node(&workflow.document, id))
        .map(|workflow| ProcessNodeWorkflowReference {
            id: workflow.id,
            name: workflow
                .document
                .pointer("/settings/name")
                .and_then(serde_json::Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("Untitled workflow")
                .to_string(),
        })
        .collect())
}

pub async fn process_node_run(
    app: &AppHandle,
    id: &str,
    output: Channel<PythonOutputChunk>,
) -> Result<ProjectPythonStreamRunResult> {
    ProcessNodeRegistry::run(app, get_process_node(id).await?, output).await
}

pub(crate) async fn run_process_node_with_output(
    id: &str,
    on_output: std::sync::Arc<dyn Fn(PythonOutputChunk) + Send + Sync>,
    on_started: Option<std::sync::Arc<dyn Fn(u32) + Send + Sync>>,
) -> Result<ProjectPythonStreamRunResult> {
    ProcessNodeRegistry::run_with_output(get_process_node(id).await?, on_output, on_started).await
}

pub(crate) async fn run_process_node_for_workflow(
    id: &str,
    input: &serde_json::Value,
    on_output: std::sync::Arc<dyn Fn(PythonOutputChunk) + Send + Sync>,
) -> Result<crate::module::process_node::WorkflowProcessNodeRun> {
    ProcessNodeRegistry::run_for_workflow(get_process_node(id).await?, input, on_output).await
}

pub(crate) async fn run_process_node_for_tool(
    id: &str,
    input: &serde_json::Value,
    on_output: std::sync::Arc<dyn Fn(PythonOutputChunk) + Send + Sync>,
) -> Result<crate::module::process_node::WorkflowProcessNodeRun> {
    ProcessNodeRegistry::run_for_tool(get_process_node(id).await?, input, on_output).await
}

pub(crate) async fn get_process_node(id: &str) -> Result<IProcessNode> {
    validate_process_node_id(id)?;
    Config::process_nodes()
        .await
        .data_arc()
        .get_process_node(id)
        .ok_or_else(|| anyhow::anyhow!("Process Node is not in the catalog: {id}"))
}

fn workflow_uses_process_node(document: &serde_json::Value, id: &str) -> bool {
    document
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .any(|node| {
            node.pointer("/data/processNodeId").and_then(serde_json::Value::as_str) == Some(id)
                || node
                    .pointer("/data/toolIds")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .any(|tool_id| tool_id == id)
        })
}
