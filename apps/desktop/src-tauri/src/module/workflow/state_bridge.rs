//! Boundary between Workrun's access-controlled State and ADK's graph state.

use super::{ToolStateBinding, redact_json, visible_input_state};
use crate::{
    config::{decrypt_data_with_key, encrypt_data_with_key},
    module::state::{NodeState, NodeStatePolicy, NodeStateUpdate, RuntimeState, State as WorkrunState, StateError},
};
use adk_rust::{
    graph::checkpoint::RetentionPolicy,
    graph::{Checkpoint, Checkpointer, GraphError, Result as GraphResult, State as GraphState},
};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const STATE_CHECKPOINT_METADATA_KEY: &str = "workrun.workflow_state";
const STATE_CHECKPOINT_VERSION: u16 = 2;

/// Owns the access-controlled workflow state and exports only its public
/// `global` namespace to ADK's shared graph state.
pub struct WorkflowStateBridge {
    raw_state: WorkrunState,
    visible_state: WorkrunState,
    input_raw_readers: BTreeSet<String>,
    input_sensitive_fields: BTreeSet<String>,
    global_owners: BTreeMap<String, String>,
}

/// Private workflow state persisted alongside one ADK graph checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStateCheckpoint {
    version: u16,
    workflow_id: String,
    workflow_fingerprint: String,
    visible_state: WorkrunState,
    encrypted_raw_state: String,
    input_raw_readers: BTreeSet<String>,
    input_sensitive_fields: BTreeSet<String>,
    #[serde(default)]
    global_owners: BTreeMap<String, String>,
}

/// A checkpointer wrapper that atomically embeds Workrun State in ADK's
/// checkpoint metadata. The graph state itself remains public-only.
pub struct WorkflowStateCheckpointer {
    inner: Arc<dyn Checkpointer>,
    bridge: Arc<Mutex<WorkflowStateBridge>>,
    workflow_id: String,
    workflow_fingerprint: String,
    encryption_key: Arc<Vec<u8>>,
}

impl WorkflowStateBridge {
    /// Import the run input into the public global namespace. The new workflow
    /// contract requires an object because every input field is a global key.
    pub fn from_initial_state(initial_state: Value) -> Result<Self> {
        Self::from_initial_state_with_policy(initial_state, BTreeSet::new(), BTreeSet::new())
    }

