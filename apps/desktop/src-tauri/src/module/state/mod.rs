//! Workflow-independent state with public, node-private, and runtime-private
//! namespaces.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "node_ids")]
pub enum AccessRule {
    Any,
    Only(BTreeSet<String>),
}

impl AccessRule {
    pub fn only(node_ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Only(node_ids.into_iter().map(Into::into).collect())
    }

    fn allows(&self, node_id: &str) -> bool {
        matches!(self, Self::Any) || matches!(self, Self::Only(ids) if ids.contains(node_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatePolicy {
    pub readers: AccessRule,
    pub writers: AccessRule,
    pub policy_editors: AccessRule,
}

impl NodeStatePolicy {
    pub fn private_to(node_id: impl Into<String>) -> Self {
        let node_id = node_id.into();
        Self {
            readers: AccessRule::only([node_id.clone()]),
            writers: AccessRule::only([node_id.clone()]),
            policy_editors: AccessRule::only([node_id]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeStateEntry {
    value: Value,
    policy: NodeStatePolicy,
}

/// State storage. `global` is intentionally public and mutable to every node;
/// sensitive data belongs in a node-private entry or the runtime namespace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    global: BTreeMap<String, Value>,
    nodes: BTreeMap<String, BTreeMap<String, NodeStateEntry>>,
    runtime: BTreeMap<String, Value>,
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bind state access to one workflow node.
    pub fn node(&mut self, node_id: impl Into<String>) -> NodeState<'_> {
        NodeState {
            state: self,
            node_id: node_id.into(),
        }
    }

    /// Create the trusted view used by workflow infrastructure.
    pub fn runtime(&mut self) -> RuntimeState<'_> {
        RuntimeState { state: self }
    }

    fn apply_patch(&mut self, actor: Actor<'_>, patch: &StatePatch) -> Result<(), StateError> {
        // A node result often writes more than one key. Work on a clone so a
        // denied later operation never leaves an earlier one applied.
        let mut candidate = self.clone();
        for operation in &patch.operations {
            candidate.apply_operation(actor, operation)?;
        }
        *self = candidate;
        Ok(())
    }

    fn apply_operation(&mut self, actor: Actor<'_>, operation: &StateOperation) -> Result<(), StateError> {
        match operation {
            StateOperation::GlobalSet { key, value } => {
                self.global.insert(key.clone(), value.clone());
                Ok(())
            },
            StateOperation::GlobalRemove { key } => {
                self.global.remove(key);
                Ok(())
            },
            StateOperation::NodeSet { node_id, key, value } => self.node_set(actor, node_id, key, value.clone()),
            StateOperation::NodeCreate {
                node_id,
                key,
                value,
                policy,
            } => self.node_create(actor, node_id, key.clone(), value.clone(), policy.clone()),
            StateOperation::NodeRemove { node_id, key } => self.node_remove(actor, node_id, key),
            StateOperation::NodeUpdatePolicy { node_id, key, policy } => {
                self.node_update_policy(actor, node_id, key, policy.clone())
            },
        }
    }

    fn node_get(&self, actor: Actor<'_>, node_id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        let Some(entry) = self.nodes.get(node_id).and_then(|entries| entries.get(key)) else {
            return Ok(None);
        };
        Self::require(actor, node_id, key, StateAction::Read, &entry.policy.readers)?;
        Ok(Some(&entry.value))
    }

    fn node_set(&mut self, actor: Actor<'_>, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        let entry = self
            .nodes
            .get_mut(node_id)
            .and_then(|entries| entries.get_mut(key))
            .ok_or_else(|| StateError::NotFound {
                node_id: node_id.to_string(),
                key: key.to_string(),
            })?;
        Self::require(actor, node_id, key, StateAction::Write, &entry.policy.writers)?;
        entry.value = value;
        Ok(())
    }

    fn node_create(
        &mut self,
        actor: Actor<'_>,
        node_id: &str,
        key: String,
        value: Value,
        policy: Option<NodeStatePolicy>,
    ) -> Result<(), StateError> {
        if let Actor::Node(actor_id) = actor
            && actor_id != node_id
        {
            return Err(StateError::CreateDenied {
                actor: actor_id.to_string(),
                node_id: node_id.to_string(),
            });
        }
        let entries = self.nodes.entry(node_id.to_string()).or_default();
        if entries.contains_key(&key) {
            return Err(StateError::AlreadyExists {
                node_id: node_id.to_string(),
                key,
            });
        }
        entries.insert(
            key,
            NodeStateEntry {
                value,
                policy: policy.unwrap_or_else(|| NodeStatePolicy::private_to(node_id)),
            },
        );
        Ok(())
    }

    fn node_update_policy(
        &mut self,
        actor: Actor<'_>,
        node_id: &str,
        key: &str,
        policy: NodeStatePolicy,
    ) -> Result<(), StateError> {
        let entry = self
            .nodes
            .get_mut(node_id)
            .and_then(|entries| entries.get_mut(key))
            .ok_or_else(|| StateError::NotFound {
                node_id: node_id.to_string(),
                key: key.to_string(),
            })?;
        Self::require(
            actor,
            node_id,
            key,
            StateAction::EditPolicy,
            &entry.policy.policy_editors,
        )?;
        entry.policy = policy;
        Ok(())
    }

    fn node_remove(&mut self, actor: Actor<'_>, node_id: &str, key: &str) -> Result<(), StateError> {
        let entries = self.nodes.get_mut(node_id).ok_or_else(|| StateError::NotFound {
            node_id: node_id.to_string(),
            key: key.to_string(),
        })?;
        let entry = entries.get(key).ok_or_else(|| StateError::NotFound {
            node_id: node_id.to_string(),
            key: key.to_string(),
        })?;
        Self::require(actor, node_id, key, StateAction::Delete, &entry.policy.writers)?;
        entries.remove(key);
        if entries.is_empty() {
            self.nodes.remove(node_id);
        }
        Ok(())
    }

    fn require(
        actor: Actor<'_>,
        node_id: &str,
        key: &str,
        action: StateAction,
        rule: &AccessRule,
    ) -> Result<(), StateError> {
        if matches!(actor, Actor::Runtime) || matches!(actor, Actor::Node(id) if rule.allows(id)) {
            Ok(())
        } else {
            Err(StateError::Denied {
                actor: actor.name().to_string(),
                node_id: node_id.to_string(),
                key: key.to_string(),
                action,
            })
        }
    }

    fn global_snapshot(&self) -> Value {
        Value::Object(self.global.clone().into_iter().collect())
    }

    fn node_input_snapshot(&self, requester: &str) -> Value {
        let nodes = self
            .nodes
            .iter()
            .filter_map(|(owner, entries)| {
                let visible = entries
                    .iter()
                    .filter(|(_, entry)| entry.policy.readers.allows(requester))
                    .map(|(key, entry)| (key.clone(), entry.value.clone()))
                    .collect::<serde_json::Map<_, _>>();
                (!visible.is_empty()).then_some((owner.clone(), Value::Object(visible)))
            })
            .collect();
        serde_json::json!({
            "global": self.global_snapshot(),
            "nodes": Value::Object(nodes),
        })
    }
}

/// An explicit set of writes produced by a workflow node. Applying a patch is
/// atomic: if any operation is denied, no operation in the patch is committed.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatePatch {
    operations: Vec<StateOperation>,
}

impl StatePatch {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.operations.is_empty()
    }

    pub fn global_set(mut self, key: impl Into<String>, value: Value) -> Self {
        self.operations
            .push(StateOperation::GlobalSet { key: key.into(), value });
        self
    }

    pub fn global_remove(mut self, key: impl Into<String>) -> Self {
        self.operations.push(StateOperation::GlobalRemove { key: key.into() });
        self
    }

    pub fn node_set(mut self, node_id: impl Into<String>, key: impl Into<String>, value: Value) -> Self {
        self.operations.push(StateOperation::NodeSet {
            node_id: node_id.into(),
            key: key.into(),
            value,
        });
        self
    }

    pub fn node_create(
        mut self,
        node_id: impl Into<String>,
        key: impl Into<String>,
        value: Value,
        policy: Option<NodeStatePolicy>,
    ) -> Self {
        self.operations.push(StateOperation::NodeCreate {
            node_id: node_id.into(),
            key: key.into(),
            value,
            policy,
        });
        self
    }

    pub fn node_remove(mut self, node_id: impl Into<String>, key: impl Into<String>) -> Self {
        self.operations.push(StateOperation::NodeRemove {
            node_id: node_id.into(),
            key: key.into(),
        });
        self
    }

    pub fn node_update_policy(
        mut self,
        node_id: impl Into<String>,
        key: impl Into<String>,
        policy: NodeStatePolicy,
    ) -> Self {
        self.operations.push(StateOperation::NodeUpdatePolicy {
            node_id: node_id.into(),
            key: key.into(),
            policy,
        });
        self
    }
}

/// One intended state mutation within a [`StatePatch`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum StateOperation {
    GlobalSet {
        key: String,
        value: Value,
    },
    GlobalRemove {
        key: String,
    },
    NodeSet {
        node_id: String,
        key: String,
        value: Value,
    },
    NodeCreate {
        node_id: String,
        key: String,
        value: Value,
        policy: Option<NodeStatePolicy>,
    },
    NodeRemove {
        node_id: String,
        key: String,
    },
    NodeUpdatePolicy {
        node_id: String,
        key: String,
        policy: NodeStatePolicy,
    },
}

/// State API bound to one node identity. It intentionally has no runtime accessors.
pub struct NodeState<'a> {
    state: &'a mut State,
    node_id: String,
}

