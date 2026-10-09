//! Typed reference locations and dependency graph validation.
use super::super::workflow::validate_document;
use super::{IMPORT_PREFIX, MAX_DEPTH};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum ReferenceKind {
    App,
    Tool,
    Workflow,
}

#[derive(Debug)]
pub(super) struct Reference {
    pub(super) kind: ReferenceKind,
    pub(super) pointer: String,
    pub(super) key: Option<String>,
    pub(super) id: String,
}

fn pointer_key(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn field_ref(data: &Value, pointer: String, kind: ReferenceKind, refs: &mut Vec<Reference>) -> Result<()> {
    let id = data
        .pointer(&pointer)
        .and_then(Value::as_str)
        .context(format!("Missing reference at {pointer}"))?;
    if id.is_empty() {
        bail!("Empty reference at {pointer}");
    }
    refs.push(Reference {
        kind,
        pointer,
        key: None,
        id: id.to_owned(),
    });
    Ok(())
}

fn action_refs(data: &Value, prefix: &str, refs: &mut Vec<Reference>) -> Result<()> {
    match data.pointer(&format!("{prefix}/action/kind")).and_then(Value::as_str) {
        Some("process") => field_ref(data, format!("{prefix}/action/processNodeId"), ReferenceKind::App, refs)?,
        Some("tool") => field_ref(data, format!("{prefix}/action/toolId"), ReferenceKind::Tool, refs)?,
        _ => {},
    }
    Ok(())
}

/// These are identity references, never strings embedded in prompts or schemas.
pub(super) fn references(node: &Value) -> Result<Vec<Reference>> {
    let data = &node["data"];
    let mut refs = Vec::new();
    match node["type"].as_str() {
        Some("process") => {
            if let Some(reference) = data.get("appRef") {
                if reference["source"] != "local" {
                    bail!("Personal sharing cannot include Team App references");
                }
                field_ref(data, "/appRef/localAppId".into(), ReferenceKind::App, &mut refs)?;
                if let Some(id) = data.get("processNodeId").and_then(Value::as_str)
                    && !id.is_empty()
                    && id != refs[0].id
                {
                    bail!("Process App references disagree");
                }
            } else {
                field_ref(data, "/processNodeId".into(), ReferenceKind::App, &mut refs)?;
            }
        },
        Some("subworkflow") => field_ref(data, "/workflowId".into(), ReferenceKind::Workflow, &mut refs)?,
        Some("agent" | "codeact_agent") => {
            if let Some(ids) = data.get("toolIds") {
                for index in 0..ids.as_array().context("toolIds must be an array")?.len() {
                    field_ref(data, format!("/toolIds/{index}"), ReferenceKind::Tool, &mut refs)?;
                }
            }
            if let Some(bindings) = data.get("toolStateBindings") {
                for index in 0..bindings.as_array().context("toolStateBindings must be an array")?.len() {
                    field_ref(
                        data,
                        format!("/toolStateBindings/{index}/toolId"),
                        ReferenceKind::Tool,
                        &mut refs,
                    )?;
                }
            }
        },
        _ => {},
    }
    action_refs(data, "/compensation", &mut refs)?;
    if let Some(declarations) = data.get("toolCompensations") {
        let declarations = declarations
            .as_object()
            .context("toolCompensations must be an object")?;
        for key in declarations.keys() {
            action_refs(data, &format!("/toolCompensations/{}", pointer_key(key)), &mut refs)?;
        }
        // Rename map keys last, after values addressed through their original keys.
        for key in declarations.keys() {
            refs.push(Reference {
                kind: ReferenceKind::Tool,
                pointer: "/toolCompensations".into(),
                key: Some(key.clone()),
                id: key.clone(),
            });
        }
    }
    Ok(refs)
}

pub(super) fn replace_reference(data: &mut Value, reference: &Reference, value: String) -> Result<()> {
    if let Some(key) = &reference.key {
        let map = data
            .pointer_mut(&reference.pointer)
            .and_then(Value::as_object_mut)
            .context("Invalid tool compensation map")?;
        let declaration = map.remove(key).context("Missing tool compensation declaration")?;
        if map.insert(value, declaration).is_some() {
            bail!("Tool binding merges distinct compensation declarations");
        }
    } else {
        *data.pointer_mut(&reference.pointer).context("Missing reference")? = value.into();
    }
    Ok(())
}

pub(super) struct ConfigurationField {
    pub(super) pointer: String,
    pub(super) kind: &'static str,
    pub(super) label: String,
}

fn remote_fields(data: &Value, prefix: &str, fields: &mut Vec<ConfigurationField>, importing: bool) -> Result<()> {
    if let Some(auth) = data.pointer(&format!("{prefix}/authentication"))
        && auth["type"] != "none"
    {
        fields.push(ConfigurationField {
            pointer: format!("{prefix}/authentication/credentialId"),
            kind: "credential",
            label: format!("Remote {} authentication", auth["type"].as_str().unwrap_or("service")),
        });
    }
    if let Some(url) = data.pointer(&format!("{prefix}/url")).and_then(Value::as_str) {
        let private = if url.starts_with(IMPORT_PREFIX) {
            true
        } else {
            let url = url::Url::parse(url).context("Invalid Remote Agent URL")?;
            !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some()
        };
        if private {
            if importing && !url.starts_with(IMPORT_PREFIX) {
                bail!("Remote URL with private components must use a configuration requirement");
            }
            fields.push(ConfigurationField {
                pointer: format!("{prefix}/url"),
                kind: "url",
                label: "Remote service URL".into(),
            });
        }
    }
    Ok(())
}

pub(super) fn configuration_fields(node: &Value, importing: bool) -> Result<Vec<ConfigurationField>> {
    let data = &node["data"];
    let mut fields = Vec::new();
    match node["type"].as_str() {
        Some("agent" | "codeact_agent") => {
            fields.push(ConfigurationField {
                pointer: "/modelProfileId".into(),
                kind: "model",
                label: "Agent model".into(),
            });
            for (index, skill) in data["skillRefs"].as_array().into_iter().flatten().enumerate() {
                if skill["source"] != "personal" {
                    bail!("Unsupported Skill source");
                }
                fields.push(ConfigurationField {
                    pointer: format!("/skillRefs/{index}/name"),
                    kind: "skill",
                    label: "Skill".into(),
                });
            }
            for (index, mount) in data["mounts"].as_array().into_iter().flatten().enumerate() {
                fields.push(ConfigurationField {
                    pointer: format!("/mounts/{index}/hostPath"),
                    kind: "mount",
                    label: format!("Mount {}", mount["virtualPath"].as_str().unwrap_or("directory")),
                });
            }
            for (index, environment) in data["environment"].as_array().into_iter().flatten().enumerate() {
                fields.push(ConfigurationField {
                    pointer: format!("/environment/{index}/value"),
                    kind: "environment",
                    label: format!("Environment {}", environment["name"].as_str().unwrap_or("variable")),
                });
            }
        },
        Some("remote_agent") => remote_fields(data, "", &mut fields, importing)?,
        _ => {},
    }
    if data.pointer("/compensation/action/kind") == Some(&json!("remote_agent")) {
        remote_fields(data, "/compensation/action", &mut fields, importing)?;
    }
    for (key, declaration) in data["toolCompensations"].as_object().into_iter().flatten() {
        if declaration.pointer("/action/kind") == Some(&json!("remote_agent")) {
            remote_fields(
                data,
                &format!("/toolCompensations/{}/action", pointer_key(key)),
                &mut fields,
                importing,
            )?;
        }
    }
    Ok(fields)
}

pub(super) fn document_nodes(document: &Value) -> Result<&Vec<Value>> {
    validate_document(document, None)?;
    let nodes = document["nodes"].as_array().unwrap();
    let mut ids = BTreeSet::new();
    for node in nodes {
        let id = node["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .context("Workflow node needs an ID")?;
        if !ids.insert(id) || !node["data"].is_object() || !node["type"].is_string() {
            bail!("Invalid or duplicate Workflow node");
        }
    }
    for edge in document["edges"].as_array().unwrap() {
        for side in ["source", "target"] {
            if !edge[side].as_str().is_some_and(|id| ids.contains(id)) {
                bail!("Workflow edge references a missing node");
            }
        }
    }
    Ok(nodes)
}

pub(super) fn verify_graph(root: &str, documents: &BTreeMap<String, Value>) -> Result<()> {
    fn visit(
        id: &str,
        documents: &BTreeMap<String, Value>,
        visiting: &mut BTreeSet<String>,
        seen: &mut BTreeSet<String>,
    ) -> Result<()> {
        if visiting.contains(id) {
            bail!("Subworkflow dependency cycle");
        }
        if seen.contains(id) {
            return Ok(());
        }
        if visiting.len() >= MAX_DEPTH {
            bail!("Subworkflow dependencies exceed 32 levels");
        }
        visiting.insert(id.into());
        for node in document_nodes(documents.get(id).context("Missing subworkflow dependency")?)? {
            for reference in references(node)? {
                if reference.kind == ReferenceKind::Workflow {
                    visit(&reference.id, documents, visiting, seen)?;
                }
            }
        }
        visiting.remove(id);
        seen.insert(id.into());
        Ok(())
    }
    let mut seen = BTreeSet::new();
    visit(root, documents, &mut BTreeSet::new(), &mut seen)?;
    if seen.len() != documents.len() {
        bail!("Package contains unrelated Workflows");
    }
    Ok(())
}
