//! Catalog and local-installation state for Python Process Nodes.
//!
//! The catalog is the source of truth for nodes that can be installed. It is
//! manually maintained at `<app-data>/process-nodes/catalog.json` for now and
//! will later be cached from the Process Node source service. A project at
//! `<app-data>/process-nodes/<id>` only represents the local installation of a
//! catalog node; project directories are never used to discover the catalog.

use crate::{
    feat::{ProjectPythonStreamRunResult, RunProjectPythonRequest, run_project_python_streaming},
    module::python_runtime::PythonOutputChunk,
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, ipc::Channel};
use uuid::Uuid;

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
    /// Project-relative Python script that implements the JSON Lines protocol.
    pub entry: PathBuf,
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
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

/// Stateless access to the source-owned catalog and the local installation cache.
pub struct ProcessNodeRegistry;

impl ProcessNodeRegistry {
    pub fn root_dir() -> Result<PathBuf> {
        dirs::process_nodes_dir()
    }

    pub fn catalog_path() -> Result<PathBuf> {
        dirs::process_node_catalog_path()
    }

    /// List every node from the catalog, including ones that are not installed.
    pub async fn list() -> Result<Vec<ProcessNode>> {
        let catalog = Self::read_catalog().await?;
        let mut nodes = Vec::with_capacity(catalog.nodes.len());
        for definition in catalog.nodes {
            nodes.push(Self::with_installation(definition).await);
        }
        Ok(nodes)
    }

    /// Read one catalog node by id, with its current local installation state.
    pub async fn inspect(id: &str) -> Result<ProcessNode> {
        validate_node_id(id)?;
        let catalog = Self::read_catalog().await?;
        let definition = catalog
            .nodes
            .into_iter()
            .find(|node| node.id == id)
            .ok_or_else(|| anyhow::anyhow!("Process Node is not in the catalog: {id}"))?;
        Ok(Self::with_installation(definition).await)
    }

    /// Synchronize and execute an installed Process Node through Workrun's
    /// managed Python runtime. The project path and entrypoint always come
    /// from the trusted catalog, never from the IPC caller.
    pub async fn run(
        app: &AppHandle,
        id: &str,
        output: Channel<PythonOutputChunk>,
    ) -> Result<ProjectPythonStreamRunResult> {
        let node = Self::inspect(id).await?;
        if !matches!(node.install_status, ProcessNodeInstallStatus::Installed) {
            bail!("Process Node is not installed: {id}");
        }

        let python_version = project_python_version(&node.project_path).await?;
        run_project_python_streaming(
            app,
            RunProjectPythonRequest {
                project_path: node.project_path,
                script_path: node.definition.entry,
                python_version,
                args: Vec::new(),
            },
            output,
        )
        .await
    }

    async fn read_catalog() -> Result<ProcessNodeCatalog> {
        let catalog_path = Self::catalog_path()?;
        let bytes = match tokio::fs::read(&catalog_path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(ProcessNodeCatalog::default()),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to read Process Node catalog {}", catalog_path.display()));
            },
        };
        let catalog = serde_json::from_slice::<ProcessNodeCatalog>(&bytes)
            .with_context(|| format!("invalid Process Node catalog {}", catalog_path.display()))?;
        validate_catalog(&catalog)?;
        Ok(catalog)
    }

    async fn with_installation(definition: ProcessNodeDefinition) -> ProcessNode {
        let project_path = match Self::root_dir() {
            Ok(root) => root.join(&definition.id),
            Err(error) => {
                return ProcessNode {
                    definition,
                    project_path: PathBuf::new(),
                    install_status: ProcessNodeInstallStatus::Invalid,
                    install_error: Some(error.to_string()),
                };
            },
        };

        let (install_status, install_error) = installation_status(&project_path).await;
        ProcessNode {
            definition,
            project_path,
            install_status,
            install_error,
        }
    }
}