impl NodeState<'_> {
    pub fn global_get(&self, key: &str) -> Option<&Value> {
        self.state.global.get(key)
    }

    pub fn global_set(&mut self, key: impl Into<String>, value: Value) {
        self.state.global.insert(key.into(), value);
    }

    pub fn get(&self, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Node(&self.node_id), &self.node_id, key)
    }

    pub fn set(&mut self, key: &str, value: Value) -> Result<(), StateError> {
        self.state
            .node_set(Actor::Node(&self.node_id), &self.node_id, key, value)
    }

    pub fn create(
        &mut self,
        key: impl Into<String>,
        value: Value,
        policy: Option<NodeStatePolicy>,
    ) -> Result<(), StateError> {
        self.state
            .node_create(Actor::Node(&self.node_id), &self.node_id, key.into(), value, policy)
    }

    pub fn get_from(&self, node_id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Node(&self.node_id), node_id, key)
    }

    pub fn set_for(&mut self, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_set(Actor::Node(&self.node_id), node_id, key, value)
    }

    pub fn update_policy(&mut self, key: &str, policy: NodeStatePolicy) -> Result<(), StateError> {
        self.state
            .node_update_policy(Actor::Node(&self.node_id), &self.node_id, key, policy)
    }

    pub fn remove(&mut self, key: &str) -> Result<(), StateError> {
        self.state.node_remove(Actor::Node(&self.node_id), &self.node_id, key)
    }

    /// Apply a node result after validating every requested operation against
    /// this node's access rights.
    pub fn apply(&mut self, patch: &StatePatch) -> Result<(), StateError> {
        self.state.apply_patch(Actor::Node(&self.node_id), patch)
    }

    /// Export the public global namespace and every node entry this node may read.
    pub fn input_snapshot(&self) -> Value {
        self.state.node_input_snapshot(&self.node_id)
    }
}

