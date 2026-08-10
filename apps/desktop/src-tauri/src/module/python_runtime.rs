//! Workrun-managed Python runtime support.
//!
//! `uv` is bundled with the desktop app as a Tauri sidecar. Python versions and
//! its download cache are kept below Workrun's application data directory, so
//! they are never written into (or read from) the application bundle.

use crate::utils::dirs;
use anyhow::{Context, Result, bail};
use semver::Version;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

const PYTHON_INSTALL_DIR_ENV: &str = "UV_PYTHON_INSTALL_DIR";
const UV_CACHE_DIR_ENV: &str = "UV_CACHE_DIR";

/// Stateless Python runtime operations backed by Workrun's bundled uv sidecar.
pub struct PythonRuntime;

/// A Python interpreter installed and owned by Workrun.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedPython {
    /// The version request passed to uv, for example `3.12`.
    pub requested_version: String,
    /// Absolute path to the interpreter selected by uv.
    pub executable_path: PathBuf,
    /// The version reported by the interpreter itself, for example `Python 3.12.11`.
    pub version: String,
}

/// A project-local virtual environment created from a Workrun-managed Python.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedVenv {
    /// Canonical path of the project containing this environment.
    pub project_path: PathBuf,
    /// Absolute path to the project's `.venv` directory.
    pub environment_path: PathBuf,
    /// Absolute path to the virtual environment's Python executable.
    pub executable_path: PathBuf,
    /// The Workrun-managed interpreter used to create the environment.
    pub python: ManagedPython,
}

/// Result of synchronizing a uv project into its local virtual environment.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencySyncResult {
    pub environment: ManagedVenv,
    pub lockfile_path: PathBuf,
    /// Whether the project already had a lockfile before the sync began.
    pub used_existing_lockfile: bool,
}

/// Captured result from running a Python script in a project environment.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonExecutionResult {
    pub script_path: PathBuf,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

impl PythonRuntime {
    fn validate_version_request(version: &str) -> Result<&str> {
        let version = version.trim();
        let component_count = version.split('.').count();
        if !(2..=3).contains(&component_count) {
            bail!("Python version must be major.minor or major.minor.patch, got {version:?}");
        }

        // uv accepts `3.12`, while semver requires the patch component. Parse a
        // normalized copy solely for validation and retain the user's uv request.
        let semver_version = if component_count == 2 {
            format!("{version}.0")
        } else {
            version.to_string()
        };
        let parsed =
            Version::parse(&semver_version).with_context(|| format!("invalid Python semantic version {version:?}"))?;

        if !parsed.pre.is_empty() || !parsed.build.is_empty() {
            bail!("Python version must not include prerelease or build metadata, got {version:?}");
        }

        Ok(version)
    }

    fn uv_command(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command> {
        let python_dir = dirs::uv_python_dir()?;
        let cache_dir = dirs::uv_cache_dir()?;

        app.shell()
            .sidecar("uv")
            .context("failed to resolve bundled uv sidecar")
            .map(|command| {
                command
                    .env(PYTHON_INSTALL_DIR_ENV, &python_dir)
                    .env(UV_CACHE_DIR_ENV, &cache_dir)
            })
    }

    fn venv_python_path(venv_dir: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            venv_dir.join("Scripts").join("python.exe")
        }

        #[cfg(not(windows))]
        {
            venv_dir.join("bin").join("python")
        }
    }

    fn resolve_project_file(project_path: &Path, path: &Path, kind: &str) -> Result<PathBuf> {
        let candidate = if path.is_absolute() {
            path.to_path_buf()
        } else {
            project_path.join(path)
        };
        let path = dunce::canonicalize(&candidate)
            .with_context(|| format!("failed to resolve {kind} {}", candidate.display()))?;

        if !path.starts_with(project_path) {
            bail!("{kind} must be within project directory: {}", path.display());
        }
        if !path.is_file() {
            bail!("{kind} is not a file: {}", path.display());
        }

        Ok(path)
    }

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

    /// Ensure that the requested Python version is installed in Workrun-managed
    /// storage, then return the interpreter path and its self-reported version.
    pub async fn ensure_python(app: &AppHandle, requested_version: &str) -> Result<ManagedPython> {
        let requested_version = Self::validate_version_request(requested_version)?;
        let uv_python_dir = dirs::uv_python_dir()?;
        let uv_cache_dir = dirs::uv_cache_dir()?;

        tokio::fs::create_dir_all(&uv_python_dir)
            .await
            .with_context(|| format!("failed to create Python install directory {}", uv_python_dir.display()))?;
        tokio::fs::create_dir_all(&uv_cache_dir)
            .await
            .with_context(|| format!("failed to create uv cache directory {}", uv_cache_dir.display()))?;

        let output = Self::uv_command(app)?
            .args(["python", "install", requested_version])
            .output()
            .await
            .context("failed to install Workrun-managed Python")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("failed to install Python {requested_version}: {stderr}");
        }

