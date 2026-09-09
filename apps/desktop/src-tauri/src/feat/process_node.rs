use crate::{
    config::{
        Config, IProcessNode, ProcessNodeKind, ProcessNodePublicationStatus, ToolExecutionPolicy,
        validate_process_node_catalog, validate_process_node_definition, validate_process_node_id,
    },
    feat::ProjectPythonStreamRunResult,
    module::{
        process_node::{ProcessNode, ProcessNodeInstallStatus, ProcessNodeRegistry},
        python_runtime::PythonOutputChunk,
        tool_registry::{ToolDefinition, ToolRiskLevel},
    },
    process::AsyncHandler,
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use flate2::{Compression, write::GzEncoder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
};
use tauri::{AppHandle, ipc::Channel};
use uuid::Uuid;
use walkdir::WalkDir;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessNodeSourceArchive {
    pub path: String,
    pub sha256: String,
    pub size: usize,
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
    if !matches!(
        node.install_status,
        ProcessNodeInstallStatus::Installed | ProcessNodeInstallStatus::Draft
    ) {
        bail!("Process Node project is not available: {id}");
    }
    ProcessNodeRegistry::open_project(&node.project_path)
}

/// Return the default root directory under which new Process Node projects are created.
pub fn process_node_default_root() -> Result<String> {
    Ok(ProcessNodeRegistry::root_dir()?.to_string_lossy().into_owned())
}

/// Read the Python package version declared by this App's local project.
pub async fn process_node_project_version(id: &str) -> Result<Option<String>> {
    let definition = get_process_node(id).await?;
    let pyproject_path = ProcessNodeRegistry::project_path(&definition)?.join("pyproject.toml");
    let contents = tokio::fs::read_to_string(&pyproject_path)
        .await
        .with_context(|| format!("failed to read {}", pyproject_path.display()))?;
    let pyproject: toml::Value =
        toml::from_str(&contents).with_context(|| format!("failed to parse {}", pyproject_path.display()))?;

    Ok(pyproject
        .get("project")
        .and_then(toml::Value::as_table)
        .and_then(|project| project.get("version"))
        .and_then(toml::Value::as_str)
        .map(str::to_owned))
}

/// Update the manifest before publishing so the uploaded source and catalog
/// always describe the same version.
pub async fn process_node_set_project_version(id: &str, version: &str) -> Result<()> {
    let definition = get_process_node(id).await?;
    let pyproject_path = ProcessNodeRegistry::project_path(&definition)?.join("pyproject.toml");
    let contents = tokio::fs::read_to_string(&pyproject_path)
        .await
        .with_context(|| format!("failed to read {}", pyproject_path.display()))?;
    let mut document = contents
        .parse::<toml_edit::DocumentMut>()
        .with_context(|| format!("failed to parse {}", pyproject_path.display()))?;
    let project = document
        .get_mut("project")
        .and_then(toml_edit::Item::as_table_like_mut)
        .context("pyproject.toml is missing a [project] table")?;
    project.insert("version", toml_edit::value(version));
    tokio::fs::write(&pyproject_path, document.to_string())
        .await
        .with_context(|| format!("failed to write {}", pyproject_path.display()))
}

/// Build the immutable source archive used for one published App version.
pub async fn process_node_source_archive(id: &str) -> Result<ProcessNodeSourceArchive> {
    let definition = get_process_node(id).await?;
    let project_path = ProcessNodeRegistry::project_path(&definition)?;
    AsyncHandler::spawn_blocking(move || create_source_archive(&project_path))
        .await
        .context("source archive task failed")?
}

fn create_source_archive(project_path: &Path) -> Result<ProcessNodeSourceArchive> {
    let gitignore = load_gitignore(project_path)?;
    let archive_path = std::env::temp_dir().join(format!("workrun-source-{}.tar.gz", Uuid::now_v7()));
    let output = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&archive_path)
        .with_context(|| format!("failed to create {}", archive_path.display()))?;
    let encoder = GzEncoder::new(output, Compression::default());
    let mut archive = tar::Builder::new(encoder);

    for entry in WalkDir::new(project_path).follow_links(false) {
        let entry = entry?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry.path().strip_prefix(project_path)?;
        if gitignore
            .as_ref()
            .is_some_and(|ignore| ignore.matched_path_or_any_parents(relative, false).is_ignore())
            || gitignore.is_none() && is_ignored_source_path(relative)
        {
            continue;
        }
        archive.append_file(relative, &mut File::open(entry.path())?)?;
    }

    let mut output = archive.into_inner()?.finish()?;
    use std::io::{Seek, SeekFrom};
    output.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut output, &mut hasher)?;
    let size = output.metadata()?.len() as usize;
    Ok(ProcessNodeSourceArchive {
        path: archive_path.to_string_lossy().into_owned(),
        size,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn load_gitignore(project_path: &Path) -> Result<Option<ignore::gitignore::Gitignore>> {
    let gitignore_path = project_path.join(".gitignore");
    if !gitignore_path.is_file() {
        return Ok(None);
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(project_path);
    if let Some(error) = builder.add(&gitignore_path) {
        return Err(error).with_context(|| format!("failed to parse {}", gitignore_path.display()));
    }
    builder
        .build()
        .map(Some)
        .with_context(|| format!("failed to parse {}", gitignore_path.display()))
}

fn is_ignored_source_path(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | ".venv" | "__pycache__" | "logs")
        )
    }) || path.file_name().is_some_and(|name| name == ".DS_Store")
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
        publication_status: if dirs::is_team_workspace() {
            ProcessNodePublicationStatus::Draft
        } else {
            ProcessNodePublicationStatus::Published
        },
        remote_app_id: None,
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
