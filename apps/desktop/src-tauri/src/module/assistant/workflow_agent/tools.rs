//! Workflow specialist tool catalog. Execution and delegation are absent by construction.
use super::authoring;
use crate::module::assistant::skills::SkillCatalog;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    let mut tools = HashMap::new();
    tools.extend(crate::module::assistant::workspace_resources::declarations());
    tools.insert("get_workflow_reference".into(),json!({"name":"get_workflow_reference","description":"Read Workrun authoring reference progressively. topic=index lists all supported base nodes and reference topics; nodes includes the linked runtime language/OS briefing for CodeAct and returns only selected English node skills with generated TypeScript configuration, handles and examples. node-schema returns exact JSON Schema only for requested node_types. Other topics: configuration (native resource wiring); examples lists summaries, or supply node_types to read matching native documents with resource placeholders; capabilities (shared Workrun overview), format, state, routing, recovery; compensation and execution-recovery load detailed native design references. Read workflow-authoring skill before constructing a new workflow.","parameters":{"type":"object","properties":{"topic":{"type":"string","enum":["index","capabilities","configuration","examples","nodes","node-schema","format","state","routing","recovery","compensation","execution-recovery"]},"node_types":{"type":"array","items":{"type":"string"}}},"additionalProperties":false}}));
    tools.insert("list_authoring_resources".into(),json!({"name":"list_authoring_resources","description":"Discover native modelProfileId values. Use list_workspace_tools for tools, list_workspace_skills for Skills, and list_capabilities for Apps and workflows. Never invent IDs.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["models"]},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("validate_workflow_draft".into(),json!({"name":"validate_workflow_draft","description":"Validate a Workflow document against node contracts and the actual native graph compiler using temporary checkpoint storage. Provide either document_json (JSON text containing settings,nodes,edges) or draft_id. Returns valid, structured issues with phases/paths and executed=false. Does not execute nodes or install dependencies. Compile errors can require native model/tool/App configuration.","parameters":{"type":"object","properties":{"document_json":{"type":"string"},"draft_id":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("get_workflow_draft".into(),json!({"name":"get_workflow_draft","description":"Read the current saved workflow definition by workspace-local draft_id. If opened in the editor, returns its latest catalog definition, including saved model changes. Rerun this definition directly; do not clone it just to retry. Does not execute or publish.","parameters":{"type":"object","properties":{"draft_id":{"type":"string"}},"required":["draft_id"],"additionalProperties":false}}));
    {
        tools.insert("save_workflow_draft".into(),json!({"name":"save_workflow_draft","description":"Save a valid Workflow working definition in the ordinary workspace catalog. Native delegation fixes the creation ID or revision target; the model cannot select another target. Returns draft_id, capability_id and validation. No publication or execution. Repair before saving. Limits: 256KB JSON,100 nodes,200 edges.","parameters":{"type":"object","properties":{"document_json":{"type":"string"}},"required":["document_json"],"additionalProperties":false}}));
    }

    tools.insert("read_skill".into(), json!({"name":"read_skill","description":"Read an enabled workflow-specialist skill on demand.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}));
    tools.insert("report_progress".into(), json!({"name":"report_progress","description":"Report brief observed authoring progress, without private reasoning or claims of execution.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}));
    tools.insert("list_capabilities".into(), json!({"name":"list_capabilities","description":"Discover existing workflows and Apps available for reuse. Exact IDs and resource contracts must come from native discovery.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("read_artifact".into(), json!({"name":"read_artifact","description":"Inspect an authorized task attachment as bounded UTF-8 text before choosing node configuration.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}}));
    tools
}
pub(in crate::module::assistant) fn read(skills: &SkillCatalog, name: &str, args: &Value) -> Result<Value> {
    match name {
        "read_skill" => Ok(json!({"content":skills.read(args["name"].as_str().unwrap_or_default())?})),
        "get_workflow_reference" => authoring::reference(args),
        "report_progress" => {
            let summary = args["summary"].as_str().unwrap_or_default().trim();
            anyhow::ensure!(
                !summary.is_empty() && summary.chars().count() <= 600,
                "Progress summary must contain 1-600 characters"
            );
            Ok(json!({"summary":summary}))
        },
        _ => bail!("Not a specialist reference tool: {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn specialist_catalogs_are_independent_of_main_agent_catalogs() {
        let specialist = super::super::skills::catalog();
        let main = crate::module::assistant::main_agent::skills::MainSkills::builtin();
        assert!(main.read("workflow-authoring").is_err());
        assert!(main.read("workflow-node-agent").is_err());
        assert!(specialist.read("conversation").is_err());
        assert!(specialist.read("workflow-node-agent").is_ok());
        let tools = declarations();
        for forbidden in [
            "execute_capability",
            "execute_workflow",
            "delegate_workflow",
            "run_code",
            "inspect_execution",
            "call_workspace_tool",
        ] {
            assert!(!tools.contains_key(forbidden));
        }
        assert!(tools.contains_key("save_workflow_draft"));
        for tools in [
            tools.clone(),
            crate::module::assistant::planning_agent::tools::declarations(),
        ] {
            let schema = &tools["list_authoring_resources"]["parameters"];
            assert!(jsonschema::validate(schema, &json!({"kind":"models"})).is_ok());
            for kind in ["tools", "skills"] {
                assert!(jsonschema::validate(schema, &json!({"kind":kind})).is_err());
            }
        }
        for name in ["list_workspace_tools", "list_workspace_skills", "read_workspace_skill"] {
            assert!(tools.contains_key(name));
        }
        assert!(!tools.contains_key("call_workspace_tool"));
        assert!(tools.contains_key("get_workflow_reference"));
    }
}
