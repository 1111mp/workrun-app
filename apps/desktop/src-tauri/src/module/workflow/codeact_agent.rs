use super::*;

use adk_rust::{
    agent::codeact::CodeActAgent,
    codeact_monty::{MontyRuntime, PathAccess},
};
use serde::Deserialize;
use std::{collections::HashSet, path::Path, time::Duration};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeActMount {
    virtual_path: String,
    host_path: String,
    access: CodeActMountAccess,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CodeActMountAccess {
    ReadOnly,
    ReadWrite,
}

impl From<CodeActMountAccess> for PathAccess {
    fn from(access: CodeActMountAccess) -> Self {
        match access {
            CodeActMountAccess::ReadOnly => Self::ReadOnly,
            CodeActMountAccess::ReadWrite => Self::ReadWrite,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeActEnvironmentBinding {
    name: String,
    value: String,
}

pub(super) async fn add_codeact_agent_node(
    graph: StateGraph,
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> Result<StateGraph> {
    let id = node.id.clone();
    let description = string_data(node, "description").unwrap_or_default();
    let instruction = string_data(node, "instruction").unwrap_or_default();
    let profile_id = string_data(node, "modelProfileId")
        .ok_or_else(|| anyhow!("codeact_agent node `{id}` needs data.modelProfileId"))?;
    let tool_ids = string_array_data(node, "toolIds")?;
    let max_iterations = integer_data(node, "maxIterations", 8, 1, 50)?;
    let max_tool_calls = integer_data(node, "maxToolCalls", 8, 1, 50)?;
    let tool_timeout_seconds = integer_data(node, "toolTimeoutSeconds", 60, 1, 600)?;
    let tools = ToolRegistry::resolve(&tool_ids).await?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("codeact_agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let tool_calls = Arc::new(AtomicU32::new(0));
    let tool_trace = Arc::new(Mutex::new(Vec::new()));
    let mut agent = CodeActAgent::builder()
        .name(id.clone())
        .description(description)
        .instruction(instruction)
        .model(create_model(&model, config)?)
        .input_guardrails(input_guardrails())
        .output_guardrails(output_guardrails())
        .runtime(build_runtime(node)?)
        .max_iterations(max_iterations)
        .tool_timeout(std::time::Duration::from_secs(tool_timeout_seconds.into()));

    for tool in tools {
        let executor = match tool.source {
            ToolSource::Process => ManagedToolExecutor::Process,
            ToolSource::Mcp => ManagedToolExecutor::Mcp(McpServerRegistry::resolve_tool(&tool.id).await?.1),
        };
        agent = agent.tool(Arc::new(ManagedTool::new(
            tool,
            executor,
            id.clone(),
            on_event.clone(),
            Arc::clone(&tool_calls),
            Arc::clone(&tool_trace),
            Arc::clone(&state),
            max_tool_calls,
            tool_timeout_seconds.into(),
        )));
    }

    let agent = agent.build()?;
    Ok(graph.add_node(StreamingAgentNode::new(
        AdkAgentNode::new(Arc::new(agent)).with_input_mapper(agent_input_mapper(Arc::clone(&state), id.clone())),
        id,
        "codeact_agent",
        label,
        on_event,
        Some(tool_trace),
        None,
        state,
        state_config.global_keys,
    )))
}

fn build_runtime(node: &WorkflowNode) -> Result<Arc<MontyRuntime>> {
    let max_duration_seconds = integer_data(node, "maxScriptDurationSeconds", 5, 1, 300)?;
    let max_memory_mib = integer_data(node, "maxScriptMemoryMiB", 256, 16, 4096)?;
    let system_clock = match node.data.get("systemClock") {
        Some(value) => value
            .as_bool()
            .ok_or_else(|| anyhow!("codeact_agent node `{}` field `systemClock` must be a boolean", node.id))?,
        None => true,
    };
    let mounts = runtime_list::<CodeActMount>(node, "mounts")?;
    let environment = runtime_list::<CodeActEnvironmentBinding>(node, "environment")?;
    let mut virtual_paths = HashSet::new();
    let mut environment_names = HashSet::new();
    let mut runtime = MontyRuntime::builder()
        .max_duration(Duration::from_secs(max_duration_seconds.into()))
        .max_memory(max_memory_mib as usize * 1024 * 1024)
        .system_clock(system_clock);

    for mount in mounts {
        validate_virtual_path(&node.id, &mount.virtual_path)?;
        if !virtual_paths.insert(mount.virtual_path.clone()) {
            bail!(
                "codeact_agent node `{}` has duplicate mount `{}`",
                node.id,
                mount.virtual_path
            );
        }
        let host_path = Path::new(&mount.host_path);
        if !host_path.is_absolute() {
            bail!(
                "codeact_agent node `{}` mount `{}` must use an absolute host path",
                node.id,
                mount.virtual_path
            );
        }
        let host_path = std::fs::canonicalize(host_path).map_err(|error| {
            anyhow!(
                "codeact_agent node `{}` mount `{}` cannot access `{}`: {error}",
                node.id,
                mount.virtual_path,
                mount.host_path
            )
        })?;
        if !host_path.is_dir() {
            bail!(
                "codeact_agent node `{}` mount `{}` must reference a directory",
                node.id,
                mount.virtual_path
            );
        }
        runtime = runtime.allow_path(mount.virtual_path, host_path, mount.access.into());
    }

    for binding in environment {
        if !is_environment_name(&binding.name) {
            bail!(
                "codeact_agent node `{}` has invalid environment variable name `{}`",
                node.id,
                binding.name
            );
        }
        if !environment_names.insert(binding.name.clone()) {
            bail!(
                "codeact_agent node `{}` has duplicate environment variable `{}`",
                node.id,
                binding.name
            );
        }
        runtime = runtime.environ_var(binding.name, binding.value);
    }

    Ok(Arc::new(runtime.build()))
}

fn runtime_list<T>(node: &WorkflowNode, key: &str) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    let Some(value) = node.data.get(key) else {
        return Ok(Vec::new());
    };
    serde_json::from_value(value.clone())
        .map_err(|error| anyhow!("codeact_agent node `{}` field `{key}` is invalid: {error}", node.id))
}

fn validate_virtual_path(node_id: &str, path: &str) -> Result<()> {
    let valid = path.starts_with('/')
        && path != "/"
        && path
            .split('/')
            .skip(1)
            .all(|part| !part.is_empty() && part != "." && part != "..");
    if !valid {
        bail!(
            "codeact_agent node `{node_id}` mount virtual paths must be absolute and cannot contain '.', '..', or empty segments"
        );
    }
    Ok(())
}

fn is_environment_name(name: &str) -> bool {
    let mut characters = name.bytes();
    matches!(characters.next(), Some(byte) if byte.is_ascii_alphabetic() || byte == b'_')
        && characters.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_unsafe_virtual_mount_paths() {
        assert!(validate_virtual_path("codeact", "/data").is_ok());
        assert!(validate_virtual_path("codeact", "/").is_err());
        assert!(validate_virtual_path("codeact", "/data/../private").is_err());
        assert!(validate_virtual_path("codeact", "data").is_err());
    }

    #[test]
    fn validates_environment_variable_names() {
        assert!(is_environment_name("API_TOKEN"));
        assert!(is_environment_name("_WORKRUN"));
        assert!(!is_environment_name("1TOKEN"));
        assert!(!is_environment_name("API-TOKEN"));
    }

    #[test]
    fn accepts_inline_environment_values() {
        let node = WorkflowNode {
            id: "codeact".into(),
            kind: "codeact_agent".into(),
            data: json!({
                "environment": [{"name": "API_TOKEN", "value": "token"}]
            }),
        };

        assert!(build_runtime(&node).is_ok());
    }
}
