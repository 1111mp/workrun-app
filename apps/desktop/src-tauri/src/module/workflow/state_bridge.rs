//! Boundary between Workrun's access-controlled State and ADK's graph state.

use crate::module::state::{NodeState, RuntimeState, State as WorkrunState};
use adk_rust::{
    graph::checkpoint::RetentionPolicy,
    graph::{Checkpoint, Checkpointer, GraphError, Result as GraphResult, State as GraphState},
};
use anyhow::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

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

    /// ADK receives one structured public field, never node-private or runtime
    /// data. New routing expressions therefore address `global.<key>`.
    pub fn graph_state(&mut self) -> GraphState {
        HashMap::from([("global".to_string(), self.state.runtime().global_snapshot())])
    }

    /// JSON input for one untrusted node: public global values plus only the
    /// node-private entries authorized for this node.
    pub fn node_input(&mut self, node_id: impl Into<String>) -> Value {
        self.state.node(node_id).input_snapshot()
    }

    /// Give a workflow node its restricted State view.
    pub fn node_state(&mut self, node_id: impl Into<String>) -> NodeState<'_> {
        self.state.node(node_id)
    }

    /// Give trusted workflow infrastructure its full State view.
    pub fn runtime_state(&mut self) -> RuntimeState<'_> {
        self.state.runtime()
    }

    /// Public final output. This deliberately excludes node-private and
    /// runtime namespaces from Tauri responses.
    pub fn public_output(&mut self) -> Value {
        self.state.runtime().global_snapshot()
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
    use adk_rust::graph::MemoryCheckpointer;
    use serde_json::json;

    #[test]
    fn imports_initial_input_as_global_graph_state() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();

        assert_eq!(
            bridge.graph_state(),
            HashMap::from([("global".into(), json!({"prompt": "hello"}))])
        );
        assert_eq!(bridge.public_output(), json!({"prompt": "hello"}));
    }

    #[test]
    fn graph_state_excludes_private_and_runtime_data() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge
            .node_state("extractor")
            .create("draft", json!("private"), None)
            .unwrap();
        bridge.runtime_state().runtime_set("approval", json!("secret"));

        assert_eq!(
            bridge.graph_state(),
            HashMap::from([("global".into(), json!({"prompt": "hello"}))])
        );
    }

    #[test]
    fn node_input_projects_only_authorized_private_state() {
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({"prompt": "hello"})).unwrap();
        bridge
            .node_state("extractor")
            .create(
                "customer",
                json!({"id": 1}),
                Some(NodeStatePolicy {
                    readers: AccessRule::only(["extractor", "reviewer"]),
                    writers: AccessRule::only(["extractor"]),
                    policy_editors: AccessRule::only(["extractor"]),
                }),
            )
            .unwrap();

        assert_eq!(
            bridge.node_input("reviewer"),
            json!({
                "global": {"prompt": "hello"},
                "nodes": {"extractor": {"customer": {"id": 1}}},
            })
        );
        assert_eq!(
            bridge.node_input("other"),
            json!({"global": {"prompt": "hello"}, "nodes": {}})
        );
    }

    #[test]
    fn rejects_non_object_initial_state() {
        assert!(WorkflowStateBridge::from_initial_state(json!("hello")).is_err());
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
                .create("draft", json!("private"), None)
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
}
