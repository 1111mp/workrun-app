//! Boundary between Workrun's access-controlled State and ADK's graph state.

use crate::module::state::{NodeState, NodeStateUpdate, RuntimeState, State as WorkrunState, StateError};
use adk_rust::{
    graph::checkpoint::RetentionPolicy,
    graph::{Checkpoint, Checkpointer, GraphError, Result as GraphResult, State as GraphState},
};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

const STATE_CHECKPOINT_METADATA_KEY: &str = "workrun.workflow_state";
const STATE_CHECKPOINT_VERSION: u16 = 1;

/// Owns the access-controlled workflow state and exports only its public
/// `global` namespace to ADK's shared graph state.
pub struct WorkflowStateBridge {
    state: WorkrunState,
}

/// Private workflow state persisted alongside one ADK graph checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStateCheckpoint {
    version: u16,
    workflow_id: String,
    workflow_fingerprint: String,
    state: WorkrunState,
}

/// A checkpointer wrapper that atomically embeds Workrun State in ADK's
/// checkpoint metadata. The graph state itself remains public-only.
pub struct WorkflowStateCheckpointer {
    inner: Arc<dyn Checkpointer>,
    bridge: Arc<Mutex<WorkflowStateBridge>>,
    workflow_id: String,
    workflow_fingerprint: String,
}

impl WorkflowStateBridge {
    /// Import the run input into the public global namespace. The new workflow
    /// contract requires an object because every input field is a global key.
    pub fn from_initial_state(initial_state: Value) -> Result<Self> {
        let fields = initial_state
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("workflow initial state must be a JSON object"))?;
        let mut state = WorkrunState::new();
        let mut runtime = state.runtime();
        for (key, value) in fields {
            runtime.global_set(key.clone(), value.clone());
        }
        Ok(Self { state })
    }

    pub fn initialize_global(&mut self, initial_state: Value) -> Result<()> {
        let fields = initial_state
            .as_object()
            .ok_or_else(|| anyhow::anyhow!("workflow initial state must be a JSON object"))?;
        let mut runtime = self.state.runtime();
        for (key, value) in fields {
            runtime.global_set(key.clone(), value.clone());
        }
        Ok(())
    }

    /// ADK receives a flat copy of global state for routing and interrupts.
    /// Node-private and runtime data are never placed in graph state.
    pub fn graph_state(&mut self) -> GraphState {
        self.state
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
        self.state.node(node_id).input_snapshot()
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
        let global_values = update.global_values(global_keys);
        let patch = update.into_patch(node_id, global_keys);
        self.state.node(node_id).apply(&patch)?;
        Ok(global_values.into_iter().collect())
    }

    /// Give a workflow node its restricted State view.
    pub fn node_state(&mut self, node_id: impl Into<String>) -> NodeState<'_> {
        self.state.node(node_id)
    }

    /// Give trusted workflow infrastructure its full State view.
    pub fn runtime_state(&mut self) -> RuntimeState<'_> {
        self.state.runtime()
    }

    /// Global-only output for graph synchronization and narrow API consumers.
    pub fn public_output(&mut self) -> Value {
        self.state.runtime().global_snapshot()
    }

    /// Complete user-visible workflow output. Node ACLs apply only while a
    /// workflow executes; the final observer view includes every node value.
    /// Runtime state and policy details remain internal.
    pub fn final_output(&self, graph_state: &GraphState) -> Value {
        let mut output = self.state.workflow_snapshot();
        let workflow = graph_state
            .iter()
            .filter(|(key, _)| key.starts_with("workflow."))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<serde_json::Map<_, _>>();
        output["workflow"] = Value::Object(workflow);
        output
    }

    fn checkpoint(&self, workflow_id: &str, workflow_fingerprint: &str) -> WorkflowStateCheckpoint {
        WorkflowStateCheckpoint {
            version: STATE_CHECKPOINT_VERSION,
            workflow_id: workflow_id.to_string(),
            workflow_fingerprint: workflow_fingerprint.to_string(),
            state: self.state.clone(),
        }
    }

    fn from_checkpoint(checkpoint: WorkflowStateCheckpoint) -> Self {
        Self {
            state: checkpoint.state,
        }
    }
}

impl WorkflowStateCheckpointer {
    pub fn new(
        inner: Arc<dyn Checkpointer>,
        bridge: Arc<Mutex<WorkflowStateBridge>>,
        workflow_id: impl Into<String>,
        workflow_fingerprint: impl Into<String>,
    ) -> Self {
        Self {
            inner,
            bridge,
            workflow_id: workflow_id.into(),
            workflow_fingerprint: workflow_fingerprint.into(),
        }
    }

    fn checkpoint_metadata(&self) -> GraphResult<Value> {
        let bridge = self
            .bridge
            .lock()
            .map_err(|_| GraphError::CheckpointError("workflow state lock is poisoned".to_string()))?;
        serde_json::to_value(bridge.checkpoint(&self.workflow_id, &self.workflow_fingerprint))
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
        *bridge = WorkflowStateBridge::from_checkpoint(saved);
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
        {
            let mut bridge = self
                .bridge
                .lock()
                .map_err(|_| GraphError::CheckpointError("workflow state lock is poisoned".to_string()))?;
            let mut runtime = bridge.runtime_state();
            for (key, value) in &updates {
                if !key.starts_with("workflow.") {
                    runtime.global_set(key.clone(), value.clone());
                }
            }
        }
        for (key, value) in updates {
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
        bridge.runtime_state().configure_node(
            "extractor",
            NodeStatePolicy {
                readers: AccessRule::only(["reviewer"]),
                ..Default::default()
            },
        );
        bridge
            .node_state("extractor")
            .create("customer", json!({"id": 1}))
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
        );
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
    async fn checkpoint_fails_closed_when_its_workflow_identity_differs() {
        let bridge = Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({})).unwrap()));
        let inner: Arc<dyn Checkpointer> = Arc::new(MemoryCheckpointer::new());
        let writer =
            WorkflowStateCheckpointer::new(Arc::clone(&inner), Arc::clone(&bridge), "workflow-1", "fingerprint-1");
        writer
            .save(&Checkpoint::new("thread-1", GraphState::new(), 0, vec![]))
            .await
            .unwrap();
        let reader = WorkflowStateCheckpointer::new(inner, bridge, "workflow-2", "fingerprint-1");

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
        );
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
        let checkpointer = WorkflowStateCheckpointer::new(inner, bridge, "workflow-1", "fingerprint-1");

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
