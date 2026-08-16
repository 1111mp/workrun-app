use super::types::*;
use crate::module::tool_registry::{ToolDefinition, ToolSource};
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::collections::BTreeMap;

pub(super) fn process_tool_definition(node: ProcessNodeDefinition) -> Result<ToolDefinition> {
    if node.inputs.is_empty() {
        bail!("Tool App `{}` must define at least one input schema", node.name);
    }
    if node.outputs.is_empty() {
        bail!("Tool App `{}` must define at least one output schema", node.name);
    }
    let input_schema = object_schema(&node.inputs);
    let output_schema = object_schema(&node.outputs);
    jsonschema::validator_for(&input_schema)
        .with_context(|| format!("Tool App `{}` has an invalid input schema", node.name))?;
    jsonschema::validator_for(&output_schema)
        .with_context(|| format!("Tool App `{}` has an invalid output schema", node.name))?;
    let id = node.id.clone();
    Ok(ToolDefinition {
        id,
        source: ToolSource::Process,
        source_id: None,
        source_name: None,
        display_name: node.name.clone(),
        name: format!("process_{}", node.id.replace('-', "_")),
        description: if node.description.trim().is_empty() {
            node.name.clone()
        } else {
            format!("{}: {}", node.name, node.description)
        },
        version: node.version,
        input_schema,
        output_schema,
        risk_level: node.tool_risk_level,
        permissions: node.tool_permissions,
        execution_policy: node.tool_execution_policy,
    })
}

fn object_schema(properties: &BTreeMap<String, Value>) -> Value {
    let required = properties
        .iter()
        .filter_map(|(name, schema)| (!is_optional_field(schema)).then_some(name))
        .collect::<Vec<_>>();
    let properties = properties
        .iter()
        .map(|(name, schema)| (name.clone(), without_workrun_schema_extensions(schema)))
        .collect::<serde_json::Map<String, Value>>();
    serde_json::json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Field-level `required` is not part of JSON Schema. Keep App definitions
/// compact by accepting this Workrun extension and compile it into the parent
/// object's standard `required` list before passing the schema to an Agent.
fn is_optional_field(schema: &Value) -> bool {
    schema
        .get("x-workrun-optional")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn without_workrun_schema_extensions(schema: &Value) -> Value {
    let mut schema = schema.clone();
    if let Some(object) = schema.as_object_mut() {
        object.remove("x-workrun-optional");
    }
    schema
}
