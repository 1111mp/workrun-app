use super::types::*;
use super::{installation_status, process_tool_definition, validate_catalog, validate_definition, validate_node_id};
use crate::{
    module::{tool_registry::ToolDefinition, workflow_catalog::WorkflowCatalogStore},
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use std::path::PathBuf;

impl ProcessNodeRegistry {
    pub fn root_dir() -> Result<PathBuf> {
        dirs::process_nodes_dir()
    }

    pub fn project_path(definition: &ProcessNodeDefinition) -> Result<PathBuf> {
        match &definition.project_root {
            Some(root) => Ok(root.join(&definition.id)),
            None => Ok(Self::root_dir()?.join(&definition.id)),
        }
    }

    pub fn catalog_path() -> Result<PathBuf> {
        dirs::process_node_catalog_path()
    }

    /// List every node from the catalog, including ones that are not installed.
    pub async fn list() -> Result<Vec<ProcessNode>> {
        let mut catalog = Self::read_catalog().await?;
        catalog.nodes.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        });
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

    /// Remove a Process Node from the catalog and, when requested, its project directory.
    pub async fn delete(id: &str, delete_project_files: bool) -> Result<()> {
        validate_node_id(id)?;
        let mut catalog = Self::read_catalog().await?;
        let position = catalog
            .nodes
            .iter()
            .position(|node| node.id == id)
            .ok_or_else(|| anyhow::anyhow!("Process Node is not in the catalog: {id}"))?;
        let definition = catalog.nodes[position].clone();

        if delete_project_files {
            let project_path = Self::project_path(&definition)?;
            match tokio::fs::metadata(&project_path).await {
                Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(&project_path)
                    .await
                    .with_context(|| format!("failed to delete Process Node project {}", project_path.display()))?,
                Ok(_) => bail!("Process Node path is not a directory: {}", project_path.display()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => {
                    return Err(error)
                        .with_context(|| format!("failed to inspect Process Node project {}", project_path.display()));
                },
            }
        }

        catalog.nodes.remove(position);
        Self::write_catalog(&catalog).await
    }

    /// List saved workflows with a Process Node selected on a canvas node.
    pub async fn workflow_references(id: &str) -> Result<Vec<ProcessNodeWorkflowReference>> {
        validate_node_id(id)?;
        Ok(WorkflowCatalogStore::list()
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
        let project_path = match Self::project_path(&definition) {
            Ok(project_path) => project_path,
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

fn workflow_uses_process_node(document: &serde_json::Value, id: &str) -> bool {
    let mut nodes = document
        .get("nodes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten();

    nodes.any(|node| {
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

#[cfg(test)]
mod tests {
    use super::workflow_uses_process_node;
    use serde_json::json;

    const APP_ID: &str = "019b812d-4958-7d37-8a45-47e1e20a4744";

    #[test]
    fn finds_workflow_and_agent_tool_references() {
        let document = json!({
            "nodes": [
                { "data": { "processNodeId": APP_ID } },
                { "data": { "toolIds": ["other-tool", APP_ID] } },
            ],
        });

        assert!(workflow_uses_process_node(&document, APP_ID));
        assert!(!workflow_uses_process_node(&document, "missing-app"));
    }
}
