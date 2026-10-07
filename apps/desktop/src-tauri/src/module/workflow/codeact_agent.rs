use super::*;

use crate::module::artifact::{ArtifactStore, MAX_FILE_BYTES, references};
use adk_rust::{
    agent::codeact::CodeActAgent,
    codeact_monty::{MontyRuntime, PathAccess},
};
use serde::Deserialize;
use std::path::PathBuf;
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
    let output_schema = agent_output_schema(node)?;
    let profile_id = string_data(node, "modelProfileId")
        .ok_or_else(|| anyhow!("codeact_agent node `{id}` needs data.modelProfileId"))?;
    let tool_ids = string_array_data(node, "toolIds")?;
    let mut state_bindings = tool_state_bindings(node, &tool_ids)?;
    let max_iterations = integer_data(node, "maxIterations", 8, 1, 50)?;
    let max_tool_calls = integer_data(node, "maxToolCalls", 8, 1, 50)?;
    let tool_timeout_seconds = integer_data(node, "toolTimeoutSeconds", 60, 1, 600)?;
    let tools = ToolRegistry::resolve(&tool_ids).await?;
    validate_tool_state_binding_schemas(node, &tools, &state_bindings)?;
    let model = model_catalog()
        .into_iter()
        .find(|model| model.id == profile_id)
        .ok_or_else(|| anyhow!("codeact_agent node `{id}` references unknown model `{profile_id}`"))?;
    let label = format!("{}/{}", model.id, model.model);
    let model = instrumented_model(create_model(&model, config)?, &id, &label, on_event.clone());
    let tool_calls = Arc::new(AtomicU32::new(0));
    let tool_trace = Arc::new(Mutex::new(Vec::new()));
    let workspace = Arc::new(CodeActWorkspace::new(ArtifactStore::active()?)?);
    let mut agent = CodeActAgent::builder()
        .name(id.clone())
        .description(description)
        .instruction(instruction)
        .model(model)
        .input_guardrails(input_guardrails())
        .output_guardrails(output_guardrails())
        .runtime(build_runtime_with_workspace(node, Some(&workspace))?)
        .max_iterations(max_iterations)
        .tool_timeout(std::time::Duration::from_secs(tool_timeout_seconds.into()));
    if let Some(schema) = output_schema.clone() {
        agent = agent.output_schema(schema);
    }

    for tool in tools {
        let tool_bindings = state_bindings.remove(&tool.id).unwrap_or_default();
        let executor = match tool.source {
            ToolSource::Process => ManagedToolExecutor::Process,
            ToolSource::Mcp => ManagedToolExecutor::Mcp(crate::feat::resolve_mcp_tool(&tool.id).await?.1),
        };
        agent = agent.tool(Arc::new(ManagedTool::new(
            tool,
            executor,
            ManagedToolConfig {
                agent_node_id: id.clone(),
                on_event: on_event.clone(),
                tool_calls: Arc::clone(&tool_calls),
                tool_trace: Arc::clone(&tool_trace),
                state: Arc::clone(&state),
                state_bindings: tool_bindings,
                max_tool_calls,
                timeout_seconds: tool_timeout_seconds.into(),
                execution_profile: WorkflowExecutionProfile::Production,
            },
        )));
    }

    let agent = agent.build()?;
    Ok(graph.add_node(
        StreamingAgentNode::new(
            AdkAgentNode::new(Arc::new(agent)).with_input_mapper(agent_input_mapper(Arc::clone(&state), id.clone())),
            StreamingAgentNodeConfig {
                id,
                kind: "codeact_agent".to_string(),
                endpoint_or_model: label,
                on_event,
                tool_trace: Some(tool_trace),
                output_key: None,
                output_schema,
                state,
                global_keys: state_config.global_keys,
                sensitive_fields: state_config.sensitive_fields,
            },
        )
        .with_codeact_workspace(workspace),
    ))
}

#[cfg(test)]
fn build_runtime(node: &WorkflowNode) -> Result<Arc<MontyRuntime>> {
    build_runtime_with_workspace(node, None)
}