/// Trusted State API for workflow infrastructure.
pub struct RuntimeState<'a> {
    state: &'a mut State,
}

impl RuntimeState<'_> {
    pub fn global_snapshot(&self) -> Value {
        self.state.global_snapshot()
    }

    pub fn global_get(&self, key: &str) -> Option<&Value> {
        self.state.global.get(key)
    }

    pub fn global_set(&mut self, key: impl Into<String>, value: Value) {
        self.state.global.insert(key.into(), value);
    }

    pub fn global_remove(&mut self, key: &str) -> Option<Value> {
        self.state.global.remove(key)
    }

    pub fn runtime_get(&self, key: &str) -> Option<&Value> {
        self.state.runtime.get(key)
    }

    pub fn runtime_set(&mut self, key: impl Into<String>, value: Value) {
        self.state.runtime.insert(key.into(), value);
    }

    pub fn runtime_remove(&mut self, key: &str) -> Option<Value> {
        self.state.runtime.remove(key)
    }

    pub fn node_get(&self, node_id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Runtime, node_id, key)
    }

    pub fn node_set(&mut self, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_set(Actor::Runtime, node_id, key, value)
    }

    pub fn node_create(
        &mut self,
        node_id: &str,
        key: impl Into<String>,
        value: Value,
        policy: Option<NodeStatePolicy>,
    ) -> Result<(), StateError> {
        self.state
            .node_create(Actor::Runtime, node_id, key.into(), value, policy)
    }

    pub fn node_update_policy(&mut self, node_id: &str, key: &str, policy: NodeStatePolicy) -> Result<(), StateError> {
        self.state.node_update_policy(Actor::Runtime, node_id, key, policy)
    }

    pub fn node_remove(&mut self, node_id: &str, key: &str) -> Result<(), StateError> {
        self.state.node_remove(Actor::Runtime, node_id, key)
    }

    /// Apply trusted infrastructure changes atomically. Runtime-only keys are
    /// deliberately absent from StatePatch so node output can never address
    /// them.
    pub fn apply(&mut self, patch: &StatePatch) -> Result<(), StateError> {
        self.state.apply_patch(Actor::Runtime, patch)
    }
}

