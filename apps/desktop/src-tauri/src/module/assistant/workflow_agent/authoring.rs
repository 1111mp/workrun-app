//! Progressive subagent references and validated workflow persistence.
//! Compilation validates a graph; it never proves the user's goal was achieved.
use crate::{
    config::IWorkrun,
    module::workflow::{self, contracts},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
#[cfg(test)]
use sha2::{Digest, Sha256};
#[cfg(test)]
use std::path::{Path, PathBuf};

#[path = "reference/node_references.rs"]
mod node_references;
pub(in crate::module::assistant) use node_references::NODE_REFERENCES;

pub(in crate::module::assistant) fn reference(args: &Value) -> Result<Value> {
    let topic = args["topic"].as_str().unwrap_or("index");
    Ok(match topic {
        "index" => {
            json!({"schemaVersion":1,"topics":["nodes","node-schema","format","state","routing","recovery","compensation","execution-recovery"],"nodes":contracts::NODE_TYPES.iter().map(|kind|{let c=contracts::node_contract(kind).unwrap();json!({"type":kind,"title":c["title"],"summary":c["summary"],"skill":format!("workflow-node-{kind}")})}).collect::<Vec<_>>(),"next":"read_skill workflow-authoring, then request only relevant node_types"})
        },
        "nodes" | "node-schema" => {
            let kinds = args["node_types"]
                .as_array()
                .context("node_types is required for topic nodes")?;
            ensure!(
                !kinds.is_empty() && kinds.len() <= contracts::NODE_TYPES.len(),
                "Request 1–13 node types"
            );
            let nodes = kinds
                .iter()
                .map(|kind| -> Result<Value> {
                    let kind = kind.as_str().context("Node type must be a string")?;
                    let contract = contracts::node_contract(kind)?;
                    if topic == "node-schema" {
                        return Ok(json!({"type":kind,"dataSchema":contract["dataSchema"]}));
                    }
                    let (_, _, guide) = NODE_REFERENCES
                        .iter()
                        .find(|(name, _, _)| *name == kind)
                        .context("Missing packaged node reference")?;
                    Ok(json!({"type":kind,"skill":format!("workflow-node-{kind}"),"guide":crate::module::assistant::resources::read(guide)?}))
                })
                .collect::<Result<Vec<_>>>()?;
            json!({"schemaVersion":1,"nodes":nodes})
        },
        "format" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/format.md")?})
        },
        "state" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/state.md")?})
        },
        "routing" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/routing.md")?})
        },
        "recovery" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/recovery.md")?})
        },
        "compensation" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/compensation.md")?})
        },
        "execution-recovery" => {
            json!({"schemaVersion":1,"guide":crate::module::assistant::resources::read("workflow_agent/reference/execution-recovery.md")?})
        },
        _ => anyhow::bail!("Unknown authoring topic"),
    })
}