fn build_runtime_with_workspace(
    node: &WorkflowNode,
    workspace: Option<&CodeActWorkspace>,
) -> Result<Arc<MontyRuntime>> {
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

    if let Some(workspace) = workspace {
        runtime = runtime
            .allow_path("/artifacts", workspace.inputs(), PathAccess::ReadOnly)
            .allow_path("/outputs", workspace.outputs(), PathAccess::ReadWrite)
            .additional_prompt("Workrun resources: /artifacts/manifest.json maps each authorized artifact reference to its read-only virtual path. Read it with pathlib.Path.read_text() and json.loads(). Write deliverable files under /outputs using pathlib.Path; regular files there are collected as durable node State artifacts on successful completion. Do not invent ArtifactRef objects or use host paths. Monty cannot install third-party packages; use configured tools for PDF, image or video processing.");
    }

    for mount in mounts {
        validate_virtual_path(&node.id, &mount.virtual_path)?;
        if reserved_mount(&mount.virtual_path) {
            bail!(
                "codeact_agent node `{}` mount overlaps reserved /artifacts or /outputs",
                node.id
            );
        }
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

// Each compiled run owns its copies. Scripts never mount the immutable store itself.
pub(super) struct CodeActWorkspace {
    directory: tempfile::TempDir,
    store: ArtifactStore,
}

impl CodeActWorkspace {
    fn new(store: ArtifactStore) -> Result<Self> {
        let workspace = Self {
            directory: tempfile::tempdir()?,
            store,
        };
        std::fs::create_dir(workspace.inputs())?;
        std::fs::create_dir(workspace.outputs())?;
        Ok(workspace)
    }

    fn inputs(&self) -> PathBuf {
        self.directory.path().join("inputs")
    }
    fn outputs(&self) -> PathBuf {
        self.directory.path().join("outputs")
    }

    pub(super) fn prepare(&self, input: &Value, snapshot: Option<&Value>) -> Result<()> {
        let store = &self.store;
        for directory in [self.inputs(), self.outputs()] {
            std::fs::remove_dir_all(&directory)?;
            std::fs::create_dir(&directory)?;
        }
        let mut manifest = Vec::new();
        let mut seen = HashSet::new();
        let mut total = 0u64;
        for reference in references(input)? {
            if !seen.insert(reference.id.clone()) {
                continue;
            }
            total = total
                .checked_add(reference.size)
                .context("CodeAct input size overflow")?;
            if seen.len() > 100 || total > MAX_FILE_BYTES {
                bail!("CodeAct inputs exceed 100 files or 512 MiB total");
            }
            let source = store.resolve(&reference)?;
            // UUID directories prevent same-name collisions; basename blocks traversal.
            let name = Path::new(&reference.name)
                .file_name()
                .context("Invalid artifact name")?;
            let directory = self.inputs().join(&reference.id);
            std::fs::create_dir_all(&directory)?;
            std::fs::copy(source, directory.join(name))?;
            manifest.push(json!({"reference": reference, "path": format!("/artifacts/{}/{}", reference.id, name.to_string_lossy())}));
        }
        std::fs::write(self.inputs().join("manifest.json"), serde_json::to_vec(&manifest)?)?;
        if let Some(snapshot) = snapshot.filter(|value| !value.is_null()) {
            let files = snapshot.as_array().context("Invalid CodeAct workspace checkpoint")?;
            if files.len() > 100 {
                bail!("CodeAct checkpoint exceeds 100 files");
            }
            let mut total = 0u64;
            for file in files {
                let relative = file["relativePath"]
                    .as_str()
                    .context("Invalid CodeAct checkpoint path")?;
                // Checkpoint paths are data too: never allow restoration outside /outputs.
                if relative.is_empty()
                    || Path::new(relative).is_absolute()
                    || !Path::new(relative)
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_)))
                {
                    bail!("Unsafe CodeAct checkpoint path");
                }
                let reference =
                    serde_json::from_value::<crate::module::artifact::ArtifactRef>(file["reference"].clone())?;
                total = total
                    .checked_add(reference.size)
                    .context("CodeAct checkpoint size overflow")?;
                if total > MAX_FILE_BYTES {
                    bail!("CodeAct checkpoint exceeds 512 MiB");
                }
                let source = store.resolve(&reference)?;
                let destination = self.outputs().join(relative);
                std::fs::create_dir_all(destination.parent().context("Invalid checkpoint path")?)?;
                std::fs::copy(source, destination)?;
            }
        }
        Ok(())
    }

    pub(super) fn snapshot(&self) -> Result<Value> {
        let store = &self.store;
        let files = self.output_paths()?;
        files.iter().map(|path| Ok(json!({
            "relativePath": path.strip_prefix(self.outputs())?.to_str().context("CodeAct output filename must be UTF-8")?,
            "reference": store.import(path)?
        }))).collect::<Result<Vec<_>>>().map(Value::Array)
    }

    pub(super) fn collect(&self) -> Result<Value> {
        let store = &self.store;
        let refs = self
            .output_paths()?
            .iter()
            .map(|path| store.import(path))
            .collect::<Result<Vec<_>>>()?;
        Ok(serde_json::to_value(refs)?)
    }

    fn output_paths(&self) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();
        let mut total = 0u64;
        // Validate the whole tree before persisting any file. Links and special files
        // must not turn collection into access to unrelated host files.
        for entry in walkdir::WalkDir::new(self.outputs())
            .follow_links(false)
            .min_depth(1)
            .max_depth(32)
        {
            let entry = entry?;
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.is_dir() {
                if entry.depth() == 32 {
                    bail!("CodeAct output directory nesting exceeds 31 levels");
                }
                continue;
            }
            if !metadata.is_file() {
                bail!("CodeAct outputs must be regular files, not links or special files");
            }
            total = total
                .checked_add(metadata.len())
                .context("CodeAct output size overflow")?;
            if total > MAX_FILE_BYTES || paths.len() >= 100 {
                bail!("CodeAct outputs exceed 100 files or 512 MiB total");
            }
            paths.push(entry.into_path());
        }
        paths.sort();
        Ok(paths)
    }
}

