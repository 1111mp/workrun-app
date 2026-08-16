use super::types::*;
use crate::module::{python_runtime::PythonRuntime, tool_registry::ToolRiskLevel};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, ipc::Channel};
use uuid::Uuid;

impl ProcessNodeRegistry {
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
            kind: request.kind,
            tool_execution_policy: ToolExecutionPolicy::AskEveryTime,
            tool_risk_level: ToolRiskLevel::Low,
            tool_permissions: Vec::new(),
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
            tokio::fs::write(project_path.join(&definition.entry), starter_script(definition.kind)).await?;
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
