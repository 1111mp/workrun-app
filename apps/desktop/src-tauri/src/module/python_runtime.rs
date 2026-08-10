//! Workrun-managed Python runtime support.
//!
//! `uv` is bundled with the desktop app as a Tauri sidecar.  Python versions,
//! project environments, and package caches will be managed in a later step.

use anyhow::{Context, Result, bail};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

/// Returns the version of the `uv` binary bundled with Workrun.
pub async fn uv_version(app: &AppHandle) -> Result<String> {
    let output = app
        .shell()
        // This is the file stem from `bundle.externalBin`, not its path.
        .sidecar("uv")
        .context("failed to resolve bundled uv sidecar")?
        .arg("--version")
        .output()
        .await
        .context("failed to execute bundled uv sidecar")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!("bundled uv exited unsuccessfully: {stderr}");
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