fn reserved_mount(path: &str) -> bool {
    ["/artifacts", "/outputs"].iter().any(|reserved| {
        path == *reserved || path.starts_with(&format!("{reserved}/")) || reserved.starts_with(&format!("{path}/"))
    })
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
    fn test_workspace() -> (tempfile::TempDir, ArtifactStore, CodeActWorkspace) {
        let root = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(root.path().join("store"));
        let workspace = CodeActWorkspace::new(store.clone()).unwrap();
        (root, store, workspace)
    }

    fn runtime(workspace: &CodeActWorkspace) -> Arc<MontyRuntime> {
        build_runtime_with_workspace(
            &WorkflowNode {
                id: "codeact".into(),
                kind: "codeact_agent".into(),
                data: json!({}),
            },
            Some(workspace),
        )
        .unwrap()
    }

    #[test]
    fn monty_reads_mapped_resources_and_generates_durable_output() {
        use adk_rust::agent::codeact::{CodeRuntime, RunStep};
        let (_root, store, workspace) = test_workspace();
        let first = store.save_bytes("数据.txt", "alpha\n".as_bytes()).unwrap();
        let second = store.save_bytes("数据.txt", b"beta\n").unwrap();
        workspace
            .prepare(&json!({"files": [first.clone(), second.clone(), first]}), None)
            .unwrap();
        let rt = runtime(&workspace);
        let step = rt
            .start(
                r#"from pathlib import Path
import json
files = json.loads(Path("/artifacts/manifest.json").read_text())
texts = [Path(file["path"]).read_text() for file in files]
Path("/outputs/report.txt").write_text("".join(texts))
{"type": "final_result", "value": len(files)}"#,
                "test.py",
            )
            .unwrap();
        assert!(matches!(step, RunStep::Complete { value, .. } if value["value"] == 2));
        let output = workspace.collect().unwrap();
        let refs = references(&output).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "report.txt");
        drop(workspace);
        assert_eq!(
            std::fs::read_to_string(store.resolve(&refs[0]).unwrap()).unwrap(),
            "alpha\nbeta\n"
        );
        assert_eq!(
            std::fs::read_to_string(store.resolve(&second).unwrap()).unwrap(),
            "beta\n"
        );
    }

    #[test]
    fn monty_denies_input_writes_and_unmounted_host_paths() {
        use adk_rust::agent::codeact::{CodeRuntime, RunStep};
        let (_root, store, workspace) = test_workspace();
        let reference = store.save_bytes("input.txt", b"original").unwrap();
        workspace
            .prepare(&json!({"document": reference.clone()}), None)
            .unwrap();
        let rt = runtime(&workspace);
        for script in [
            "from pathlib import Path\nPath('/artifacts/manifest.json').write_text('changed')",
            "from pathlib import Path\nPath('/etc/passwd').read_text()",
            "from pathlib import Path\nPath('/outputs/../artifacts/manifest.json').write_text('changed')",
        ] {
            assert!(matches!(rt.start(script, "test.py").unwrap(), RunStep::Raised { .. }));
        }
        assert_eq!(std::fs::read(store.resolve(&reference).unwrap()).unwrap(), b"original");
    }

    #[test]
    fn generated_files_survive_serialized_continuation_and_new_workspace() {
        use adk_rust::agent::codeact::{CodeRuntime, ResumeWith, RunStep};
        let (_root, store, workspace) = test_workspace();
        workspace.prepare(&json!({}), None).unwrap();
        let rt = runtime(&workspace);
        let step = rt
            .start(
                r#"from pathlib import Path
Path("/outputs/draft.txt").write_text("draft")
result = call_tool("confirm", {})
Path("/outputs/final.txt").write_text(Path("/outputs/draft.txt").read_text() + result)
{"type": "final_result", "value": "ok"}"#,
                "paused.py",
            )
            .unwrap();
        let RunStep::Call { call, .. } = step else {
            panic!("expected tool call")
        };
        let continuation = call.dump().unwrap();
        let snapshot = workspace.snapshot().unwrap();
        drop(call);
        drop(rt);
        drop(workspace);
        let restored = CodeActWorkspace::new(store.clone()).unwrap();
        restored.prepare(&json!({}), Some(&snapshot)).unwrap();
        let result = runtime(&restored)
            .resume(&continuation, ResumeWith::Value(json!(" accepted")))
            .unwrap();
        assert!(matches!(result, RunStep::Complete { .. }));
        assert_eq!(
            std::fs::read_to_string(restored.outputs().join("final.txt")).unwrap(),
            "draft accepted"
        );
        assert_eq!(restored.collect().unwrap().as_array().unwrap().len(), 2);
        restored.prepare(&json!({}), None).unwrap();
        assert!(restored.collect().unwrap().as_array().unwrap().is_empty());
    }

    #[test]
    fn rejects_reserved_mounts_and_unsafe_checkpoint_paths() {
        for path in ["/artifacts", "/artifacts/nested", "/outputs", "/outputs/nested"] {
            assert!(reserved_mount(path));
            let node = WorkflowNode {
                id: "codeact".into(),
                kind: "codeact_agent".into(),
                data: json!({"mounts": [{"virtualPath": path, "hostPath": "/tmp", "access": "read_write"}]}),
            };
            assert!(build_runtime(&node).is_err());
        }
        assert!(!reserved_mount("/outputs-other"));
        let (_root, _store, workspace) = test_workspace();
        for path in ["../escaped", "/absolute", "nested/../../escaped", ""] {
            assert!(
                workspace
                    .prepare(&json!({}), Some(&json!([{"relativePath": path, "reference": {}}])))
                    .unwrap_err()
                    .to_string()
                    .contains("Unsafe")
            );
        }
    }

    #[test]
    fn rejects_excessive_output_count_before_import() {
        let (_root, _store, workspace) = test_workspace();
        for index in 0..101 {
            std::fs::write(workspace.outputs().join(format!("{index}.txt")), b"x").unwrap();
        }
        assert!(workspace.collect().unwrap_err().to_string().contains("100 files"));
        assert!(!_root.path().join("store").exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_output_symlinks() {
        let (_root, _store, workspace) = test_workspace();
        std::os::unix::fs::symlink("/etc/passwd", workspace.outputs().join("linked.txt")).unwrap();
        assert!(workspace.collect().unwrap_err().to_string().contains("regular files"));
    }
    #[test]
    fn maps_only_references_visible_to_the_node() {
        use crate::module::state::{NodeStatePolicy, NodeStateUpdate};
        let (_root, store, workspace) = test_workspace();
        let allowed = store.save_bytes("allowed.txt", b"allowed").unwrap();
        let hidden = store.save_bytes("hidden.txt", b"hidden").unwrap();
        let mut bridge = WorkflowStateBridge::from_initial_state_with_policy(
            json!({"visibleFile": allowed, "secretFile": hidden.clone()}),
            BTreeSet::new(),
            BTreeSet::from(["secretFile".into()]),
        )
        .unwrap();
        bridge.configure_node(
            "producer",
            NodeStatePolicy {
                readers: AccessRule::only(["consumer"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "producer",
                NodeStateUpdate::new().set("privateFile", json!(hidden)),
                &BTreeSet::new(),
            )
            .unwrap();
        workspace.prepare(&bridge.agent_input("other").unwrap(), None).unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(workspace.inputs().join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.as_array().unwrap().len(), 1);
        workspace
            .prepare(&bridge.agent_input("consumer").unwrap(), None)
            .unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(workspace.inputs().join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest.as_array().unwrap().len(), 2);
    }
    struct FileGeneratingModel;

    #[async_trait::async_trait]
    impl Llm for FileGeneratingModel {
        fn name(&self) -> &str {
            "file-generating-test"
        }
        async fn generate_content(
            &self,
            request: adk_rust::LlmRequest,
            _: bool,
        ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
            assert!(
                serde_json::to_string(&request)
                    .unwrap()
                    .contains("/artifacts/manifest.json")
            );
            Ok(Box::pin(futures::stream::iter([Ok(adk_rust::LlmResponse::new(
                Content::new("model").with_text(
                    r#"```python
from pathlib import Path
import json
files = json.loads(Path("/artifacts/manifest.json").read_text())
text = Path(files[0]["path"]).read_text()
Path("/outputs/report.txt").write_text(text + " processed")
{"type": "final_result", "value": "finished"}
```"#,
                ),
            ))])))
        }
    }

    #[tokio::test]
    async fn streaming_codeact_publishes_files_to_authorized_downstream_state() {
        use crate::module::state::NodeStatePolicy;
        let (_root, store, workspace) = test_workspace();
        let input = store.save_bytes("input.txt", b"source").unwrap();
        let state = Arc::new(Mutex::new(
            WorkflowStateBridge::from_initial_state(json!({"document": input})).unwrap(),
        ));
        state.lock().unwrap().configure_node(
            "codeact",
            NodeStatePolicy {
                readers: AccessRule::only(["consumer"]),
                ..Default::default()
            },
        );
        let workspace = Arc::new(workspace);
        let agent = CodeActAgent::builder()
            .name("codeact")
            .model(Arc::new(FileGeneratingModel))
            .runtime(runtime(&workspace))
            .max_iterations(1)
            .build()
            .unwrap();
        let node = StreamingAgentNode::new(
            AdkAgentNode::new(Arc::new(agent))
                .with_input_mapper(agent_input_mapper(Arc::clone(&state), "codeact".into())),
            StreamingAgentNodeConfig {
                id: "codeact".into(),
                kind: "codeact_agent".into(),
                endpoint_or_model: "test".into(),
                on_event: None,
                tool_trace: None,
                output_key: None,
                output_schema: None,
                state: Arc::clone(&state),
                global_keys: BTreeSet::new(),
                sensitive_fields: BTreeSet::new(),
            },
        )
        .with_codeact_workspace(workspace);
        let context = NodeContext::new(HashMap::new(), ExecutionConfig::default(), 0);
        let events = node.execute_stream(&context).collect::<Vec<_>>().await;
        for event in events {
            event.unwrap();
        }
        drop(node);
        let state = state.lock().unwrap();
        let downstream = state.agent_input("consumer").unwrap();
        let refs = references(&downstream["artifacts"]).unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(
            std::fs::read_to_string(store.resolve(&refs[0]).unwrap()).unwrap(),
            "source processed"
        );
        assert!(state.agent_input("other").unwrap().get("artifacts").is_none());
        assert!(state.codeact_files("codeact").is_none());
    }
    #[test]
    fn rejects_input_and_output_byte_limits_before_copying_or_importing() {
        let (_root, store, workspace) = test_workspace();
        let mut reference = store.save_bytes("input.txt", b"x").unwrap();
        reference.size = MAX_FILE_BYTES + 1;
        assert!(
            workspace
                .prepare(&json!({"document": reference}), None)
                .unwrap_err()
                .to_string()
                .contains("512 MiB")
        );
        let output = std::fs::File::create(workspace.outputs().join("large.bin")).unwrap();
        output.set_len(MAX_FILE_BYTES + 1).unwrap();
        assert!(workspace.collect().unwrap_err().to_string().contains("512 MiB"));
    }
}