    pub fn from_initial_state_with_policy(
        initial_state: Value,
        input_raw_readers: BTreeSet<String>,
        input_sensitive_fields: BTreeSet<String>,
    ) -> Result<Self> {
        let fields = initial_state
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("workflow initial state must be a JSON object"))?;
        let visible = visible_input_state(&initial_state, &input_sensitive_fields);
        let visible_fields = visible.as_object().expect("visible input remains an object");
        let mut raw_state = WorkrunState::new();
        let mut visible_state = WorkrunState::new();
        let mut raw_runtime = raw_state.runtime();
        let mut visible_runtime = visible_state.runtime();
        for (key, value) in fields {
            raw_runtime.global_set(key.clone(), value.clone());
            visible_runtime.global_set(key.clone(), visible_fields.get(key).cloned().unwrap_or(Value::Null));
        }
        Ok(Self {
            raw_state,
            visible_state,
            input_raw_readers,
            input_sensitive_fields,
            global_owners: BTreeMap::new(),
        })
    }

    pub fn initialize_global(&mut self, initial_state: Value) -> Result<()> {
        let fields = initial_state
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("workflow initial state must be a JSON object"))?;
        let visible = visible_input_state(&initial_state, &self.input_sensitive_fields);
        let visible_fields = visible.as_object().expect("visible input remains an object");
        let mut raw_runtime = self.raw_state.runtime();
        let mut visible_runtime = self.visible_state.runtime();
        for (key, value) in fields {
            raw_runtime.global_set(key.clone(), value.clone());
            visible_runtime.global_set(key.clone(), visible_fields.get(key).cloned().unwrap_or(Value::Null));
        }
        Ok(())
    }

    /// ADK receives a flat copy of global state for routing and interrupts.
    /// Node-private and runtime data are never placed in graph state.
    pub fn graph_state(&mut self) -> GraphState {
        self.visible_state
            .runtime()
            .global_snapshot()
            .as_object()
            .expect("global state is always a JSON object")
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    /// Build a flat JSON input from global values and the node namespaces it
    /// may read. Namespace names are deliberately not exposed to executors.
    /// A duplicated key is reported with both sources rather than overwritten.
    pub fn node_input(&mut self, node_id: impl Into<String>) -> Result<Value, StateError> {
        let node_id = node_id.into();
        let raw_global_keys = self.raw_global_keys_for(&node_id);
        self.visible_state
            .scoped_mixed_input(&self.raw_state, &node_id, &raw_global_keys)
    }

    /// Agent prompts never receive raw values, even when their tools are an
    /// authorized raw reader.
    pub fn agent_input(&self, node_id: &str) -> Result<Value, StateError> {
        self.visible_state.scoped_visible_input(node_id)
    }

    /// Resolve values hidden from an Agent immediately before its tool runs.
    /// Only argument keys already selected by the Agent are replaced, so raw
    /// State cannot expand a tool call beyond its declared schema.
    pub fn tool_args(&self, node_id: &str, args: &Value, bindings: &[ToolStateBinding]) -> Result<Value> {
        let visible = self.visible_state.scoped_visible_input(node_id)?;
        let mixed =
            self.visible_state
                .scoped_mixed_input(&self.raw_state, node_id, &self.raw_global_keys_for(node_id))?;
        let mut resolved = args.clone();
        // Same-path recovery only replaces leaves the Agent already selected;
        // it must not expose sibling raw fields from a containing object.
        overlay_authorized_raw(&mut resolved, &visible, &mixed);
        for binding in bindings {
            let value = value_at_path(&mixed, &binding.state_path).ok_or_else(|| {
                anyhow::anyhow!(
                    "Tool State Binding source `{}` is unavailable to node `{node_id}`",
                    binding.state_path
                )
            })?;
            // Explicit bindings still require the Agent to include the target
            // argument, keeping the eventual call inside its proposed shape.
            if !set_existing_path(&mut resolved, &binding.argument_path, value.clone()) {
                anyhow::bail!(
                    "Tool State Binding target `{}` is missing from the proposed arguments",
                    binding.argument_path
                );
            }
        }
        Ok(resolved)
    }

    /// Apply one node's result. Only keys explicitly configured for publication
    /// reach global state; every other key remains in the node namespace. The
    /// returned values must be mirrored into ADK state for graph routing.
    pub fn apply_node_update(
        &mut self,
        node_id: &str,
        update: NodeStateUpdate,
        global_keys: &BTreeSet<String>,
    ) -> Result<HashMap<String, Value>, StateError> {
        let visible_update = update.map_values(redact_json);
        for key in update.global_values(global_keys).keys() {
            self.global_owners.insert(key.clone(), node_id.to_string());
        }
        let visible_global_values = visible_update.global_values(global_keys);
        let raw_patch = update.into_patch(node_id, global_keys);
        let visible_patch = visible_update.into_patch(node_id, global_keys);
        self.raw_state.node(node_id).apply(&raw_patch)?;
        self.visible_state.node(node_id).apply(&visible_patch)?;
        Ok(visible_global_values.into_iter().collect())
    }

    pub fn configure_node(&mut self, node_id: &str, policy: NodeStatePolicy) {
        self.raw_state.runtime().configure_node(node_id, policy.clone());
        self.visible_state.runtime().configure_node(node_id, policy);
    }

    fn raw_global_keys_for(&self, requester: &str) -> BTreeSet<String> {
        self.visible_state
            .runtime_global_keys()
            .into_iter()
            .filter(|key| match self.global_owners.get(key) {
                Some(owner) => self.visible_state.namespace_allows_raw(owner, requester),
                None => self.input_raw_readers.contains(requester),
            })
            .collect()
    }

    /// Give a workflow node its restricted State view.
    pub fn node_state(&mut self, node_id: impl Into<String>) -> NodeState<'_> {
        self.raw_state.node(node_id)
    }

    /// Give trusted workflow infrastructure its full State view.
    pub fn runtime_state(&mut self) -> RuntimeState<'_> {
        self.raw_state.runtime()
    }

    /// Global-only output for graph synchronization and narrow API consumers.
    pub fn public_output(&mut self) -> Value {
        self.visible_state.runtime().global_snapshot()
    }

    /// Complete user-visible workflow output. Node ACLs apply only while a
    /// workflow executes; the final observer view includes every node value.
    /// Runtime state and policy details remain internal.
    pub fn final_output(&self, graph_state: &GraphState) -> Value {
        let mut output = self.visible_state.workflow_snapshot();
        let workflow = graph_state
            .iter()
            .filter(|(key, _)| key.starts_with("workflow."))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        output["workflow"] = Value::Object(workflow);
        output
    }

    fn checkpoint(
        &self,
        workflow_id: &str,
        workflow_fingerprint: &str,
        encryption_key: &[u8],
    ) -> Result<WorkflowStateCheckpoint> {
        let raw_json = serde_json::to_string(&self.raw_state)?;
        let encrypted_raw_state =
            encrypt_data_with_key(&raw_json, encryption_key).map_err(|error| anyhow::anyhow!(error.to_string()))?;
        Ok(WorkflowStateCheckpoint {
            version: STATE_CHECKPOINT_VERSION,
            workflow_id: workflow_id.to_string(),
            workflow_fingerprint: workflow_fingerprint.to_string(),
            visible_state: self.visible_state.clone(),
            encrypted_raw_state,
            input_raw_readers: self.input_raw_readers.clone(),
            input_sensitive_fields: self.input_sensitive_fields.clone(),
            global_owners: self.global_owners.clone(),
        })
    }

    fn from_checkpoint(checkpoint: WorkflowStateCheckpoint, encryption_key: &[u8]) -> Result<Self> {
        let raw_json = decrypt_data_with_key(&checkpoint.encrypted_raw_state, encryption_key)
            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
        Ok(Self {
            raw_state: serde_json::from_str(&raw_json)?,
            visible_state: checkpoint.visible_state,
            input_raw_readers: checkpoint.input_raw_readers,
            input_sensitive_fields: checkpoint.input_sensitive_fields,
            global_owners: checkpoint.global_owners,
        })
    }
}

