//! Planner tools are independently constructed; no authoring/dispatch grants.
use serde_json::{Value, json};
use std::collections::HashMap;
pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    let mut tools = crate::module::assistant::workspace_resources::declarations();
    for declaration in [
        json!({"name":"get_workflow_plan","description":"Read this conversation's current plan, or an immutable proposal revision by version. Never approves or creates a workflow.","parameters":{"type":"object","properties":{"version":{"type":"integer","minimum":1}},"additionalProperties":false}}),
        json!({"name":"save_workflow_plan","description":"Save a new user-reviewable plan revision, not a Workflow. Supply document_json matching the workflow-planning Skill and base_version from get_workflow_plan (0 for first plan). Native checks identify unavailable dependencies and unauthorized attachment IDs. Unresolved questions remain visible and prevent approval. Cannot approve or execute.","parameters":{"type":"object","properties":{"document_json":{"type":"string","maxLength":65536},"base_version":{"type":"integer","minimum":0}},"required":["document_json","base_version"],"additionalProperties":false}}),
        json!({"name":"get_workflow_reference","description":"Read base-node reference progressively for planning: capabilities (shared Workrun overview), configuration (native resource wiring), examples (summaries, or matching documents with node_types), index, nodes, node-schema, format, state, routing or recovery. Select only node_types needed for this design. Do not construct or save a workflow document.","parameters":{"type":"object","properties":{"topic":{"type":"string"},"node_types":{"type":"array","items":{"type":"string"}}},"additionalProperties":false}}),
        json!({"name":"list_authoring_resources","description":"Discover model profiles; tool and Skill summaries. Retrieve selected tool contracts and Skill instructions progressively with workspace resource tools.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["models","tools","skills"]},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"list_capabilities","description":"Discover actual workflows and Apps and their exact input/output contracts for planning.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
        json!({"name":"read_artifact","description":"Inspect an authorized task attachment as bounded UTF-8 text to determine its real input structure.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}}),
        json!({"name":"read_skill","description":"Read a built-in planning Skill. Does not expose authoring/execution tools.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
        json!({"name":"report_progress","description":"Publish concise observed planning progress for the user, without hidden reasoning.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}),
    ] {
        tools.insert(declaration["name"].as_str().unwrap().into(), declaration);
    }
    tools
}
pub(in crate::module::assistant) fn read(name: &str, args: &Value) -> anyhow::Result<Value> {
    match name {
        "read_skill" => {
            Ok(json!({"content":super::skills::catalog().read(args["name"].as_str().unwrap_or_default())?}))
        },
        "get_workflow_reference" => crate::module::assistant::workflow_agent::authoring::reference(args),
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
