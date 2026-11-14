//! Planner tools are independently constructed; no authoring/dispatch grants.
use serde_json::{Value, json};
use std::collections::HashMap;
pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    let mut tools = crate::module::assistant::workspace_resources::declarations();
    for declaration in [
        json!({"name":"get_workflow_plan","description":"Read the current proposal or a specified immutable version.","parameters":{"type":"object","properties":{"version":{"type":"integer","minimum":1}},"additionalProperties":false}}),
        json!({"name":"save_workflow_plan","description":"Save a proposal matching workflow-planning. base_version is current version, or 0 initially. Questions block approval; no Workflow is created.","parameters":{"type":"object","properties":{"document_json":{"type":"string","maxLength":65536},"base_version":{"type":"integer","minimum":0}},"required":["document_json","base_version"],"additionalProperties":false}}),
        json!({"name":"get_workflow_reference","description":"Read selected node semantics or the topic index. Node queries require node_types. Default summary; full only for unresolved feasibility.","parameters":{"type":"object","properties":{"topic":{"type":"string","enum":["index","capabilities","codeact-runtime","configuration","examples","nodes","node-schema","format","state","routing","recovery","compensation","execution-recovery"]},"node_types":{"type":"array","minItems":1,"items":{"type":"string","enum":crate::module::workflow::contracts::NODE_TYPES}},"detail":{"type":"string","enum":["summary","full"]}},"required":["topic"],"additionalProperties":false}}),
        json!({"name":"list_authoring_resources","description":"List native modelProfileId values.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["models"]},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"list_capabilities","description":"Search Workflow/App summaries; capability_id reads the exact contract before reuse.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"read_artifact","description":"Read an authorized attachment as paginated UTF-8 text.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}}),
        json!({"name":"read_skill","description":"Read an optional built-in Skill; workflow-planning is already supplied.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
        json!({"name":"report_progress","description":"Report brief public progress, not private reasoning.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}),
    ] {
        tools.insert(declaration["name"].as_str().unwrap().into(), declaration);
    }
    tools
}
pub(in crate::module::assistant) fn read(name: &str, args: &Value) -> anyhow::Result<Value> {
    match name {
        "read_skill" => {
            let name = args["name"].as_str().unwrap_or_default();
            super::skills::catalog().read_for_model(name)
        },
        "get_workflow_reference" => {
            let reference = crate::module::assistant::workflow_agent::authoring::reference;
            let topic = args["topic"].as_str().ok_or_else(|| anyhow::anyhow!(
                "topic is required: use topic=nodes with node_types for node semantics, or topic=index for discovery"
            ))?;
            // Never return an index for an incomplete contract read: the planner
            // could mistake discovery summaries for implementation feasibility.
            if matches!(topic, "nodes" | "node-schema") {
                anyhow::ensure!(
                    args["node_types"].as_array().is_some_and(|types| !types.is_empty()),
                    "topic={topic} requires nonempty node_types; use topic=index to discover supported node types"
                );
            } else {
                anyhow::ensure!(
                    args.get("node_types").is_none() || matches!(topic, "examples" | "configuration"),
                    "node_types requires topic=nodes, node-schema, configuration or examples"
                );
            }
            if matches!(topic, "nodes" | "node-schema") && args["detail"] != "full" {
                let kinds = args["node_types"].as_array().unwrap();
                anyhow::ensure!(
                    kinds.len() <= crate::module::workflow::contracts::NODE_TYPES.len(),
                    "Too many node types"
                );
                let nodes = kinds.iter().map(|kind| -> anyhow::Result<Value> {
                    let kind = kind.as_str().ok_or_else(|| anyhow::anyhow!("Node type must be a string"))?;
                    let contract = crate::module::workflow::contracts::node_contract(kind)?;
                    let brief = &contract["planning"];
                    Ok(json!({"type":kind,"guide":format!("Can: {}\nLimits: {}\nRequires: {}",
                        brief["capability"].as_str().unwrap(), brief["limits"].as_str().unwrap(), brief["requires"].as_str().unwrap())}))
                }).collect::<anyhow::Result<Vec<_>>>()?;
                return Ok(json!({"schemaVersion":1,"nodes":nodes,"detail":"planning_semantics",
                    "next":"Choose a feasible approach and save the proposal. Read full contracts only for an unresolved material feasibility question; configuration belongs to the author."}));
            }
            let mut selected = args.clone();
            if args["detail"] != "full" {
                selected["detail"] = json!("full");
            }
            let mut value = reference(&selected)?;
            if args["detail"] == "full" {
                return Ok(value);
            }
            if let Some(guide) = value["guide"].as_str() {
                value["guide"] = json!(guide.split("\n\n").take(2).collect::<Vec<_>>().join("\n\n"));
                value["detail"] = json!("planning_summary");
                value["next"] = json!(
                    "Read selected node semantics for feasibility; implementation details belong to the author. Use detail=full only for an unresolved material question."
                );
            } else if let Some(examples) = value["examples"].as_array_mut() {
                for example in examples {
                    if let Some(object) = example.as_object_mut() {
                        object.remove("document");
                    }
                }
            }
            Ok(value)
        },
        "report_progress" => {
            let summary = args["summary"].as_str().unwrap_or_default().trim();
            anyhow::ensure!(
                !summary.is_empty() && summary.chars().count() <= 600,
                "Invalid progress summary"
            );
            Ok(json!({"summary":summary}))
        },
        _ => anyhow::bail!("Not a planner reference tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mandatory_planning_skill_is_not_duplicated_in_tool_history() {
        let value = read("read_skill", &json!({"name":"workflow-planning"})).unwrap();
        assert_eq!(value["alreadyInInstructions"], true);
        assert!(value.get("content").is_none());
        assert!(read("read_skill", &json!({"name":"workrun-capabilities"})).unwrap()["content"].is_string());
    }

    #[test]
    fn planner_reads_semantics_by_default_and_can_explicitly_resolve_full_details() {
        let args = json!({"topic":"nodes","node_types":["codeact_agent","agent"]});
        let summary = read("get_workflow_reference", &args).unwrap();
        let mut full_args = args.clone();
        full_args["detail"] = json!("full");
        let full = read("get_workflow_reference", &full_args).unwrap();
        let shared = crate::module::assistant::workflow_agent::authoring::reference(&full_args).unwrap();
        assert_eq!(full, shared);
        assert!(summary["nodes"][0]["guide"].as_str().unwrap().contains("Monty"));
        assert!(!summary.to_string().contains("export interface"));
        assert!(full.to_string().contains("export interface"));
        assert!(summary.to_string().len() < full.to_string().len());
        assert!(!summary.to_string().contains("Linked runtime language"));
        assert!(!full.to_string().contains("Linked runtime language"));
        let runtime = read(
            "get_workflow_reference",
            &json!({"topic":"codeact-runtime","detail":"full"}),
        )
        .unwrap();
        assert!(runtime.to_string().contains("Linked runtime language"));
        assert!(
            read(
                "get_workflow_reference",
                &json!({"topic":"nodes","node_types":["invented"]})
            )
            .is_err()
        );
    }

    #[test]
    fn every_planning_brief_covers_capability_limits_and_dependencies_without_configuration() {
        let nodes = read(
            "get_workflow_reference",
            &json!({"topic":"nodes","node_types":crate::module::workflow::contracts::NODE_TYPES}),
        )
        .unwrap();
        for node in nodes["nodes"].as_array().unwrap() {
            let guide = node["guide"].as_str().unwrap();
            assert!(guide.starts_with("Can: "));
            assert!(guide.contains("\nLimits: "));
            assert!(guide.contains("\nRequires: "));
            assert!(!guide.contains("export interface"));
            assert!(!guide.contains("maxIterations"));
            let contract = crate::module::workflow::contracts::node_contract(node["type"].as_str().unwrap()).unwrap();
            assert!(guide.contains(contract["planning"]["capability"].as_str().unwrap()));
        }
    }

    #[test]
    fn summary_reads_keep_full_manuals_and_examples_out_of_planning() {
        for topic in ["state", "routing", "format", "configuration"] {
            let summary = read("get_workflow_reference", &json!({"topic":topic})).unwrap();
            let full = read("get_workflow_reference", &json!({"topic":topic,"detail":"full"})).unwrap();
            assert!(summary["guide"].as_str().unwrap().len() < full["guide"].as_str().unwrap().len());
            assert_eq!(
                full,
                crate::module::assistant::workflow_agent::authoring::reference(&json!({"topic":topic})).unwrap()
            );
        }
        let examples = read(
            "get_workflow_reference",
            &json!({"topic":"examples","node_types":["codeact_agent"]}),
        )
        .unwrap();
        assert!(examples["examples"][0].get("document").is_none());
        let schema = read(
            "get_workflow_reference",
            &json!({"topic":"node-schema","node_types":["agent"]}),
        )
        .unwrap();
        assert!(schema["nodes"][0].get("dataSchema").is_none());
    }

    #[test]
    fn incomplete_node_reads_fail_instead_of_silently_returning_the_index() {
        for args in [
            json!({}),
            json!({"node_types":["end"]}),
            json!({"topic":"nodes"}),
            json!({"topic":"nodes","node_types":[]}),
            json!({"topic":"node-schema"}),
            json!({"topic":"index","node_types":["end"]}),
        ] {
            assert!(read("get_workflow_reference", &args).is_err(), "{args}");
        }
        let index = read("get_workflow_reference", &json!({"topic":"index"})).unwrap();
        assert!(
            index["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|node| node["type"] == "codeact_agent")
        );
        let nodes = read(
            "get_workflow_reference",
            &json!({"topic":"nodes","node_types":["if_else","end"]}),
        )
        .unwrap();
        assert!(nodes.get("topics").is_none());
        assert!(
            nodes["nodes"][0]["guide"]
                .as_str()
                .unwrap()
                .contains("not a business boolean output")
        );
        assert!(
            nodes["nodes"][1]["guide"]
                .as_str()
                .unwrap()
                .to_lowercase()
                .contains("does not create output")
        );
        let parameters = declarations()["get_workflow_reference"]["parameters"].clone();
        assert!(jsonschema::validate(&parameters, &json!({"node_types":["end"]})).is_err());
        assert!(jsonschema::validate(&parameters, &json!({"topic":"unknown"})).is_err());
        assert!(jsonschema::validate(&parameters, &json!({"topic":"nodes","node_types":["condition"]})).is_err());
        assert!(jsonschema::validate(&parameters, &json!({"topic":"nodes","node_types":["end"]})).is_ok());
    }

    #[test]
    fn shared_capability_knowledge_is_progressive_and_keeps_role_boundaries() {
        let main = crate::module::assistant::task_agent::skills::TaskSkills::builtin();
        let planner = super::super::skills::catalog();
        let author = crate::module::assistant::workflow_agent::skills::catalog();
        let packaged = crate::module::assistant::resources::read("reference/workrun-capabilities.md").unwrap();
        for catalog in [&*main, &planner, &author] {
            assert_eq!(catalog.read("workrun-capabilities").unwrap(), packaged);
            assert!(
                catalog
                    .summaries()
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|entry| entry["name"] == "workrun-capabilities")
            );
            assert!(
                !catalog
                    .mandatory_instructions()
                    .unwrap()
                    .contains("# Workrun capabilities")
            );
        }
        let overview = read(
            "get_workflow_reference",
            &json!({"topic":"capabilities","detail":"full"}),
        )
        .unwrap();
        assert_eq!(overview["guide"], packaged);
        let index = read("get_workflow_reference", &json!({"topic":"index"})).unwrap();
        assert!(
            index["topics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|topic| topic == "capabilities")
        );
        let author_tools = crate::module::assistant::workflow_agent::tools::declarations();
        assert!(
            jsonschema::validate(
                &author_tools["get_workflow_reference"]["parameters"],
                &json!({"topic":"capabilities"})
            )
            .is_ok()
        );
        // Sharing documentation must not expose authoring actions to the planner.
        let tools = declarations();
        for forbidden in [
            "save_workflow_draft",
            "execute_capability",
            "run_code",
            "call_workspace_tool",
        ] {
            assert!(!tools.contains_key(forbidden));
        }
    }
}
