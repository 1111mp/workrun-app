use super::types::*;
use crate::{
    config::{IProcessNode, ProcessNodeKind, validate_process_node_definition},
    feat,
    module::python_runtime::PythonRuntime,
};
use anyhow::{Context, Result, bail};
use std::path::Path;
use tauri::ipc::Channel;

impl ProcessNodeRegistry {
    /// Initialize a local uv project for an already validated catalog entry.
    pub async fn initialize_project(
        definition: &IProcessNode,
        progress: Channel<feat::ProcessNodeCreateProgress>,
    ) -> Result<()> {
        validate_process_node_definition(definition)?;
        let project_path = Self::project_path(&definition)?;
        match tokio::fs::metadata(&project_path).await {
            Ok(_) => bail!(
                "Process Node project directory already exists: {}",
                project_path.display()
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("failed to inspect Process Node project {}", project_path.display()));
            },
        }
        let _ = progress.send(feat::ProcessNodeCreateProgress {
            stage: feat::ProcessNodeCreateStage::CreatingProject,
        });
        let project_parent = project_path
            .parent()
            .context("Process Node project directory has no parent")?;
        tokio::fs::create_dir_all(project_parent).await.with_context(|| {
            format!(
                "failed to create Process Node project parent {}",
                project_parent.display()
            )
        })?;
        tokio::fs::create_dir(&project_path)
            .await
            .with_context(|| format!("failed to create Process Node project {}", project_path.display()))?;

        let result: Result<()> = async {
            PythonRuntime::init_application_project(&project_path).await?;
            let _ = progress.send(feat::ProcessNodeCreateProgress {
                stage: feat::ProcessNodeCreateStage::AddingSdkDependency,
            });
            PythonRuntime::add_workrun_sdk_dependency(&project_path).await?;
            let _ = progress.send(feat::ProcessNodeCreateProgress {
                stage: feat::ProcessNodeCreateStage::InitializingEnvironment,
            });
            PythonRuntime::sync_dependencies(&project_path, "3.12").await?;
            let _ = progress.send(feat::ProcessNodeCreateProgress {
                stage: feat::ProcessNodeCreateStage::SavingApp,
            });
            tokio::fs::write(project_path.join(&definition.entry), starter_script(definition.kind)).await?;
            Ok(())
        }
        .await;

        if let Err(error) = result {
            let _ = tokio::fs::remove_dir_all(&project_path).await;
            return Err(error).with_context(|| "failed to initialize Process Node project");
        }
        Ok(())
    }
}

/// uv writes this file for initialized projects. Prefer it over a host-wide
/// default so a node's declared runtime (for example Python 3.14) is honored.
pub(super) async fn project_python_version(project_path: &Path) -> Result<String> {
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
pub(super) async fn installation_status(project_path: &Path) -> (ProcessNodeInstallStatus, Option<String>) {
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
fn starter_script(kind: ProcessNodeKind) -> &'static str {
    match kind {
        ProcessNodeKind::Workflow => {
            "\"\"\"Workflow App entrypoint.\n\nWorkrun provides the workflow state as JSON on stdin. Use process.result({...}) once to return structured data; stdout and stderr remain available for logs.\n\"\"\"\n\nimport json\nimport sys\n\nfrom workrun_sdk import process\n\n\ndef main() -> None:\n    raw_input = sys.stdin.read()\n    state = json.loads(raw_input) if raw_input else {}\n    print(f\"Workflow App received {len(state)} state fields\")\n    process.result({\"processed\": True})\n\n\nif __name__ == \"__main__\":\n    main()\n"
        },
        ProcessNodeKind::Tool => {
            "\"\"\"Tool App entrypoint.\n\nWorkrun validates the Agent arguments against this App's input fields, then invokes the decorated function. Return a JSON object that matches the configured output fields.\n\"\"\"\n\nfrom workrun_sdk.tool import tool\n\n\n@tool(\n    name=\"process_data\",\n    description=\"Process the arguments supplied by the Agent.\",\n)\ndef process_data(**arguments: object) -> dict[str, object]:\n    print(f\"Tool App received {len(arguments)} arguments\")\n    return {\"processed\": True}\n"
        },
    }
}
