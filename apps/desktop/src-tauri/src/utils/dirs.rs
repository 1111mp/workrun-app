use crate::{core::handle, logging, utils::logging::Type};
use anyhow::Result;
use async_trait::async_trait;
use once_cell::sync::OnceCell;
use std::{
    fs,
    path::{Component, Path, PathBuf},
};
use tauri::Manager as _;

pub static APP_ID: &str = "io.github.1111mp.workrun";

pub static PORTABLE_FLAG: OnceCell<bool> = OnceCell::new();

pub static WORKRUN_CONFIG: &str = "workrun.yaml";

/// The isolated storage area used by one Workrun workspace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceScope {
    Personal,
    Team { team_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspacePaths {
    root: PathBuf,
}

impl WorkspacePaths {
    fn new(app_data_dir: &Path, scope: &WorkspaceScope) -> Result<Self> {
        let root = match scope {
            WorkspaceScope::Personal => app_data_dir.join("personal"),
            WorkspaceScope::Team { team_id } => {
                if !is_path_component(team_id) {
                    return Err(anyhow::anyhow!("team id must be one path component"));
                }
                app_data_dir.join("team").join(team_id)
            },
        };
        Ok(Self { root })
    }

    pub fn root(&self) -> PathBuf {
        self.root.clone()
    }

    pub fn workrun_path(&self) -> PathBuf {
        self.root.join(WORKRUN_CONFIG)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn db_dir(&self) -> PathBuf {
        self.root.join("db")
    }

    pub fn runtime_dir(&self) -> PathBuf {
        self.root.join("runtime")
    }

    pub fn process_nodes_dir(&self) -> PathBuf {
        self.root.join("process-nodes")
    }

    pub fn process_node_catalog_path(&self) -> PathBuf {
        self.process_nodes_dir().join("catalog.json")
    }

    pub fn mcp_server_catalog_path(&self) -> PathBuf {
        self.root.join("mcp-servers").join("catalog.json")
    }

    pub fn workflow_catalog_path(&self) -> PathBuf {
        self.root.join("workflow.json")
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.root.join(".skills")
    }
}

/// init portable flag
pub fn init_portable_flag() -> Result<()> {
    use tauri::utils::platform::current_exe;

    let app_exe = current_exe()?;
    if let Some(dir) = app_exe.parent() {
        let dir = PathBuf::from(dir).join(".config/PORTABLE");

        if dir.exists() {
            PORTABLE_FLAG.get_or_init(|| true);
        }
    }
    PORTABLE_FLAG.get_or_init(|| false);
    Ok(())
}

/// Root directory containing all isolated Workrun workspaces.
pub fn app_data_dir() -> Result<PathBuf> {
    use tauri::utils::platform::current_exe;

    let flag = PORTABLE_FLAG.get().unwrap_or(&false);
    if *flag {
        let app_exe = current_exe()?;
        let app_exe = dunce::canonicalize(app_exe)?;
        let app_dir = app_exe
            .parent()
            .ok_or_else(|| anyhow::anyhow!("failed to get the portable app dir"))?;
        return Ok(PathBuf::from(app_dir).join(".config").join(APP_ID));
    }

    let app_handle = handle::Handle::app_handle();

    match app_handle.path().data_dir() {
        Ok(dir) => Ok(dir.join(APP_ID)),
        Err(e) => {
            logging!(error, Type::File, "Failed to get the app home directory: {e}");
            Err(anyhow::anyhow!("Failed to get the app homedirectory"))
        },
    }
}

/// Returns paths for an explicit workspace scope.
pub fn workspace_paths(scope: WorkspaceScope) -> Result<WorkspacePaths> {
    WorkspacePaths::new(&app_data_dir()?, &scope)
}

/// The active workspace remains Personal until team activation has a dedicated
/// lifecycle and a persisted team identifier. Keeping this choice here makes
/// every existing subsystem use the same isolated root in the meantime.
pub fn active_workspace_paths() -> Result<WorkspacePaths> {
    workspace_paths(WorkspaceScope::Personal)
}

/// get the active workrun app home dir
pub fn app_home_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.root())
}

/// `workrun.yaml` file path
pub fn workrun_path() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.workrun_path())
}

/// logs dir
pub fn app_logs_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.logs_dir())
}

/// sqlite db dir
pub fn app_db_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.db_dir())
}

/// runtime dir
pub fn runtime_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.runtime_dir())
}

/// Root directory for locally managed Process Node projects.
///
/// A Process Node is an independently managed uv project created from Apps.
pub fn process_nodes_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.process_nodes_dir())
}

/// Local catalog of Process Node definitions managed from Apps.
pub fn process_node_catalog_path() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.process_node_catalog_path())
}

/// Local catalog of configured stdio MCP Servers.
pub fn mcp_server_catalog_path() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.mcp_server_catalog_path())
}

/// Local workflow catalog managed from the Workflows page.
pub fn workflow_catalog_path() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.workflow_catalog_path())
}

/// Root directory for Agent Skills managed by the active workspace.
pub fn skills_dir() -> Result<PathBuf> {
    Ok(active_workspace_paths()?.skills_dir())
}

/// runtime uv install python dir
pub fn uv_python_dir() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("python"))
}

/// runtime uv cache dir
pub fn uv_cache_dir() -> Result<PathBuf> {
    Ok(runtime_dir()?.join("uv-cache"))
}

pub fn get_encryption_key() -> Result<Vec<u8>> {
    let app_dir = app_home_dir()?;
    let key_path = app_dir.join(".encryption_key");

    if key_path.exists() {
        // Read existing key
        fs::read(&key_path).map_err(|e| anyhow::anyhow!("Failed to read encryption key: {}", e))
    } else {
        // Generate and save new key
        let mut key = vec![0u8; 32];
        getrandom::fill(&mut key)?;

        // Ensure directory exists
        if let Some(parent) = key_path.parent() {
            fs::create_dir_all(parent).map_err(|e| anyhow::anyhow!("Failed to create key directory: {}", e))?;
        }
        // Save key
        fs::write(&key_path, &key).map_err(|e| anyhow::anyhow!("Failed to save encryption key: {}", e))?;
        Ok(key)
    }
}

fn is_path_component(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_paths_are_isolated_by_scope() {
        let app_data_dir = Path::new("/workrun");
        let personal = WorkspacePaths::new(app_data_dir, &WorkspaceScope::Personal).unwrap();
        let team = WorkspacePaths::new(
            app_data_dir,
            &WorkspaceScope::Team {
                team_id: "acme".to_string(),
            },
        )
        .unwrap();

        assert_eq!(personal.workrun_path(), PathBuf::from("/workrun/personal/workrun.yaml"));
        assert_eq!(personal.skills_dir(), PathBuf::from("/workrun/personal/.skills"));
        assert_eq!(team.runtime_dir(), PathBuf::from("/workrun/team/acme/runtime"));
        assert_ne!(personal.root(), team.root());
    }

    #[test]
    fn team_id_cannot_escape_its_workspace_root() {
        assert!(
            WorkspacePaths::new(
                Path::new("/workrun"),
                &WorkspaceScope::Team {
                    team_id: "../other".to_string(),
                },
            )
            .is_err()
        );
    }
}

#[allow(unused)]
#[async_trait]
pub trait PathBufExec {
    async fn remove_if_exists(&self) -> Result<()>;
}

#[async_trait]
impl PathBufExec for PathBuf {
    async fn remove_if_exists(&self) -> Result<()> {
        if self.exists() {
            tokio::fs::remove_file(self).await?;
            logging!(info, Type::File, "Removed file: {:?}", self);
        }
        Ok(())
    }
}
