use super::{ProcessNode, ProcessNodeInstallStatus, ProcessNodeRegistry, installation_status, process_tool_definition};
use crate::{config::IProcessNode, module::tool_registry::ToolDefinition, utils::dirs};
use anyhow::{Context, Result, bail};
use std::path::{Path, PathBuf};

impl ProcessNodeRegistry {
    pub fn root_dir() -> Result<PathBuf> {
        dirs::process_nodes_dir()
    }

    pub fn project_path(definition: &IProcessNode) -> Result<PathBuf> {
        match &definition.project_root {
            Some(root) => Ok(root.join(&definition.id)),
            None => Ok(Self::root_dir()?.join(&definition.id)),
        }
    }

    /// Turn persisted metadata into a runtime description without changing it.
    pub async fn with_installation(definition: IProcessNode) -> ProcessNode {
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

    pub fn tool_definition(definition: IProcessNode) -> Result<ToolDefinition> {
        process_tool_definition(definition)
    }

    pub fn open_project(project_path: &Path) -> Result<()> {
        open::that(project_path)
            .with_context(|| format!("failed to open Process Node project {}", project_path.display()))
    }

    /// Removes a local project only after its catalog entry has been committed away.
    /// If this fails, the caller can recover the orphaned directory from the returned path.
    pub async fn delete_project(definition: &IProcessNode) -> Result<()> {
        let project_path = Self::project_path(definition)?;
        match tokio::fs::metadata(&project_path).await {
            Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(&project_path)
                .await
                .with_context(|| format!("failed to delete Process Node project {}", project_path.display())),
            Ok(_) => bail!("Process Node path is not a directory: {}", project_path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => {
                Err(error).with_context(|| format!("failed to inspect Process Node project {}", project_path.display()))
            },
        }
    }
}