#[derive(Debug, Clone, Copy)]
enum Actor<'a> {
    Runtime,
    Node(&'a str),
}

impl<'a> Actor<'a> {
    fn name(self) -> &'a str {
        match self {
            Self::Runtime => "runtime",
            Self::Node(id) => id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StateAction {
    Read,
    Write,
    Delete,
    EditPolicy,
}

impl std::fmt::Display for StateAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => write!(formatter, "read"),
            Self::Write => write!(formatter, "write"),
            Self::Delete => write!(formatter, "delete"),
            Self::EditPolicy => write!(formatter, "edit policy for"),
        }
    }
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("{actor} may not create state in node `{node_id}`")]
    CreateDenied { actor: String, node_id: String },
    #[error("{actor} may not {action} node `{node_id}` state key `{key}`")]
    Denied {
        actor: String,
        node_id: String,
        key: String,
        action: StateAction,
    },
    #[error("node `{node_id}` state key `{key}` already exists")]
    AlreadyExists { node_id: String, key: String },
    #[error("node `{node_id}` state key `{key}` does not exist")]
    NotFound { node_id: String, key: String },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_node_can_read_and_write_global_state() {
        let mut state = State::new();
        state.node("writer").global_set("prompt", json!("hello"));
        assert_eq!(state.node("reader").global_get("prompt"), Some(&json!("hello")));
    }

    #[test]
    fn node_state_is_private_by_default() {
        let mut state = State::new();
        state.node("extractor").create("draft", json!("private"), None).unwrap();

        let mut owner = state.node("extractor");
        assert_eq!(owner.get("draft").unwrap(), Some(&json!("private")));
        owner.set("draft", json!("updated")).unwrap();
        assert_eq!(owner.get("draft").unwrap(), Some(&json!("updated")));
        drop(owner);

        let mut reviewer = state.node("reviewer");
        assert!(matches!(
            reviewer.get_from("extractor", "draft"),
            Err(StateError::Denied { .. })
        ));
        assert!(matches!(
            reviewer.set_for("extractor", "draft", json!("changed")),
            Err(StateError::Denied { .. })
        ));
    }

    #[test]
    fn policy_can_grant_a_specific_downstream_node_access() {
        let mut state = State::new();
        let policy = NodeStatePolicy {
            readers: AccessRule::only(["extractor", "reviewer"]),
            writers: AccessRule::only(["extractor"]),
            policy_editors: AccessRule::only(["extractor"]),
        };
        state
            .node("extractor")
            .create("customer", json!({"id": 1}), Some(policy))
            .unwrap();

        let mut reviewer = state.node("reviewer");
        assert_eq!(
            reviewer.get_from("extractor", "customer").unwrap(),
            Some(&json!({"id": 1}))
        );
        assert!(matches!(
            reviewer.set_for("extractor", "customer", json!({"id": 2})),
            Err(StateError::Denied { .. })
        ));
    }

    #[test]
    fn only_policy_editors_can_change_a_policy() {
        let mut state = State::new();
        state.node("owner").create("value", json!(1), None).unwrap();
        assert!(matches!(
            state.node("other").get_from("owner", "value"),
            Err(StateError::Denied {
                action: StateAction::Read,
                ..
            })
        ));
        state
            .runtime()
            .node_update_policy("owner", "value", NodeStatePolicy::private_to("owner"))
            .unwrap();
    }

    #[test]
    fn runtime_can_access_every_namespace() {
        let mut state = State::new();
        state.node("agent").create("secret", json!(true), None).unwrap();
        let mut runtime = state.runtime();
        runtime.global_set("input", json!("hi"));
        runtime.runtime_set("approval-token", json!("secret"));
        assert_eq!(runtime.global_get("input"), Some(&json!("hi")));
        assert_eq!(runtime.runtime_get("approval-token"), Some(&json!("secret")));
        assert_eq!(runtime.node_get("agent", "secret").unwrap(), Some(&json!(true)));
    }

    #[test]
    fn state_round_trips_with_its_policies() {
        let mut state = State::new();
        state.node("writer").global_set("input", json!("hi"));
        state
            .runtime()
            .node_create(
                "agent",
                "secret",
                json!(true),
                Some(NodeStatePolicy::private_to("agent")),
            )
            .unwrap();

        let serialized = serde_json::to_value(&state).unwrap();
        let mut restored: State = serde_json::from_value(serialized).unwrap();
        assert_eq!(restored.node("agent").get("secret").unwrap(), Some(&json!(true)));
    }

    #[test]
    fn a_patch_commits_all_authorized_node_output() {
        let mut state = State::new();
        let patch = StatePatch::new().global_set("status", json!("ready")).node_create(
            "writer",
            "draft",
            json!("private"),
            None,
        );

        state.node("writer").apply(&patch).unwrap();

        assert_eq!(state.node("reader").global_get("status"), Some(&json!("ready")));
        assert_eq!(state.node("writer").get("draft").unwrap(), Some(&json!("private")));
    }

    #[test]
    fn a_denied_patch_does_not_commit_any_earlier_operation() {
        let mut state = State::new();
        state.node("owner").create("secret", json!(1), None).unwrap();
        let patch = StatePatch::new()
            .global_set("status", json!("should-not-appear"))
            .node_set("owner", "secret", json!(2));

        assert!(matches!(
            state.node("other").apply(&patch),
            Err(StateError::Denied { .. })
        ));
        assert_eq!(state.node("reader").global_get("status"), None);
        assert_eq!(state.node("owner").get("secret").unwrap(), Some(&json!(1)));
    }

    #[test]
    fn a_writer_can_remove_a_private_key() {
        let mut state = State::new();
        state.node("owner").create("draft", json!("temporary"), None).unwrap();

        state
            .node("owner")
            .apply(&StatePatch::new().node_remove("owner", "draft"))
            .unwrap();

        assert_eq!(state.node("owner").get("draft").unwrap(), None);
    }

    #[test]
    fn patches_round_trip_for_persistence_or_transport() {
        let patch = StatePatch::new().global_set("status", json!("ready")).node_create(
            "writer",
            "draft",
            json!("private"),
            None,
        );

        let restored: StatePatch = serde_json::from_value(serde_json::to_value(patch).unwrap()).unwrap();
        assert_eq!(restored.operations.len(), 2);
    }
}