fn overlay_authorized_raw(target: &mut Value, visible: &Value, mixed: &Value) {
    match target {
        Value::Object(target) => {
            for (key, target_value) in target {
                let (Some(visible_value), Some(mixed_value)) = (visible.get(key), mixed.get(key)) else {
                    continue;
                };
                overlay_authorized_raw(target_value, visible_value, mixed_value);
            }
        },
        Value::Array(target) => {
            let (Some(visible), Some(mixed)) = (visible.as_array(), mixed.as_array()) else {
                return;
            };
            for (index, target_value) in target.iter_mut().enumerate() {
                let (Some(visible_value), Some(mixed_value)) = (visible.get(index), mixed.get(index)) else {
                    continue;
                };
                overlay_authorized_raw(target_value, visible_value, mixed_value);
            }
        },
        _ if visible != mixed => *target = mixed.clone(),
        _ => {},
    }
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |value, segment| match value {
        Value::Object(object) => object.get(segment),
        Value::Array(array) => segment.parse::<usize>().ok().and_then(|index| array.get(index)),
        _ => None,
    })
}

fn set_existing_path(value: &mut Value, path: &str, replacement: Value) -> bool {
    let mut segments = path.split('.').peekable();
    let mut current = value;
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            return match current {
                Value::Object(object) if object.contains_key(segment) => {
                    object.insert(segment.to_string(), replacement);
                    true
                },
                Value::Array(array) => segment
                    .parse::<usize>()
                    .ok()
                    .and_then(|index| array.get_mut(index))
                    .map(|value| *value = replacement)
                    .is_some(),
                _ => false,
            };
        }
        current = match current {
            Value::Object(object) => match object.get_mut(segment) {
                Some(value) => value,
                None => return false,
            },
            Value::Array(array) => match segment.parse::<usize>().ok().and_then(|index| array.get_mut(index)) {
                Some(value) => value,
                None => return false,
            },
            _ => return false,
        };
    }
    false
}

