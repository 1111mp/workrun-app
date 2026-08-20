use crate::{core::handle, logging, utils::logging::Type};
use anyhow::Result;
use async_trait::async_trait;
use once_cell::sync::OnceCell;
use std::{fs, path::PathBuf};
use tauri::Manager as _;

pub static APP_ID: &str = "io.github.1111mp.workrun";

pub static PORTABLE_FLAG: OnceCell<bool> = OnceCell::new();

pub static WORKRUN_CONFIG: &str = "workrun.yaml";

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

/// get the workrun app home dir
pub fn app_home_dir() -> Result<PathBuf> {
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

/// `workrun.yaml` file path
pub fn workrun_path() -> Result<PathBuf> {
    Ok(app_home_dir()?.join(WORKRUN_CONFIG))
}

/// logs dir
pub fn app_logs_dir() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("logs"))
}

/// sqlite db dir
pub fn app_db_dir() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("db"))
}

/// runtime dir
pub fn runtime_dir() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("runtime"))
}

/// Root directory for locally managed Process Node projects.
///
/// A Process Node is an independently managed uv project created from Apps.
pub fn process_nodes_dir() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("process-nodes"))
}

/// Local catalog of Process Node definitions managed from Apps.
pub fn process_node_catalog_path() -> Result<PathBuf> {
    Ok(process_nodes_dir()?.join("catalog.json"))
}

/// Local catalog of configured stdio MCP Servers.
pub fn mcp_server_catalog_path() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("mcp-servers").join("catalog.json"))
}

/// Local workflow catalog managed from the Workflows page.
pub fn workflow_catalog_path() -> Result<PathBuf> {
    Ok(app_home_dir()?.join("workflow.json"))
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
