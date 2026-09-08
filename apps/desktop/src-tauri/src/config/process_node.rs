use crate::{
    logging,
    module::tool_registry::ToolRiskLevel,
    utils::{dirs, help, logging::Type},
};
use anyhow::{Context, Result, bail};
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, PathBuf},
};
use uuid::Uuid;

/// How a Process Node is invoked by Workrun.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProcessNodeKind {
    /// A deterministic workflow step placed directly on the canvas.
    #[default]
    Workflow,
    /// A callable function made available to selected Agent nodes.
    Tool,
}

/// Whether each Agent invocation needs an explicit user confirmation.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolExecutionPolicy {
    #[default]
    AskEveryTime,
    Auto,
}

/// Persisted metadata for one uv-managed Python Process Node.
///
/// Python versions and dependencies remain in the project's `pyproject.toml`
/// and `uv.lock`, so they are not duplicated in the catalog.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IProcessNode {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub version: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
    pub entry: PathBuf,
    /// Older entries use the default Process Node directory when this is absent.
    #[serde(default)]
    pub project_root: Option<PathBuf>,
    #[serde(default)]
    pub kind: ProcessNodeKind,
    #[serde(default)]
    pub tool_execution_policy: ToolExecutionPolicy,
    #[serde(default)]
    pub tool_risk_level: ToolRiskLevel,
    #[serde(default)]
    pub tool_permissions: Vec<String>,
    #[serde(default)]
    pub inputs: BTreeMap<String, Value>,
    #[serde(default)]
    pub outputs: BTreeMap<String, Value>,
}

/// The persisted Process Node catalog.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IProcessNodes {
    #[serde(default)]
    nodes: Vec<IProcessNode>,
}

impl Default for IProcessNodes {
    fn default() -> Self {
        Self { nodes: vec![] }
    }
}

impl IProcessNodes {
    /// Loads the catalog once during global configuration initialization.
    /// A missing or malformed catalog must not prevent the application from starting.
    pub async fn new() -> Self {
        match dirs::process_node_catalog_path() {
            Ok(path) => match help::read_json::<Self>(&path).await {
                Ok(nodes) => nodes,
                Err(error) => {
                    logging!(error, Type::Config, "{error}");
                    Self::default()
                },
            },
            Err(error) => {
                logging!(error, Type::Config, "{error}");
                Self::default()
            },
        }
    }

    /// Writes the complete catalog. Callers use `Draft::with_data_modify` so
    /// the in-memory snapshot is committed only after this succeeds.
    pub async fn save_file(&self) -> Result<()> {
        help::save_json(&dirs::process_node_catalog_path()?, self, None).await
    }

    /// Returns detached definitions so callers cannot alter the committed snapshot.
    pub fn get_process_nodes(&self) -> Vec<IProcessNode> {
        self.nodes.clone()
    }

    pub fn get_process_node(&self, id: &str) -> Option<IProcessNode> {
        self.nodes.iter().find(|node| node.id == id).cloned()
    }

    #[cfg(test)]
    pub(crate) fn from_nodes(nodes: Vec<IProcessNode>) -> Self {
        Self { nodes }
    }

    pub(crate) fn add_process_node(&mut self, node: IProcessNode) {
        self.nodes.push(node);
    }

    pub(crate) fn replace_process_node(&mut self, node: IProcessNode) -> bool {
        let Some(position) = self.nodes.iter().position(|current| current.id == node.id) else {
            return false;
        };
        self.nodes[position] = node;
        true
    }

    pub(crate) fn remove_process_node(&mut self, id: &str) -> bool {
        let original_len = self.nodes.len();
        self.nodes.retain(|node| node.id != id);
        self.nodes.len() != original_len
    }
}

/// Validates the complete persisted catalog before a Draft snapshot is saved.
pub(crate) fn validate_process_node_catalog(catalog: &IProcessNodes) -> Result<()> {
    let definitions = catalog.get_process_nodes();
    let mut ids = HashSet::with_capacity(definitions.len());
    for definition in &definitions {
        validate_process_node_definition(definition)?;
        if !ids.insert(&definition.id) {
            bail!("Process Node catalog contains duplicate id {:?}", definition.id);
        }
    }
    Ok(())
}

pub(crate) fn validate_process_node_definition(definition: &IProcessNode) -> Result<()> {
    validate_process_node_id(&definition.id)?;
    if definition.name.trim().is_empty() {
        bail!("Process Node name must not be empty");
    }
    Version::parse(&definition.version).with_context(|| {
        format!(
            "Process Node version must be valid semver, got {:?}",
            definition.version
        )
    })?;
    if definition.entry.as_os_str().is_empty()
        || definition.entry.components().any(|component| {
            matches!(
                component,
                Component::Prefix(_) | Component::RootDir | Component::CurDir | Component::ParentDir
            )
        })
    {
        bail!("Process Node entry must be a non-empty relative file path");
    }
    if let Some(project_root) = &definition.project_root
        && (!project_root.is_absolute() || project_root.as_os_str().is_empty())
    {
        bail!("Process Node project root must be an absolute path");
    }
    validate_schemas("inputs", &definition.inputs)?;
    validate_schemas("outputs", &definition.outputs)
}

pub(crate) fn validate_process_node_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).with_context(|| format!("Process Node id must be a UUID, got {id:?}"))?;
    if uuid.hyphenated().to_string() != id {
        bail!("Process Node id must be a lowercase, hyphenated UUID");
    }
    Ok(())
}

fn validate_schemas(kind: &str, schemas: &BTreeMap<String, Value>) -> Result<()> {
    for (name, schema) in schemas {
        if name.trim().is_empty() || !schema.is_object() {
            bail!("Process Node {kind} must map non-empty names to JSON object schemas");
        }
        if let Some(default) = schema.get("default") {
            let validator = jsonschema::validator_for(schema)
                .with_context(|| format!("Process Node {kind}.{name} has an invalid JSON Schema"))?;
            if let Some(error) = validator.iter_errors(default).next() {
                bail!("Process Node {kind}.{name} default does not match its schema: {error}");
            }
        }
    }
    Ok(())
}
