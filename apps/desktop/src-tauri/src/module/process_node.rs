//! Catalog and local-project state for Python Process Nodes.
//!
//! The catalog is the source of truth for local Process Node metadata and is
//! stored at `<app-data>/process-nodes/catalog.json`. Each catalog entry owns
//! one uv project at `<app-data>/process-nodes/<id>`.

use crate::{
    feat::{ProjectPythonStreamRunResult, RunProjectPythonRequest, run_project_python_streaming},
    module::python_runtime::{PythonOutputChunk, PythonRuntime},
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
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
    /// UTC timestamp (RFC 3339) when this definition was created.
    #[serde(default)]
    pub created_at: String,
    /// UTC timestamp (RFC 3339) when this definition was last updated.
    #[serde(default)]
    pub updated_at: String,
    /// Project-relative Python script that implements the JSON Lines protocol.
    pub entry: PathBuf,
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

    /// Open an installed Process Node project in the system file manager.
    pub async fn open_project(id: &str) -> Result<()> {
        let node = Self::inspect(id).await?;
        if !matches!(node.install_status, ProcessNodeInstallStatus::Installed) {
            bail!("Process Node project is not available: {id}");
        }
        open::that(&node.project_path)
            .with_context(|| format!("failed to open Process Node project {}", node.project_path.display()))
    }

    /// Create a local uv project and register it in the catalog.
    pub async fn create(
        app: &AppHandle,
        request: CreateProcessNodeRequest,
        progress: Channel<ProcessNodeCreateProgress>,
    ) -> Result<ProcessNode> {
        if request.name.trim().is_empty() {
            bail!("Process Node name must not be empty");
        }

        let now = Utc::now().to_rfc3339();
        let definition = ProcessNodeDefinition {
            id: Uuid::now_v7().to_string(),
            name: request.name.trim().to_string(),
            description: request.description.trim().to_string(),
            version: "0.1.0".to_string(),
            created_at: now.clone(),
            updated_at: now,
            entry: PathBuf::from("main.py"),
            inputs: BTreeMap::new(),
            outputs: BTreeMap::new(),
        };
        let project_path = Self::root_dir()?.join(&definition.id);
        let _ = progress.send(ProcessNodeCreateProgress {
            stage: ProcessNodeCreateStage::CreatingProject,
        });
        tokio::fs::create_dir_all(&project_path)
            .await
            .with_context(|| format!("failed to create Process Node project {}", project_path.display()))?;

        let result = async {
            PythonRuntime::init_application_project(app, &project_path).await?;
            let _ = progress.send(ProcessNodeCreateProgress {
                stage: ProcessNodeCreateStage::AddingSdkDependency,
            });
            PythonRuntime::add_workrun_sdk_dependency(app, &project_path).await?;
            let _ = progress.send(ProcessNodeCreateProgress {
                stage: ProcessNodeCreateStage::InitializingEnvironment,
            });
            PythonRuntime::sync_dependencies(app, &project_path, "3.12").await?;
            let _ = progress.send(ProcessNodeCreateProgress {
                stage: ProcessNodeCreateStage::SavingApp,
            });
            tokio::fs::write(
                project_path.join(&definition.entry),
                "\"\"\"Process Node entrypoint.\n\nImplement this script to perform the node's work. Its stdout is shown in Workrun.\n\"\"\"\n\n\ndef main() -> None:\n    print(\"Process Node is ready. Edit main.py to implement it.\")\n\n\nif __name__ == \"__main__\":\n    main()\n",
            )
            .await?;
            let mut catalog = Self::read_catalog().await?;
            catalog.nodes.push(definition.clone());
            Self::write_catalog(&catalog).await
        }
        .await;

        if let Err(error) = result {
            let _ = tokio::fs::remove_dir_all(&project_path).await;
            return Err(error).with_context(|| "failed to initialize Process Node project");
        }
        let node = Self::with_installation(definition).await;
        let _ = progress.send(ProcessNodeCreateProgress {
            stage: ProcessNodeCreateStage::Completed,
        });
        Ok(node)
    }

    /// Persist editable catalog metadata for an existing local Process Node.
    pub async fn update(mut definition: ProcessNodeDefinition) -> Result<ProcessNode> {
        let mut catalog = Self::read_catalog().await?;
        let node = catalog
            .nodes
            .iter_mut()
            .find(|node| node.id == definition.id)
            .ok_or_else(|| anyhow::anyhow!("Process Node is not in the catalog: {}", definition.id))?;
        definition.created_at = node.created_at.clone();
        definition.updated_at = Utc::now().to_rfc3339();
        validate_definition(&definition)?;
        *node = definition.clone();
        Self::write_catalog(&catalog).await?;
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

    async fn write_catalog(catalog: &ProcessNodeCatalog) -> Result<()> {
        validate_catalog(catalog)?;
        let catalog_path = Self::catalog_path()?;
        let parent = catalog_path
            .parent()
            .context("Process Node catalog has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let contents = serde_json::to_vec_pretty(catalog).context("failed to serialize Process Node catalog")?;
        tokio::fs::write(&catalog_path, contents)
            .await
            .with_context(|| format!("failed to write Process Node catalog {}", catalog_path.display()))
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
            created_at: "2026-01-01T00:00:00+00:00".into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
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