        // Ask uv for the exact executable instead of inferring a path from its
        // installation directory, which varies by platform and patch release.
        let output = Self::uv_command(app)?
            .args(["python", "find", "--managed-python", requested_version])
            .output()
            .await
            .context("failed to locate Workrun-managed Python")?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("Python {requested_version} was installed but could not be located: {stderr}");
        }

        let executable_path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
        if !executable_path.is_absolute() || !executable_path.is_file() {
            bail!(
                "uv returned an invalid Python executable path: {}",
                executable_path.display()
            );
        }

        let output = app
            .shell()
            .command(&executable_path)
            .arg("--version")
            .output()
            .await
            .with_context(|| format!("failed to execute Python at {}", executable_path.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!(
                "Python at {} exited unsuccessfully: {stderr}",
                executable_path.display()
            );
        }

        // CPython writes `--version` to stdout on current releases, but preserve a
        // fallback for older distributions that write it to stderr.
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let version = if version.is_empty() {
            String::from_utf8_lossy(&output.stderr).trim().to_string()
        } else {
            version
        };

        if version.is_empty() {
            bail!("Python at {} did not report a version", executable_path.display());
        }

        Ok(ManagedPython {
            requested_version: requested_version.to_string(),
            executable_path,
            version,
        })
    }

    /// Ensure that `project_dir/.venv` exists and uses a Workrun-managed Python.
    pub async fn ensure_venv(app: &AppHandle, project_dir: &Path, requested_version: &str) -> Result<ManagedVenv> {
        let project_path = dunce::canonicalize(project_dir)
            .with_context(|| format!("failed to resolve project directory {}", project_dir.display()))?;
        if !project_path.is_dir() {
            bail!("project path is not a directory: {}", project_path.display());
        }

        let python = Self::ensure_python(app, requested_version).await?;
        let environment_path = project_path.join(".venv");

        let output = Self::uv_command(app)?
            .arg("venv")
            .arg(&environment_path)
            .arg("--python")
            .arg(&python.executable_path)
            .output()
            .await
            .with_context(|| format!("failed to create virtual environment in {}", project_path.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!(
                "failed to create virtual environment in {}: {stderr}",
                project_path.display()
            );
        }

        let executable_path = Self::venv_python_path(&environment_path);
        if !executable_path.is_file() {
            bail!(
                "uv created a virtual environment without a Python executable at {}",
                executable_path.display()
            );
        }

        Ok(ManagedVenv {
            project_path,
            environment_path,
            executable_path,
            python,
        })
    }

    /// Synchronize a uv project into its `.venv`.
    ///
    /// Only uv projects are supported here: a `pyproject.toml` is required and
    /// `uv sync` creates or updates `uv.lock` as necessary.
    pub async fn sync_dependencies(
        app: &AppHandle,
        project_dir: &Path,
        requested_version: &str,
    ) -> Result<DependencySyncResult> {
        let project_path = dunce::canonicalize(project_dir)
            .with_context(|| format!("failed to resolve project directory {}", project_dir.display()))?;
        if !project_path.is_dir() {
            bail!("project path is not a directory: {}", project_path.display());
        }

        let pyproject_path = project_path.join("pyproject.toml");
        if !pyproject_path.is_file() {
            bail!("uv project is missing pyproject.toml: {}", pyproject_path.display());
        }

        let lockfile_path = project_path.join("uv.lock");
        let used_existing_lockfile = lockfile_path.is_file();
        let environment = Self::ensure_venv(app, &project_path, requested_version).await?;

        let output = Self::uv_command(app)?
            .arg("sync")
            .arg("--project")
            .arg(&project_path)
            .arg("--python")
            .arg(&environment.executable_path)
            .current_dir(&project_path)
            .output()
            .await
            .with_context(|| format!("failed to sync dependencies for {}", project_path.display()))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            bail!("failed to sync dependencies for {}: {stderr}", project_path.display());
        }

        if !lockfile_path.is_file() {
            bail!(
                "uv sync completed without creating a lockfile at {}",
                lockfile_path.display()
            );
        }

        Ok(DependencySyncResult {
            environment,
            lockfile_path,
            used_existing_lockfile,
        })
    }

    /// Run a Python script with a prepared project virtual environment.
    ///
    /// The script must resolve to a file inside the project directory. A
    /// non-zero script exit is represented in the returned result, rather than
    /// being turned into a runtime setup error.
    pub async fn run_python(
        environment: &ManagedVenv,
        script_path: &Path,
        args: &[String],
    ) -> Result<PythonExecutionResult> {
        if !environment.executable_path.is_file() {
            bail!(
                "project virtual environment Python does not exist: {}",
                environment.executable_path.display()
            );
        }

        let script_path = Self::resolve_project_file(&environment.project_path, script_path, "Python script")?;
        let output = tokio::process::Command::new(&environment.executable_path)
            .current_dir(&environment.project_path)
            .arg(&script_path)
            .args(args)
            .output()
            .await
            .with_context(|| format!("failed to execute Python script {}", script_path.display()))?;

        Ok(PythonExecutionResult {
            script_path,
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::PythonRuntime;

    #[test]
    fn accepts_uv_python_version_requests() {
        assert_eq!(PythonRuntime::validate_version_request("3.12").unwrap(), "3.12");
        assert_eq!(PythonRuntime::validate_version_request(" 3.12.11 ").unwrap(), "3.12.11");
    }

    #[test]
    fn rejects_non_stable_or_incomplete_versions() {
        for version in ["3", "3.12.0-rc.1", "3.12.0+build", "3.x", "3.012"] {
            assert!(
                PythonRuntime::validate_version_request(version).is_err(),
                "{version} should be rejected"
            );
        }
    }
}