impl WorkflowStateCheckpointer {
    pub fn new(
        inner: Arc<dyn Checkpointer>,
        bridge: Arc<Mutex<WorkflowStateBridge>>,
        workflow_id: impl Into<String>,
        workflow_fingerprint: impl Into<String>,
    ) -> Result<Self> {
        #[cfg(test)]
        let encryption_key = vec![0x57; 32];
        #[cfg(not(test))]
        let encryption_key = crate::utils::dirs::get_encryption_key()?;
        Ok(Self {
            inner,
            bridge,
            workflow_id: workflow_id.into(),
            workflow_fingerprint: workflow_fingerprint.into(),
            encryption_key: Arc::new(encryption_key),
        })
    }

    fn checkpoint_metadata(&self) -> GraphResult<Value> {
        let bridge = self
            .bridge
            .lock()
            .map_err(|_| GraphError::CheckpointError("workflow state lock is poisoned".to_string()))?;
        serde_json::to_value(
            bridge
                .checkpoint(&self.workflow_id, &self.workflow_fingerprint, &self.encryption_key)
                .map_err(|error| GraphError::CheckpointError(error.to_string()))?,
        )
        .map_err(|error| GraphError::CheckpointError(error.to_string()))
    }

    fn restore(&self, checkpoint: &Checkpoint) -> GraphResult<()> {
        let value = checkpoint
            .metadata
            .get(STATE_CHECKPOINT_METADATA_KEY)
            .ok_or_else(|| GraphError::CheckpointError("workflow state checkpoint is missing".to_string()))?;
        let saved: WorkflowStateCheckpoint = serde_json::from_value(value.clone())
            .map_err(|error| GraphError::CheckpointError(format!("workflow state checkpoint is invalid: {error}")))?;
        if saved.version != STATE_CHECKPOINT_VERSION {
            return Err(GraphError::CheckpointError(format!(
                "workflow state checkpoint version {} is unsupported",
                saved.version
            )));
        }
        if saved.workflow_id != self.workflow_id || saved.workflow_fingerprint != self.workflow_fingerprint {
            return Err(GraphError::CheckpointError(
                "workflow state checkpoint does not match this workflow".to_string(),
            ));
        }
        let mut bridge = self
            .bridge
            .lock()
            .map_err(|_| GraphError::CheckpointError("workflow state lock is poisoned".to_string()))?;
        *bridge = WorkflowStateBridge::from_checkpoint(saved, &self.encryption_key)
            .map_err(|error| GraphError::CheckpointError(error.to_string()))?;
        Ok(())
    }