fn issue(phase: &str, path: &str, message: impl ToString) -> Value {
    json!({"phase":phase,"path":path,"message":message.to_string()})
}
fn structural_issues(document: &Value) -> Vec<Value> {
    let mut issues = vec![];
    if let Err(error) = crate::feat::validate_document(document, None) {
        return vec![issue("document", "/", error)];
    }
    let settings = &document["settings"];
    for key in settings.as_object().unwrap().keys() {
        if ![
            "name",
            "description",
            "mode",
            "inputSchema",
            "outputSchema",
            "sessionStateFields",
        ]
        .contains(&key.as_str())
        {
            issues.push(issue(
                "document",
                &format!("/settings/{key}"),
                "Unknown workflow setting; do not inject runtime adapter metadata",
            ));
        }
    }
    if settings["name"].as_str().is_none_or(|s| s.trim().is_empty()) {
        issues.push(issue("document", "/settings/name", "Name is required"));
    }
    if !matches!(settings["mode"].as_str(), Some("task" | "chat")) {
        issues.push(issue("document", "/settings/mode", "Mode must be task or chat"));
    }
    for kind in ["inputSchema", "outputSchema"] {
        if let Some(interface) = settings.get(kind) {
            if let Some(fields) = interface["fields"].as_array() {
                let mut keys = std::collections::HashSet::new();
                for (index, field) in fields.iter().enumerate() {
                    if field["key"]
                        .as_str()
                        .is_none_or(|key| key.trim().is_empty() || key.starts_with("workflow.") || !keys.insert(key))
                    {
                        issues.push(issue(
                            "interface",
                            &format!("/settings/{kind}/fields/{index}/key"),
                            "Keys must be nonempty, unique and not reserved",
                        ));
                    }
                    if let Some(t) = field.get("type")
                        && !matches!(
                            t.as_str(),
                            Some("string" | "textarea" | "number" | "boolean" | "file" | "files")
                        )
                    {
                        issues.push(issue(
                            "interface",
                            &format!("/settings/{kind}/fields/{index}/type"),
                            "Unsupported interface field type",
                        ));
                    }
                    if field.get("required").is_some_and(|value| !value.is_boolean()) {
                        issues.push(issue(
                            "interface",
                            &format!("/settings/{kind}/fields/{index}/required"),
                            "Expected a boolean",
                        ));
                    }
                    for name in ["id", "label", "description"] {
                        if field.get(name).is_some_and(|value| !value.is_string()) {
                            issues.push(issue(
                                "interface",
                                &format!("/settings/{kind}/fields/{index}/{name}"),
                                "Expected a string",
                            ));
                        }
                    }
                }
            } else {
                issues.push(issue(
                    "interface",
                    &format!("/settings/{kind}/fields"),
                    "Expected fields array",
                ));
            }
        }
    }
    let nodes = document["nodes"].as_array().unwrap();
    if nodes.len() > 100 || document["edges"].as_array().unwrap().len() > 200 {
        issues.push(issue("document", "/", "Draft limit is 100 nodes and 200 edges"));
    }
    for (index, node) in nodes.iter().enumerate() {
        let path = format!("/nodes/{index}");
        if node["id"]
            .as_str()
            .is_none_or(|id| id.trim().is_empty() || id.starts_with("workflow."))
        {
            issues.push(issue("node", &path, "Node ID must be nonempty and not reserved"));
        }
        match node["type"].as_str().map(contracts::node_contract) {
            Some(Ok(contract)) => match jsonschema::validator_for(&contract["dataSchema"]) {
                Ok(validator) => {
                    for error in validator.iter_errors(&node["data"]).take(10) {
                        issues.push(issue(
                            "node_schema",
                            &format!("{path}/data{}", error.instance_path()),
                            error,
                        ));
                    }
                },
                Err(error) => issues.push(issue("contract", &path, error)),
            },
            _ => issues.push(issue(
                "node_type",
                &format!("{path}/type"),
                "Unknown node type; query the node directory",
            )),
        }
    }
    issues
}