/// uv writes this file for initialized projects. Prefer it over a host-wide
/// default so a node's declared runtime (for example Python 3.14) is honored.
async fn project_python_version(project_path: &Path) -> Result<String> {
    let version_path = project_path.join(".python-version");
    match tokio::fs::read_to_string(&version_path).await {
        Ok(contents) => {
            let version = contents.trim();
            if version.is_empty() || version.lines().count() != 1 {
                bail!("invalid .python-version file: {}", version_path.display());
            }
            Ok(version.to_string())
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok("3.12".to_string()),
        Err(error) => Err(error).with_context(|| format!("failed to read {}", version_path.display())),
    }
}

fn validate_catalog(catalog: &ProcessNodeCatalog) -> Result<()> {
    let mut ids = HashSet::with_capacity(catalog.nodes.len());
    for definition in &catalog.nodes {
        validate_definition(definition)?;
        if !ids.insert(&definition.id) {
            bail!("Process Node catalog contains duplicate id {:?}", definition.id);
        }
    }
    Ok(())
}

fn validate_definition(definition: &ProcessNodeDefinition) -> Result<()> {
    validate_node_id(&definition.id)?;
    if definition.name.trim().is_empty() {
        bail!("Process Node name must not be empty");
    }
    Version::parse(&definition.version).with_context(|| {
        format!(
            "Process Node version must be valid semver, got {:?}",
            definition.version
        )
    })?;
    if definition.entry.as_os_str().is_empty()
        || definition.entry.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::CurDir | Component::ParentDir
            )
        })
    {
        bail!("Process Node entry must be a non-empty relative file path");
    }
    validate_schemas("inputs", &definition.inputs)?;
    validate_schemas("outputs", &definition.outputs)?;
    Ok(())
}

async fn installation_status(project_path: &Path) -> (ProcessNodeInstallStatus, Option<String>) {
    match tokio::fs::metadata(project_path).await {
        Ok(metadata) if metadata.is_dir() => (ProcessNodeInstallStatus::Installed, None),
        Ok(_) => (
            ProcessNodeInstallStatus::Invalid,
            Some(format!(
                "Process Node path is not a directory: {}",
                project_path.display()
            )),
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (ProcessNodeInstallStatus::NotInstalled, None),
        Err(error) => (
            ProcessNodeInstallStatus::Invalid,
            Some(format!(
                "failed to inspect Process Node path {}: {error}",
                project_path.display()
            )),
        ),
    }
}

fn validate_node_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).with_context(|| format!("Process Node id must be a UUID, got {id:?}"))?;
    if uuid.hyphenated().to_string() != id {
        bail!("Process Node id must be a lowercase, hyphenated UUID");
    }
    Ok(())
}

fn validate_schemas(kind: &str, schemas: &BTreeMap<String, Value>) -> Result<()> {
    for (name, schema) in schemas {
        if name.trim().is_empty() || !schema.is_object() {
            bail!("Process Node {kind} must map non-empty names to JSON object schemas");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn definition() -> ProcessNodeDefinition {
        ProcessNodeDefinition {
            id: "019b812d-4958-7d37-8a45-47e1e20a4744".into(),
            name: "Web Search".into(),
            description: "Search the web".into(),
            version: "0.1.0".into(),
            entry: "main.py".into(),
            inputs: BTreeMap::from([("query".into(), serde_json::json!({ "type": "string" }))]),
            outputs: BTreeMap::new(),
        }
    }

    #[test]
    fn catalog_rejects_noncanonical_and_duplicate_ids() {
        let mut invalid = definition();
        invalid.id = "019B812D-4958-7D37-8A45-47E1E20A4744".into();
        assert!(validate_catalog(&ProcessNodeCatalog { nodes: vec![invalid] }).is_err());

        let duplicate = definition();
        assert!(
            validate_catalog(&ProcessNodeCatalog {
                nodes: vec![definition(), duplicate],
            })
            .is_err()
        );
    }

    #[tokio::test]
    async fn installation_status_only_checks_for_a_project_directory() {
        let project = std::env::temp_dir().join(format!("workrun-process-node-{}", uuid::Uuid::new_v4()));
        let (status, error) = installation_status(&project).await;
        assert!(matches!(status, ProcessNodeInstallStatus::NotInstalled));
        assert!(error.is_none());

        tokio::fs::create_dir_all(&project).await.unwrap();
        let (status, error) = installation_status(&project).await;
        assert!(matches!(status, ProcessNodeInstallStatus::Installed));
        assert!(error.is_none());

        tokio::fs::remove_dir_all(project).await.unwrap();
    }
}
