use super::{ProcessNodeCatalog, ProcessNodeDefinition};
use anyhow::{Context, Result, bail};
use semver::Version;
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    path::Component,
};
use uuid::Uuid;

pub(super) fn validate_catalog(catalog: &ProcessNodeCatalog) -> Result<()> {
    let mut ids = HashSet::with_capacity(catalog.nodes.len());
    for definition in &catalog.nodes {
        validate_definition(definition)?;
        if !ids.insert(&definition.id) {
            bail!("Process Node catalog contains duplicate id {:?}", definition.id);
        }
    }
    Ok(())
}

pub(super) fn validate_definition(definition: &ProcessNodeDefinition) -> Result<()> {
    validate_node_id(&definition.id)?;
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
    validate_schemas("inputs", &definition.inputs)?;
    validate_schemas("outputs", &definition.outputs)?;
    Ok(())
}
pub(super) fn validate_node_id(id: &str) -> Result<()> {
    let uuid = Uuid::parse_str(id).with_context(|| format!("Process Node id must be a UUID, got {id:?}"))?;
    if uuid.hyphenated().to_string() != id {
        bail!("Process Node id must be a lowercase, hyphenated UUID");
    }
    Ok(())
}

pub(super) fn validate_schemas(kind: &str, schemas: &BTreeMap<String, Value>) -> Result<()> {
    for (name, schema) in schemas {
        if name.trim().is_empty() || !schema.is_object() {
            bail!("Process Node {kind} must map non-empty names to JSON object schemas");
        }
    }
    Ok(())
}