    /// Persist an external workflow interaction (for example a review edit).
    /// `workflow.*` keys are graph-control signals; all other keys are user
    /// data and must be mirrored into global State before checkpointing.
    pub async fn update_state(
        &self,
        thread_id: &str,
        updates: impl IntoIterator<Item = (String, Value)>,
    ) -> GraphResult<()> {
        let Some(mut checkpoint) = self.load(thread_id).await? else {
            return Ok(());
        };
        let updates = updates.into_iter().collect::<Vec<_>>();
        let mut persisted_updates = Vec::with_capacity(updates.len());
        {
            let mut bridge = self
                .bridge
                .lock()
                .map_err(|_| GraphError::CheckpointError("workflow state lock is poisoned".to_string()))?;
            for (key, value) in &updates {
                if key.starts_with("workflow.") {
                    persisted_updates.push((key.clone(), value.clone()));
                } else {
                    bridge.raw_state.runtime().global_set(key.clone(), value.clone());
                    let visible = visible_input_state(
                        &Value::Object([(key.clone(), value.clone())].into_iter().collect()),
                        &bridge.input_sensitive_fields,
                    );
                    let visible_value = visible.get(key).cloned().unwrap_or(Value::Null);
                    bridge
                        .visible_state
                        .runtime()
                        .global_set(key.clone(), visible_value.clone());
                    persisted_updates.push((key.clone(), visible_value));
                }
            }
        }
        for (key, value) in persisted_updates {
            checkpoint.state.insert(key, value);
        }
        // Checkpointers append history rather than replacing an existing row.
        // Persist this external interaction as a successor checkpoint so SQLite
        // does not reject the existing checkpoint ID as a duplicate primary key.
        checkpoint.checkpoint_id = Uuid::new_v4().to_string();
        checkpoint.created_at = chrono::Utc::now();
        self.save(&checkpoint).await?;
        Ok(())
    }
}

#[async_trait]
impl Checkpointer for WorkflowStateCheckpointer {
    async fn save(&self, checkpoint: &Checkpoint) -> GraphResult<String> {
        let mut checkpoint = checkpoint.clone();
        checkpoint
            .metadata
            .insert(STATE_CHECKPOINT_METADATA_KEY.to_string(), self.checkpoint_metadata()?);
        self.inner.save(&checkpoint).await
    }

    async fn load(&self, thread_id: &str) -> GraphResult<Option<Checkpoint>> {
        let checkpoint = self.inner.load(thread_id).await?;
        if let Some(checkpoint) = &checkpoint {
            self.restore(checkpoint)?;
        }
        Ok(checkpoint)
    }

    async fn load_by_id(&self, checkpoint_id: &str) -> GraphResult<Option<Checkpoint>> {
        let checkpoint = self.inner.load_by_id(checkpoint_id).await?;
        if let Some(checkpoint) = &checkpoint {
            self.restore(checkpoint)?;
        }
        Ok(checkpoint)
    }

    async fn list(&self, thread_id: &str) -> GraphResult<Vec<Checkpoint>> {
        self.inner.list(thread_id).await
    }

    async fn delete(&self, thread_id: &str) -> GraphResult<()> {
        self.inner.delete(thread_id).await
    }

    async fn prune(&self, thread_id: &str, policy: &RetentionPolicy) -> GraphResult<usize> {
        self.inner.prune(thread_id, policy).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::state::{AccessRule, NodeStatePolicy};
    use adk_rust::graph::{MemoryCheckpointer, SqliteCheckpointer};
    use serde_json::json;

    #[test]
    fn imports_initial_input_as_global_graph_state() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();

        assert_eq!(bridge.graph_state(), HashMap::from([("prompt".into(), json!("hello"))]));
        assert_eq!(bridge.public_output(), json!({"prompt": "hello"}));
    }

    #[test]
    fn graph_state_excludes_private_and_runtime_data() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge
            .node_state("extractor")
            .create("draft", json!("private"))
            .unwrap();
        bridge.runtime_state().runtime_set("approval", json!("secret"));