pub(in crate::module::assistant) async fn validate(document: &Value, config: &IWorkrun) -> Result<Value> {
    let mut issues = structural_issues(document);
    if issues.is_empty() {
        for (index, node) in document["nodes"].as_array().unwrap().iter().enumerate() {
            let checked: Result<()> = match node["type"].as_str() {
                Some("process") => {
                    async {
                        let app =
                            crate::feat::process_node_inspect(node["data"]["processNodeId"].as_str().unwrap()).await?;
                        ensure!(
                            app.definition.kind == crate::config::ProcessNodeKind::Workflow,
                            "Tool Apps belong in Agent toolIds, not process nodes"
                        );
                        ensure!(
                            matches!(
                                app.install_status,
                                crate::module::process_node::ProcessNodeInstallStatus::Installed
                            ),
                            "Install the App before using it in a generated workflow"
                        );
                        Ok(())
                    }
                    .await
                },
                Some("subworkflow") => crate::feat::get_workflow(node["data"]["workflowId"].as_str().unwrap())
                    .await
                    .map(|_| ()),
                _ => Ok(()),
            };
            if let Err(error) = checked {
                issues.push(issue("resource", &format!("/nodes/{index}/data"), error));
            }
        }
    }
    if issues.is_empty() {
        let wrapped = json!({"id":"authoring-validation","document":document});
        match crate::module::assistant::catalog::document_dsl(&wrapped)
            .and_then(|value| Ok(serde_json::from_value::<workflow::WorkflowDsl>(value)?))
        {
            Ok(dsl) => {
                let directory = tempfile::tempdir()?;
                let path = directory.path().join("checkpoint.sqlite");
                std::fs::File::create(&path)?;
                let result = workflow::VALIDATION_CHECKPOINT_DB
                    .scope(
                        format!("sqlite://{}", path.display()),
                        workflow::compile(dsl, config, None),
                    )
                    .await;
                if let Err(error) = result {
                    issues.push(issue("compile", "/", error));
                }
            },
            Err(error) => issues.push(issue("dsl", "/", error)),
        }
    }
    Ok(
        json!({"valid":issues.is_empty(),"issues":issues,"executed":false,"schemaVersion":1,"next":if issues.is_empty(){"Save a draft revision, then execute its capability ID with input bindings if the user requested execution"}else{"Correct the reported paths and validate again; compile errors may require native model/tool/App/credential configuration"}}),
    )
}

pub(in crate::module::assistant) fn parse_document(args: &Value) -> Result<Value> {
    let text = args["document_json"]
        .as_str()
        .context("document_json must be a JSON string containing settings, nodes and edges")?;
    ensure!(text.len() <= 256_000, "Draft JSON exceeds 256 KB");
    serde_json::from_str(text).map_err(|error| anyhow::anyhow!("Invalid workflow JSON: {error}"))
}
#[cfg(test)]
fn digest(document: &Value) -> Result<String> {
    Ok(hex::encode(Sha256::digest(serde_json::to_vec(document)?)))
}
#[cfg(test)]
fn draft_path(root: &Path, id: &str) -> Result<PathBuf> {
    let id = uuid::Uuid::parse_str(id).context("Invalid draft ID")?;
    Ok(root.join("assistant/drafts").join(format!("{id}.json")))
}
#[cfg(test)]
pub(in crate::module::assistant) async fn save(root: &Path, document: Value, config: &IWorkrun) -> Result<Value> {
    let validation = validate(&document, config).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let path = draft_path(root, &id)?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    let workflow = json!({"id":format!("draft:{id}"),"document":document,"draft":{"id":id,"schemaVersion":1,"sha256":digest(&document)?,"validation":validation}});
    // Each save is a new revision. Never overwrite an existing workflow or the
    // previous draft; an incomplete write cannot become a runnable capability.
    use std::io::Write;
    let mut temporary = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    temporary.write_all(&serde_json::to_vec_pretty(&workflow)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist_noclobber(&path)?;
    Ok(
        json!({"draft_id":id,"capability_id":workflow["id"],"sha256":workflow["draft"]["sha256"],"validation":validation,"review_path":path,"published":false,"executed":false}),
    )
}
#[cfg(test)]
pub(in crate::module::assistant) fn load(root: &Path, id: &str, require_valid: bool) -> Result<Value> {
    let path = draft_path(root, id)?;
    ensure!(std::fs::metadata(&path)?.len() <= 2_000_000, "Draft file too large");
    let bytes = std::fs::read(path)?;
    let workflow: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        workflow["id"] == format!("draft:{}", uuid::Uuid::parse_str(id)?),
        "Draft identity changed"
    );
    ensure!(
        workflow["draft"]["sha256"] == digest(&workflow["document"])?,
        "Draft changed since validation; save a new revision"
    );
    if require_valid {
        ensure!(
            workflow["draft"]["validation"]["valid"] == true,
            "Draft is not valid; repair it before execution"
        );
    }
    Ok(workflow)
}

async fn current_draft(id: &str) -> Result<Value> {
    Ok(serde_json::to_value(crate::feat::get_workflow(id).await?)?)
}

