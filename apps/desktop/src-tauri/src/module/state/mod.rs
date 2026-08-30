//! Access-controlled workflow state. Policy belongs to a whole node namespace.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use thiserror::Error;

/// Rules grant access in addition to the namespace owner. Ownership is
/// derived from the namespace id and is never recorded here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "node_ids")]
pub enum AccessRule {
    Any,
    Only(BTreeSet<String>),
}

impl AccessRule {
    pub fn only(ids: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self::Only(ids.into_iter().map(Into::into).collect())
    }
    fn allows(&self, id: &str) -> bool {
        matches!(self, Self::Any) || matches!(self, Self::Only(ids) if ids.contains(id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeStatePolicy {
    pub readers: AccessRule,
    pub writers: AccessRule,
    pub policy_editors: AccessRule,
}

impl Default for NodeStatePolicy {
    fn default() -> Self {
        Self {
            readers: AccessRule::only([] as [&str; 0]),
            writers: AccessRule::only([] as [&str; 0]),
            policy_editors: AccessRule::only([] as [&str; 0]),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NodeNamespace {
    policy: NodeStatePolicy,
    values: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct State {
    global: BTreeMap<String, Value>,
    nodes: BTreeMap<String, NodeNamespace>,
    runtime: BTreeMap<String, Value>,
}

impl State {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn node(&mut self, id: impl Into<String>) -> NodeState<'_> {
        NodeState {
            state: self,
            id: id.into(),
        }
    }
    pub fn runtime(&mut self) -> RuntimeState<'_> {
        RuntimeState { state: self }
    }

    fn configure_node(&mut self, id: &str, policy: NodeStatePolicy) {
        self.nodes.entry(id.to_string()).or_insert(NodeNamespace {
            policy,
            values: BTreeMap::new(),
        });
    }

    fn node_get(&self, actor: Actor<'_>, id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        let Some(space) = self.nodes.get(id) else {
            return Ok(None);
        };
        Self::require(actor, id, StateAction::Read, &space.policy.readers)?;
        Ok(space.values.get(key))
    }

    fn node_set(&mut self, actor: Actor<'_>, id: &str, key: &str, value: Value) -> Result<(), StateError> {
        if !self.nodes.contains_key(id) {
            match actor {
                Actor::Runtime => self.configure_node(id, NodeStatePolicy::default()),
                Actor::Node(actor_id) if actor_id == id => self.configure_node(id, NodeStatePolicy::default()),
                Actor::Node(actor_id) => {
                    return Err(StateError::NamespaceNotFound {
                        actor: actor_id.to_string(),
                        node_id: id.to_string(),
                    });
                },
            }
        }
        let space = self.nodes.get_mut(id).expect("namespace was created");
        Self::require(actor, id, StateAction::Write, &space.policy.writers)?;
        space.values.insert(key.to_string(), value);
        Ok(())
    }

    fn node_create(&mut self, actor: Actor<'_>, id: &str, key: &str, value: Value) -> Result<(), StateError> {
        if self.nodes.get(id).is_some_and(|space| space.values.contains_key(key)) {
            return Err(StateError::AlreadyExists {
                node_id: id.to_string(),
                key: key.to_string(),
            });
        }
        self.node_set(actor, id, key, value)
    }

    fn node_update_policy(&mut self, actor: Actor<'_>, id: &str, policy: NodeStatePolicy) -> Result<(), StateError> {
        let space = self.nodes.get_mut(id).ok_or_else(|| StateError::NamespaceNotFound {
            actor: actor.name().to_string(),
            node_id: id.to_string(),
        })?;
        Self::require(actor, id, StateAction::EditPolicy, &space.policy.policy_editors)?;
        space.policy = policy;
        Ok(())
    }

    fn node_remove(&mut self, actor: Actor<'_>, id: &str, key: &str) -> Result<(), StateError> {
        let space = self.nodes.get_mut(id).ok_or_else(|| StateError::NamespaceNotFound {
            actor: actor.name().to_string(),
            node_id: id.to_string(),
        })?;
        Self::require(actor, id, StateAction::Delete, &space.policy.writers)?;
        if space.values.remove(key).is_none() {
            return Err(StateError::NotFound {
                node_id: id.to_string(),
                key: key.to_string(),
            });
        }
        Ok(())
    }

    fn require(actor: Actor<'_>, id: &str, action: StateAction, rule: &AccessRule) -> Result<(), StateError> {
        if matches!(actor, Actor::Runtime)
            || matches!(actor, Actor::Node(actor_id) if actor_id == id || rule.allows(actor_id))
        {
            Ok(())
        } else {
            Err(StateError::Denied {
                actor: actor.name().to_string(),
                node_id: id.to_string(),
                action,
            })
        }
    }

    fn apply(&mut self, actor: Actor<'_>, patch: &StatePatch) -> Result<(), StateError> {
        let mut next = self.clone();
        for operation in &patch.operations {
            next.apply_operation(actor, operation)?;
        }
        *self = next;
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
            StateOperation::NodeRemove { node_id, key } => self.node_remove(actor, node_id, key),
        }
    }

    fn global_snapshot(&self) -> Value {
        Value::Object(self.global.clone().into_iter().collect())
    }

    /// Build the complete user-visible workflow result. This is an observer
    /// view, not a node execution view: all node namespaces are included while
    /// runtime-only data and access policies remain internal.
    pub fn workflow_snapshot(&self) -> Value {
        let nodes = self
            .nodes
            .iter()
            .map(|(id, namespace)| {
                (
                    id.clone(),
                    Value::Object(namespace.values.clone().into_iter().collect()),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        serde_json::json!({
            "global": self.global_snapshot(),
            "nodes": nodes,
        })
    }

    /// Build the value passed to a node as a flat JSON object. Namespace
    /// boundaries stay internal; ambiguous keys fail instead of silently
    /// choosing a source.
    fn input_snapshot(&self, requester: &str) -> Result<Value, StateError> {
        let mut input = self.global.clone();
        let mut sources = self
            .global
            .keys()
            .map(|key| (key.clone(), "global".to_string()))
            .collect::<BTreeMap<_, _>>();
        for (owner, space) in &self.nodes {
            if owner != requester && !space.policy.readers.allows(requester) {
                continue;
            }
            let source = format!("node.{owner}");
            for (key, value) in &space.values {
                if let Some(first_source) = sources.insert(key.clone(), source.clone()) {
                    return Err(StateError::InputKeyConflict {
                        key: key.clone(),
                        first_source,
                        second_source: source,
                    });
                }
                input.insert(key.clone(), value.clone());
            }
        }
        Ok(Value::Object(input.into_iter().collect()))
    }
}

/// Node-output writes. Policy is intentionally not representable here.
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
    pub fn node_remove(mut self, node_id: impl Into<String>, key: impl Into<String>) -> Self {
        self.operations.push(StateOperation::NodeRemove {
            node_id: node_id.into(),
            key: key.into(),
        });
        self
    }
}

/// Raw values emitted by a node. The workflow decides which configured keys
/// are public; every other value is written to the emitting node's namespace.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeStateUpdate(BTreeMap<String, Value>);

impl NodeStateUpdate {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(mut self, key: impl Into<String>, value: Value) -> Self {
        self.0.insert(key.into(), value);
        self
    }

    pub fn from_object(value: serde_json::Map<String, Value>) -> Self {
        Self(value.into_iter().collect())
    }

    /// Values that must also be visible to graph-level routing after this node
    /// publishes them to the global namespace.
    pub fn global_values(&self, global_keys: &BTreeSet<String>) -> BTreeMap<String, Value> {
        self.0
            .iter()
            .filter(|(key, _)| global_keys.contains(*key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }

    pub fn into_patch(self, node_id: &str, global_keys: &BTreeSet<String>) -> StatePatch {
        self.0.into_iter().fold(StatePatch::new(), |patch, (key, value)| {
            if global_keys.contains(&key) {
                patch.global_set(key, value)
            } else {
                patch.node_set(node_id, key, value)
            }
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum StateOperation {
    GlobalSet { key: String, value: Value },
    GlobalRemove { key: String },
    NodeSet { node_id: String, key: String, value: Value },
    NodeRemove { node_id: String, key: String },
}

pub struct NodeState<'a> {
    state: &'a mut State,
    id: String,
}

impl NodeState<'_> {
    pub fn global_get(&self, key: &str) -> Option<&Value> {
        self.state.global.get(key)
    }
    pub fn global_set(&mut self, key: impl Into<String>, value: Value) {
        self.state.global.insert(key.into(), value);
    }
    pub fn global_remove(&mut self, key: &str) -> Option<Value> {
        self.state.global.remove(key)
    }
    pub fn get(&self, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Node(&self.id), &self.id, key)
    }
    /// Upsert any key in this node's namespace.
    pub fn set(&mut self, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_set(Actor::Node(&self.id), &self.id, key, value)
    }
    pub fn create(&mut self, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_create(Actor::Node(&self.id), &self.id, key, value)
    }
    pub fn get_from(&self, node_id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Node(&self.id), node_id, key)
    }
    pub fn set_for(&mut self, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_set(Actor::Node(&self.id), node_id, key, value)
    }
    pub fn update_policy(&mut self, policy: NodeStatePolicy) -> Result<(), StateError> {
        self.state.node_update_policy(Actor::Node(&self.id), &self.id, policy)
    }
    pub fn remove(&mut self, key: &str) -> Result<(), StateError> {
        self.state.node_remove(Actor::Node(&self.id), &self.id, key)
    }
    pub fn apply(&mut self, patch: &StatePatch) -> Result<(), StateError> {
        self.state.apply(Actor::Node(&self.id), patch)
    }
    pub fn input_snapshot(&self) -> Result<Value, StateError> {
        self.state.input_snapshot(&self.id)
    }
}

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
    pub fn configure_node(&mut self, node_id: &str, policy: NodeStatePolicy) {
        self.state.configure_node(node_id, policy)
    }
    pub fn node_get(&self, node_id: &str, key: &str) -> Result<Option<&Value>, StateError> {
        self.state.node_get(Actor::Runtime, node_id, key)
    }
    pub fn node_set(&mut self, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_set(Actor::Runtime, node_id, key, value)
    }
    pub fn node_create(&mut self, node_id: &str, key: &str, value: Value) -> Result<(), StateError> {
        self.state.node_create(Actor::Runtime, node_id, key, value)
    }
    pub fn node_update_policy(&mut self, node_id: &str, policy: NodeStatePolicy) -> Result<(), StateError> {
        self.state.node_update_policy(Actor::Runtime, node_id, policy)
    }
    pub fn node_remove(&mut self, node_id: &str, key: &str) -> Result<(), StateError> {
        self.state.node_remove(Actor::Runtime, node_id, key)
    }
    pub fn apply(&mut self, patch: &StatePatch) -> Result<(), StateError> {
        self.state.apply(Actor::Runtime, patch)
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
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read => write!(f, "read"),
            Self::Write => write!(f, "write"),
            Self::Delete => write!(f, "delete"),
            Self::EditPolicy => write!(f, "edit policy for"),
        }
    }
}

#[derive(Debug, Error)]
pub enum StateError {
    #[error("{actor} may not {action} node `{node_id}` state")]
    Denied {
        actor: String,
        node_id: String,
        action: StateAction,
    },
    #[error("node `{node_id}` state key `{key}` already exists")]
    AlreadyExists { node_id: String, key: String },
    #[error("node `{node_id}` state key `{key}` does not exist")]
    NotFound { node_id: String, key: String },
    #[error("node `{node_id}` state does not exist")]
    NamespaceNotFound { actor: String, node_id: String },
    #[error("node input key `{key}` conflicts between `{first_source}` and `{second_source}`")]
    InputKeyConflict {
        key: String,
        first_source: String,
        second_source: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn shared() -> NodeStatePolicy {
        NodeStatePolicy {
            readers: AccessRule::only(["reviewer"]),
            ..Default::default()
        }
    }

    #[test]
    fn global_is_open() {
        let mut s = State::new();
        s.node("a").global_set("input", json!(1));
        assert_eq!(s.node("b").global_get("input"), Some(&json!(1)));
    }
    #[test]
    fn owner_can_upsert_arbitrary_keys() {
        let mut s = State::new();
        let mut a = s.node("a");
        a.set("first", json!(1)).unwrap();
        a.set("second", json!(2)).unwrap();
        a.set("first", json!(3)).unwrap();
        assert_eq!(a.get("first").unwrap(), Some(&json!(3)));
    }
    #[test]
    fn namespace_is_private_by_default() {
        let mut s = State::new();
        s.node("a").set("secret", json!(1)).unwrap();
        assert!(matches!(
            s.node("b").get_from("a", "secret"),
            Err(StateError::Denied {
                action: StateAction::Read,
                ..
            })
        ));
    }
    #[test]
    fn policy_applies_to_current_and_future_keys() {
        let mut s = State::new();
        s.runtime().configure_node("extractor", shared());
        s.node("extractor").set("first", json!(1)).unwrap();
        s.node("extractor").set("second", json!(2)).unwrap();
        let reviewer = s.node("reviewer");
        assert_eq!(reviewer.get_from("extractor", "first").unwrap(), Some(&json!(1)));
        assert_eq!(reviewer.get_from("extractor", "second").unwrap(), Some(&json!(2)));
    }
    #[test]
    fn writers_apply_to_all_keys() {
        let mut s = State::new();
        s.runtime().configure_node(
            "owner",
            NodeStatePolicy {
                readers: AccessRule::Any,
                writers: AccessRule::only(["editor"]),
                ..Default::default()
            },
        );
        s.node("editor").set_for("owner", "new", json!(true)).unwrap();
        assert_eq!(s.node("owner").get("new").unwrap(), Some(&json!(true)));
    }
    #[test]
    fn patch_is_atomic() {
        let mut s = State::new();
        s.node("owner").set("secret", json!(1)).unwrap();
        let patch = StatePatch::new()
            .global_set("status", json!("bad"))
            .node_set("owner", "secret", json!(2));
        assert!(s.node("other").apply(&patch).is_err());
        assert_eq!(s.node("reader").global_get("status"), None);
        assert_eq!(s.node("owner").get("secret").unwrap(), Some(&json!(1)));
    }
    #[test]
    fn patch_writes_arbitrary_owner_keys() {
        let mut s = State::new();
        s.node("writer")
            .apply(
                &StatePatch::new()
                    .node_set("writer", "draft", json!(1))
                    .node_set("writer", "meta", json!(2)),
            )
            .unwrap();
        assert_eq!(s.node("writer").get("meta").unwrap(), Some(&json!(2)));
    }
    #[test]
    fn snapshot_includes_authorized_namespace() {
        let mut s = State::new();
        s.node("extractor").global_set("prompt", json!("hi"));
        s.runtime().configure_node("extractor", shared());
        s.node("extractor").set("draft", json!(1)).unwrap();
        assert_eq!(
            s.node("reviewer").input_snapshot().unwrap(),
            json!({"prompt":"hi","draft":1})
        );
    }
    #[test]
    fn snapshot_rejects_colliding_authorized_keys() {
        let mut s = State::new();
        s.node("extractor").global_set("status", json!("global"));
        s.runtime().configure_node("extractor", shared());
        s.node("extractor").set("status", json!("private")).unwrap();

        assert!(matches!(
            s.node("reviewer").input_snapshot(),
            Err(StateError::InputKeyConflict { key, .. }) if key == "status"
        ));
    }
    #[test]
    fn serializes_namespace_policy() {
        let mut s = State::new();
        s.runtime().configure_node("extractor", shared());
        s.node("extractor").set("draft", json!(1)).unwrap();
        let mut restored: State = serde_json::from_value(serde_json::to_value(s).unwrap()).unwrap();
        assert_eq!(
            restored.node("reviewer").get_from("extractor", "draft").unwrap(),
            Some(&json!(1))
        );
    }

    #[test]
    fn node_update_publishes_only_allowlisted_keys() {
        let update = NodeStateUpdate::new()
            .set("summary", json!("public"))
            .set("raw", json!("private"));
        let mut state = State::new();
        let patch = update.into_patch("extractor", &BTreeSet::from(["summary".to_string()]));

        state.node("extractor").apply(&patch).unwrap();

        assert_eq!(state.node("reader").global_get("summary"), Some(&json!("public")));
        assert_eq!(state.node("extractor").get("raw").unwrap(), Some(&json!("private")));
    }

    #[test]
    fn workflow_snapshot_includes_every_node_value_without_runtime_data() {
        let mut state = State::new();
        state.node("extractor").set("raw", json!("secret to nodes")).unwrap();
        state.node("reviewer").set("decision", json!("approved")).unwrap();
        state.runtime().runtime_set("credential", json!("never shown"));

        assert_eq!(
            state.workflow_snapshot(),
            json!({
                "global": {},
                "nodes": {
                    "extractor": {"raw": "secret to nodes"},
                    "reviewer": {"decision": "approved"},
                },
            })
        );
    }
}
