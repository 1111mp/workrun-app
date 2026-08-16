use super::types::*;
use super::{installation_status, process_tool_definition, validate_catalog, validate_definition, validate_node_id};
use crate::{module::tool_registry::ToolDefinition, utils::dirs};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use std::path::PathBuf;

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

    /// List the App definitions that can be attached to an Agent as tools.
    pub async fn list_tool_definitions() -> Result<Vec<ToolDefinition>> {
        let catalog = Self::read_catalog().await?;
        catalog
            .nodes
            .into_iter()
            .filter(|node| node.kind == ProcessNodeKind::Tool)
            .map(process_tool_definition)
            .collect()
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
    pub(super) async fn read_catalog() -> Result<ProcessNodeCatalog> {
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

    pub(super) async fn write_catalog(catalog: &ProcessNodeCatalog) -> Result<()> {
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

    pub(super) async fn with_installation(definition: ProcessNodeDefinition) -> ProcessNode {
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