pub(in crate::module::assistant) async fn native_tool(name: &str, args: &Value) -> Result<Value> {
    let config = crate::config::BaseConfig::workrun().await.data_arc();
    match name {
        "get_workflow_draft" => current_draft(args["draft_id"].as_str().context("draft_id is required")?).await,
        "validate_workflow_draft" => {
            let document = if let Some(id) = args["draft_id"].as_str() {
                current_draft(id).await?["document"].clone()
            } else {
                parse_document(args)?
            };
            validate(&document, &config).await
        },
        "save_workflow_draft" => {
            let document = parse_document(args)?;
            let validation = validate(&document, &config).await?;
            ensure!(
                validation["valid"] == true,
                "Workflow must pass validation before saving: {}",
                validation["issues"]
            );
            let workflow = crate::feat::save_authored_workflow(
                args["operation_id"]
                    .as_str()
                    .context("Native delegation operation ID is missing")?,
                args["target_id"].as_str(),
                document,
            )
            .await?;
            Ok(
                json!({"capability_id":workflow.id,"draft_id":workflow.id,"validation":validation,"published":false,"executed":false}),
            )
        },
        "list_authoring_resources" => match args["kind"].as_str().unwrap_or("models") {
            "models" => Ok(
                json!({"items":crate::config::model_catalog(),"note":"IDs are native modelProfileId values; provider credentials must be configured separately"}),
            ),
            "skills" => Ok(json!({"items":crate::module::skill::SkillRegistry::list()?})),
            "tools" => {
                let tools = crate::module::tool_registry::ToolRegistry::list().await?;
                let offset = args["cursor"].as_str().unwrap_or("0").parse::<usize>()?;
                let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
                Ok(
                    json!({"items":tools.iter().skip(offset).take(limit).collect::<Vec<_>>(),"nextCursor":(offset.saturating_add(limit)<tools.len()).then(||offset.saturating_add(limit).to_string())}),
                )
            },
            _ => anyhow::bail!(
                "Unknown resource kind; use models, tools or skills. Apps and workflows use list_capabilities"
            ),
        },
        _ => anyhow::bail!("Unknown authoring tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(in crate::module::assistant) fn document() -> Value {
        let mut workflow: Value =
            serde_json::from_str(include_str!("../fixtures/expense-review.workflow.json")).unwrap();
        // This is a new base-node graph, not a catalog/subworkflow reference.
        workflow["document"]["settings"]["name"] = json!("Generated expense routing");
        workflow["document"].clone()
    }
    #[test]
    fn references_and_skill_are_progressive_and_reject_unknown_nodes() {
        let index = reference(&json!({})).unwrap();
        assert_eq!(index["nodes"].as_array().unwrap().len(), 13);
        assert!(!index.to_string().contains("dataSchema"));
        let reference = reference(&json!({"topic":"nodes","node_types":["if_else"]})).unwrap();
        assert_eq!(reference["nodes"].as_array().unwrap().len(), 1);
        assert!(
            reference["nodes"][0]["guide"]
                .as_str()
                .unwrap()
                .contains("interface IfElseNodeData")
        );
        assert!(reference["nodes"][0].get("dataSchema").is_none());
        assert!(!reference.to_string().contains("workflow/routing.rs"));
        let schema = super::reference(&json!({"topic":"node-schema","node_types":["if_else"]})).unwrap();
        assert!(schema["nodes"][0]["dataSchema"].is_object());
        assert!(super::reference(&json!({"topic":"nodes","node_types":["loop"]})).is_err());
        let skills = crate::module::assistant::workflow_agent::skills::catalog();
        assert!(
            skills
                .read("workflow-authoring")
                .unwrap()
                .contains("save_workflow_draft")
        );
        assert_eq!(NODE_REFERENCES.len(), contracts::NODE_TYPES.len());
        for kind in contracts::NODE_TYPES {
            assert!(NODE_REFERENCES.iter().any(|(name, _, _)| name == kind));
        }
        assert!(!skills.summaries().to_string().contains("interface IfElseNodeData"));
        for (kind, _, guide) in NODE_REFERENCES {
            assert_eq!(
                skills.read(&format!("workflow-node-{kind}")).unwrap(),
                crate::module::assistant::resources::read(guide).unwrap()
            );
        }
        assert!(
            !skills
                .mandatory_instructions()
                .unwrap()
                .contains("# Workflow authoring")
        );
    }
    #[tokio::test]
    async fn validation_repairs_schema_and_native_graph_errors() {
        let config = IWorkrun::default();
        let mut document = document();
        let original = document.clone();
        document["nodes"][1]["data"]["conditions"]
            .as_object_mut()
            .unwrap()
            .remove("false");
        let report = validate(&document, &config).await.unwrap();
        assert_eq!(report["valid"], false);
        assert_eq!(report["issues"][0]["phase"], "node_schema");
        assert!(
            report["issues"][0]["path"]
                .as_str()
                .unwrap()
                .starts_with("/nodes/1/data")
        );
        document = original.clone();
        document["edges"][1]["sourceHandle"] = json!("invented_route");
        let report = validate(&document, &config).await.unwrap();
        assert_eq!(report["valid"], false);
        assert_eq!(report["issues"][0]["phase"], "compile");
        let report = validate(&original, &config).await.unwrap();
        assert_eq!(report["valid"], true);
        assert_eq!(report["executed"], false);
        document = original;
        document["settings"]["capabilityInputSchema"] = json!({});
        assert_eq!(validate(&document, &config).await.unwrap()["valid"], false);
        document = self::document();
        document["settings"]["inputSchema"]["fields"][0]["required"] = json!("true");
        assert_eq!(validate(&document, &config).await.unwrap()["valid"], false);
    }
    #[tokio::test]
    async fn draft_revisions_are_durable_isolated_and_hash_checked() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let config = IWorkrun::default();
        let document = document();
        let saved = save(root.path(), document.clone(), &config).await.unwrap();
        let id = saved["draft_id"].as_str().unwrap();
        assert_eq!(saved["validation"]["valid"], true);
        let loaded = load(root.path(), id, true).unwrap();
        assert_eq!(loaded["document"], document);
        assert!(load(other.path(), id, true).is_err());
        assert!(load(root.path(), "../../escape", false).is_err());
        let second = save(root.path(), document.clone(), &config).await.unwrap();
        assert_ne!(second["draft_id"], saved["draft_id"]);
        let mut changed = loaded;
        changed["document"]["settings"]["name"] = json!("Changed without validation");
        std::fs::write(
            draft_path(root.path(), id).unwrap(),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(
            load(root.path(), id, true)
                .unwrap_err()
                .to_string()
                .contains("changed since validation")
        );
        let mut bad = document;
        bad["nodes"][1]["type"] = json!("loop");
        let bad = save(root.path(), bad, &config).await.unwrap();
        assert_eq!(bad["validation"]["valid"], false);
        assert!(load(root.path(), bad["draft_id"].as_str().unwrap(), true).is_err());
        assert!(load(root.path(), bad["draft_id"].as_str().unwrap(), false).is_ok());
    }
    #[tokio::test]
    async fn codeact_reaches_its_existing_compiler_instead_of_type_rejection() {
        let mut document = document();
        document["nodes"][1]["type"] = json!("codeact_agent");
        document["nodes"][1]["data"] = json!({});
        document["edges"] = json!([{"source":"start","target":"review-rule"},{"source":"review-rule","target":"end"}]);
        let dsl =
            crate::module::assistant::catalog::document_dsl(&json!({"id":"codeact-contract","document":document}))
                .unwrap();
        let error = workflow::compile(serde_json::from_value(dsl).unwrap(), &Default::default(), None)
            .await
            .err()
            .unwrap()
            .to_string();
        assert!(error.contains("needs data.modelProfileId"), "{error}");
        assert!(!error.contains("unsupported type"));
    }
}
