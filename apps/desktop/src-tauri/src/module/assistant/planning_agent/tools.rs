//! Planner tools are independently constructed; no authoring/dispatch grants.
use serde_json::{Value, json};
use std::collections::HashMap;
pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    let mut tools = crate::module::assistant::workspace_resources::declarations();
    for declaration in [
        json!({"name":"get_workflow_plan","description":"Read this conversation's current plan, or an immutable proposal revision by version. Never approves or creates a workflow.","parameters":{"type":"object","properties":{"version":{"type":"integer","minimum":1}},"additionalProperties":false}}),
        json!({"name":"save_workflow_plan","description":"Save a new user-reviewable plan revision, not a Workflow. Supply document_json matching the workflow-planning Skill and base_version from get_workflow_plan (0 for first plan). Native checks identify unavailable dependencies and unauthorized attachment IDs. Unresolved questions remain visible and prevent approval. Cannot approve or execute.","parameters":{"type":"object","properties":{"document_json":{"type":"string","maxLength":65536},"base_version":{"type":"integer","minimum":0}},"required":["document_json","base_version"],"additionalProperties":false}}),
        json!({"name":"get_workflow_reference","description":"Read base-node reference progressively for planning: capabilities (shared Workrun overview), configuration (native resource wiring), examples (summaries, or matching documents with node_types), index, nodes, node-schema, format, state, routing or recovery. For nodes, provide nonempty node_types, e.g. {topic:nodes,node_types:[codeact_agent]}. Default detail=summary returns semantic guides without authoring schemas/examples; use detail=full only for an unresolved feasibility question. Select only node_types needed for this design. Do not construct or save a workflow document.","parameters":{"type":"object","properties":{"topic":{"type":"string"},"node_types":{"type":"array","items":{"type":"string"}},"detail":{"type":"string","enum":["summary","full"]}},"additionalProperties":false}}),
        json!({"name":"list_authoring_resources","description":"Discover native modelProfileId values. Discover tools and Skills with workspace resource tools.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["models"]},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"list_capabilities","description":"Search workflows and Apps by summary (paginated, without input/output schemas). Use capability_id to retrieve the full exact contract before binding inputs or reusing a capability; summaries are not contracts.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"read_artifact","description":"Inspect an authorized task attachment as bounded UTF-8 text to determine its real input structure.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}}),
        json!({"name":"read_skill","description":"Read an optional built-in planning Skill. workflow-planning is already supplied in the initial instructions; do not reload it. Does not expose authoring/execution tools.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
        json!({"name":"report_progress","description":"Publish concise observed planning progress for the user, without hidden reasoning.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}),
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
            if matches!(args["topic"].as_str(), Some("nodes" | "node-schema"))
                && args["node_types"].as_array().is_none_or(Vec::is_empty)
            {
                // Discovery without a selection should return useful summaries,
                // not force an avoidable model correction just to find node IDs.
                return reference(&json!({"topic":"index"}));
            }
            let mut value = reference(args)?;
            if args["topic"] == "nodes" && args["detail"] != "full" {
                if let Some(nodes) = value["nodes"].as_array_mut() {
                    for node in nodes {
                        if let Some(guide) = node["guide"].as_str() {
                            let semantics = guide.split("\n## Configuration").next().unwrap_or(guide);
                            // The runtime briefing is appended after configuration in the
                            // author guide. Keep it, so planning needn't reload full schemas
                            // merely to establish supported language/modules and file access.
                            let runtime = guide
                                .find("## Linked runtime language and OS briefing")
                                .map(|offset| &guide[offset..]);
                            node["guide"] = json!(match runtime {
                                Some(runtime) => format!("{semantics}\n\n{runtime}"),
                                None => semantics.to_owned(),
                            });
                        }
                    }
                }
                value["detail"] = json!("planning_semantics");
                value["next"] = json!(
                    "Feasibility semantics and any linked runtime briefing are included. Leave field schemas, examples and exact setup to the author; do not reload full configuration merely to inspect runtime support."
                );
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
        let shared = crate::module::assistant::workflow_agent::authoring::reference(&args).unwrap();
        assert_eq!(full, shared);
        assert!(summary["nodes"][0]["guide"].as_str().unwrap().contains("Monty"));
        assert!(!summary.to_string().contains("export interface"));
        assert!(full.to_string().contains("export interface"));
        assert!(summary.to_string().len() < full.to_string().len());
        assert!(
            summary["nodes"][0]["guide"]
                .as_str()
                .unwrap()
                .ends_with(&crate::module::workflow::codeact_agent::codeact_environment_guide())
        );
        assert!(
            read(
                "get_workflow_reference",
                &json!({"topic":"nodes","node_types":["invented"]})
            )
            .is_err()
        );
    }

    #[test]
    fn node_discovery_without_a_selection_returns_the_index_instead_of_an_error() {
        let index = read("get_workflow_reference", &json!({"topic":"nodes"})).unwrap();
        assert!(
            index["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|node| node["type"] == "codeact_agent")
        );
        assert!(index["next"].as_str().unwrap().contains("node_types"));
        assert!(index.get("error").is_none());
    }

    #[test]
    fn shared_capability_knowledge_is_progressive_and_keeps_role_boundaries() {
        let main = crate::module::assistant::main_agent::skills::MainSkills::builtin();
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
        let overview = read("get_workflow_reference", &json!({"topic":"capabilities"})).unwrap();
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