        assert_eq!(bridge.graph_state(), HashMap::from([("prompt".into(), json!("hello"))]));
    }

    #[test]
    fn node_input_projects_only_authorized_private_state() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge.configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["reviewer"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new().set("customer", json!({"id": 1})),
                &BTreeSet::new(),
            )
            .unwrap();

        assert_eq!(
            bridge.node_input("reviewer").unwrap(),
            json!({
                "prompt": "hello",
                "customer": {"id": 1},
            })
        );
        assert_eq!(bridge.node_input("other").unwrap(), json!({"prompt": "hello"}));
    }

    #[test]
    fn raw_readers_replace_only_the_authorized_owner_namespace() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge.configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["reviewer", "observer"]),
                raw_readers: AccessRule::only(["reviewer"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new().set("email", json!("alice@example.com")),
                &BTreeSet::new(),
            )
            .unwrap();

        assert_eq!(
            bridge.node_input("reviewer").unwrap()["email"],
            json!("alice@example.com")
        );
        assert_eq!(
            bridge.node_input("observer").unwrap()["email"],
            json!("[EMAIL REDACTED]")
        );
        assert_eq!(
            bridge.agent_input("reviewer").unwrap()["email"],
            json!("[EMAIL REDACTED]")
        );
        assert_eq!(
            bridge
                .tool_args("reviewer", &json!({"email": "[EMAIL REDACTED]"}), &[])
                .unwrap(),
            json!({"email": "alice@example.com"})
        );
    }

    #[test]
    fn tool_args_restore_nested_same_path_without_exposing_siblings() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        bridge.configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["agent"]),
                raw_readers: AccessRule::only(["agent"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new().set(
                    "customer",
                    json!({"email": "alice@example.com", "phone": "13800138000"}),
                ),
                &BTreeSet::new(),
            )
            .unwrap();

        assert_eq!(
            bridge
                .tool_args("agent", &json!({"customer": {"email": "[EMAIL REDACTED]"}}), &[])
                .unwrap(),
            json!({"customer": {"email": "alice@example.com"}})
        );
    }

    #[test]
    fn explicit_tool_binding_maps_an_authorized_state_path() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        bridge.configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["agent", "observer"]),
                raw_readers: AccessRule::only(["agent"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new()
                    .set("customer", json!({"email": "alice@example.com"}))
                    .set("recipient", json!("fallback@example.com")),
                &BTreeSet::new(),
            )
            .unwrap();
        let bindings = [ToolStateBinding {
            tool_id: "send-email".to_string(),
            argument_path: "recipient".to_string(),
            state_path: "customer.email".to_string(),
        }];

        assert_eq!(
            bridge
                .tool_args("agent", &json!({"recipient": "[EMAIL REDACTED]"}), &bindings)
                .unwrap(),
            json!({"recipient": "alice@example.com"})
        );
        assert_eq!(
            bridge
                .tool_args("observer", &json!({"recipient": "[EMAIL REDACTED]"}), &bindings)
                .unwrap(),
            json!({"recipient": "[EMAIL REDACTED]"})
        );
    }

    #[test]
    fn raw_readers_follow_owner_values_published_to_global_state() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        bridge.configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["route", "observer"]),
                raw_readers: AccessRule::only(["route"]),
                ..Default::default()
            },
        );
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new().set("email", json!("alice@example.com")),
                &BTreeSet::from(["email".to_string()]),
            )
            .unwrap();

        assert_eq!(bridge.node_input("route").unwrap()["email"], json!("alice@example.com"));
        assert_eq!(
            bridge.node_input("observer").unwrap()["email"],
            json!("[EMAIL REDACTED]")
        );
        assert_eq!(bridge.agent_input("route").unwrap()["email"], json!("[EMAIL REDACTED]"));
    }

    #[test]
    fn input_raw_readers_apply_to_nodes_and_tools_but_not_agent_prompts() {
        let mut bridge = WorkflowStateBridge::from_initial_state_with_policy(
            json!({"apiKey": "sk-1234567890abcdefghijkl"}),
            BTreeSet::from(["worker".to_string()]),
            BTreeSet::from(["apiKey".to_string()]),
        )
        .unwrap();

        assert_eq!(
            bridge.node_input("worker").unwrap()["apiKey"],
            json!("sk-1234567890abcdefghijkl")
        );
        assert_eq!(
            bridge.agent_input("worker").unwrap()["apiKey"],
            json!("[SENSITIVE REDACTED]")
        );
        assert_eq!(
            bridge.node_input("other").unwrap()["apiKey"],
            json!("[SENSITIVE REDACTED]")
        );
    }

    #[test]
    fn rejects_non_object_initial_state() {
        assert!(WorkflowStateBridge::from_initial_state(json!("hello")).is_err());
    }

    #[test]
    fn node_updates_are_private_unless_the_dsl_allowlists_a_global_key() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        let global_updates = bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new()
                    .set("summary", json!("public"))
                    .set("raw", json!("private")),
                &BTreeSet::from(["summary".to_string()]),
            )
            .unwrap();

        assert_eq!(
            global_updates,
            HashMap::from([("summary".to_string(), json!("public"))])
        );
        assert_eq!(bridge.public_output(), json!({"summary": "public"}));
        assert_eq!(
            bridge.node_state("extractor").get("raw").unwrap(),
            Some(&json!("private"))
        );
    }

    #[test]
    fn final_output_exposes_all_node_values_and_workflow_trace() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge
            .apply_node_update(
                "extractor",
                NodeStateUpdate::new().set("raw", json!("private during execution")),
                &BTreeSet::new(),
            )
            .unwrap();
        bridge.runtime_state().runtime_set("token", json!("hidden"));

        assert_eq!(
            bridge.final_output(&HashMap::from([(
                "workflow.trace".to_string(),
                json!([{"nodeId": "extractor"}])
            )])),
            json!({
                "global": {"prompt": "hello"},
                "nodes": {"extractor": {"raw": "private during execution"}},
                "workflow": {"workflow.trace": [{"nodeId": "extractor"}]},
            })
        );
    }

    #[tokio::test]
    async fn checkpoint_restores_private_and_runtime_state_without_exposing_it_to_the_graph() {
        let bridge = Arc::new(Mutex::new(
            WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap(),
        ));
        {
            let mut bridge = bridge.lock().unwrap();
            bridge
                .node_state("extractor")
                .create("draft", json!("private"))
                .unwrap();
            bridge.runtime_state().runtime_set("approval", json!("secret"));
        }
        let checkpointer = WorkflowStateCheckpointer::new(
            Arc::new(MemoryCheckpointer::new()),
            Arc::clone(&bridge),
            "workflow-1",
            "fingerprint-1",
        )
        .unwrap();
        let checkpoint = Checkpoint::new(
            "thread-1",
            HashMap::from([("global".to_string(), json!({"prompt": "hello"}))]),
            2,
            vec!["review".to_string()],
        );
        checkpointer.save(&checkpoint).await.unwrap();

        *bridge.lock().unwrap() = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        let restored_graph = checkpointer.load("thread-1").await.unwrap().unwrap();

        assert_eq!(
            restored_graph.state,
            HashMap::from([("global".to_string(), json!({"prompt": "hello"}))])
        );
        let mut restored = bridge.lock().unwrap();
        assert_eq!(
            restored.node_state("extractor").get("draft").unwrap(),
            Some(&json!("private"))
        );
        assert_eq!(restored.runtime_state().runtime_get("approval"), Some(&json!("secret")));
    }

    #[tokio::test]
    async fn checkpoint_persists_raw_state_only_as_ciphertext() {
        let bridge = Arc::new(Mutex::new(
            WorkflowStateBridge::from_initial_state(json!({"email": "alice@example.com"})).unwrap(),
        ));
        let inner: Arc<dyn Checkpointer> = Arc::new(MemoryCheckpointer::new());
        let checkpointer =
            WorkflowStateCheckpointer::new(Arc::clone(&inner), Arc::clone(&bridge), "workflow-1", "fingerprint-1")
                .unwrap();
        checkpointer
            .save(&Checkpoint::new("thread-1", GraphState::new(), 0, vec![]))
            .await
            .unwrap();

        let stored = inner.load("thread-1").await.unwrap().unwrap();
        let metadata = stored.metadata.get(STATE_CHECKPOINT_METADATA_KEY).unwrap();
        assert!(!metadata.to_string().contains("alice@example.com"));
        assert_eq!(metadata["visibleState"]["global"]["email"], json!("[EMAIL REDACTED]"));

        *bridge.lock().unwrap() = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        checkpointer.load("thread-1").await.unwrap();
        assert_eq!(
            bridge.lock().unwrap().raw_state.runtime().global_get("email"),
            Some(&json!("alice@example.com"))
        );
    }

    #[tokio::test]
    async fn checkpoint_fails_closed_when_its_workflow_identity_differs() {
        let bridge = Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap()));
        let inner: Arc<dyn Checkpointer> = Arc::new(MemoryCheckpointer::new());
        let writer =
            WorkflowStateCheckpointer::new(Arc::clone(&inner), Arc::clone(&bridge), "workflow-1", "fingerprint-1")
                .unwrap();
        writer
            .save(&Checkpoint::new("thread-1", GraphState::new(), 0, vec![]))
            .await
            .unwrap();
        let reader = WorkflowStateCheckpointer::new(inner, bridge, "workflow-2", "fingerprint-1").unwrap();

        assert!(
            reader
                .load("thread-1")
                .await
                .unwrap_err()
                .to_string()
                .contains("does not match")
        );
    }

    #[tokio::test]
    async fn external_updates_keep_global_and_graph_checkpoint_in_sync() {
        let bridge = Arc::new(Mutex::new(
            WorkflowStateBridge::from_initial_state(json!({"draft": "old"})).unwrap(),
        ));
        let checkpointer = WorkflowStateCheckpointer::new(
            Arc::new(MemoryCheckpointer::new()),
            Arc::clone(&bridge),
            "workflow-1",
            "fingerprint-1",
        )
        .unwrap();
        checkpointer
            .save(&Checkpoint::new(
                "thread-1",
                GraphState::new(),
                1,
                vec!["review".to_string()],
            ))
            .await
            .unwrap();

        checkpointer
            .update_state(
                "thread-1",
                [
                    ("draft".to_string(), json!("edited")),
                    ("workflow.review.approved".to_string(), json!(true)),
                ],
            )
            .await
            .unwrap();

        let checkpoint = checkpointer.load("thread-1").await.unwrap().unwrap();
        assert_eq!(checkpoint.state.get("draft"), Some(&json!("edited")));
        assert_eq!(checkpoint.state.get("workflow.review.approved"), Some(&json!(true)));
        assert_eq!(bridge.lock().unwrap().public_output(), json!({"draft": "edited"}));
    }

    #[tokio::test]
    async fn external_updates_append_a_new_sqlite_checkpoint() {
        let bridge = Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap()));
        let inner: Arc<dyn Checkpointer> = Arc::new(SqliteCheckpointer::in_memory().await.unwrap());
        let checkpointer = WorkflowStateCheckpointer::new(inner, bridge, "workflow-1", "fingerprint-1").unwrap();

        checkpointer
            .save(&Checkpoint::new(
                "thread-1",
                GraphState::new(),
                1,
                vec!["question".to_string()],
            ))
            .await
            .unwrap();
        let first_id = checkpointer.load("thread-1").await.unwrap().unwrap().checkpoint_id;

        checkpointer
            .update_state("thread-1", [("workflow.answer".to_string(), json!("production"))])
            .await
            .unwrap();

        let checkpoints = checkpointer.list("thread-1").await.unwrap();
        assert_eq!(checkpoints.len(), 2);
        let latest = checkpointer.load("thread-1").await.unwrap().unwrap();
        assert_ne!(latest.checkpoint_id, first_id);
        assert_eq!(latest.state.get("workflow.answer"), Some(&json!("production")));
    }
}
