//! Workflow specialist tool catalog. Execution and delegation are absent by construction.
use super::authoring;
use crate::module::assistant::skills::SkillCatalog;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    let mut tools = HashMap::new();
    tools.extend(crate::module::assistant::workspace_resources::declarations());
    tools.insert("get_workflow_reference".into(),json!({"name":"get_workflow_reference","description":"Read native authoring contracts. index lists nodes/topics; nodes returns complete selected data schemas and semantics; detail=full includes full typed guides; codeact-runtime returns extended language, file and tool APIs on demand; node-schema returns exact schemas. Both require node_types. examples returns summaries with detail=summary even when node_types is supplied; omit summary to read selected documents. Manual topics honor detail=summary; full reads require a specific unresolved question. configuration with node_types is an alias for the same node contracts and supplies no extra fields; omit node_types for shared resource wiring. Other topics cover format, state, wiring and recovery.","parameters":{"type":"object","properties":{"topic":{"type":"string","enum":["index","capabilities","codeact-runtime","configuration","examples","nodes","node-schema","format","state","routing","recovery","compensation","execution-recovery"]},"node_types":{"type":"array","items":{"type":"string"}},"detail":{"type":"string","enum":["summary","full"]}},"additionalProperties":false}}));
    tools.insert("list_authoring_resources".into(),json!({"name":"list_authoring_resources","description":"Inspect one modelProfileId with model_id; omit only when selecting an alternative model. Supplied native IDs need no catalog reconfirmation.","parameters":{"type":"object","properties":{"kind":{"type":"string","enum":["models"]},"model_id":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("validate_workflow_draft".into(),json!({"name":"validate_workflow_draft","description":"Validation-only review of a Workflow document. Normal creation/revision should submit once to save_workflow_draft, which performs the same native validation before writing. Provide either document_json (JSON text containing settings,nodes,edges) or draft_id. Returns valid, structured issues with phases/paths and executed=false. Does not execute nodes or install dependencies. Compile errors can require native model/tool/App configuration.","parameters":{"type":"object","properties":{"document_json":{"type":"string"},"draft_id":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("get_workflow_draft".into(),json!({"name":"get_workflow_draft","description":"Read the current saved workflow definition by workspace-local draft_id. If opened in the editor, returns its latest catalog definition, including saved model changes. Rerun this definition directly; do not clone it just to retry. Does not execute or publish.","parameters":{"type":"object","properties":{"draft_id":{"type":"string"}},"required":["draft_id"],"additionalProperties":false}}));
    {
        tools.insert("save_workflow_draft".into(),json!({"name":"save_workflow_draft","description":"Submit and save one Workflow working definition. This tool validates node contracts and compilation BEFORE writing; no separate validate_workflow_draft call is needed. Native delegation fixes the creation ID or revision target; the model cannot select another target. Returns draft_id, capability_id and validation. No publication or execution. If validation fails, repair the returned issues and retry this tool. Limits: 256KB JSON,100 nodes,200 edges.","parameters":{"type":"object","properties":{"document_json":{"type":"string"}},"required":["document_json"],"additionalProperties":false}}));
    }

    tools.insert("read_skill".into(), json!({"name":"read_skill","description":"Read an optional workflow-specialist skill on demand. workflow-authoring is already in the instructions; do not reload it.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}));
    tools.insert("report_progress".into(), json!({"name":"report_progress","description":"Report brief observed authoring progress, without private reasoning or claims of execution.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}));
    tools.insert("list_capabilities".into(), json!({"name":"list_capabilities","description":"Search workflows and Apps by summary (paginated, without input/output schemas). Use capability_id to retrieve the full exact contract before binding inputs or reusing a capability; summaries are not contracts.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}));
    tools.insert("read_artifact".into(), json!({"name":"read_artifact","description":"Inspect an authorized task attachment as bounded UTF-8 text before choosing node configuration.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}}));
    tools
}
pub(in crate::module::assistant) fn read(skills: &SkillCatalog, name: &str, args: &Value) -> Result<Value> {
    match name {
        "read_skill" => skills.read_for_model(args["name"].as_str().unwrap_or_default()),
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
    fn specialist_catalogs_are_independent_of_task_agent_catalogs() {
        let specialist = super::super::skills::catalog();
        let main = crate::module::assistant::task_agent::skills::TaskSkills::builtin();
        assert!(main.read("workflow-authoring").is_err());
        assert!(main.read("workflow-node-agent").is_err());
        assert!(specialist.read("conversation").is_err());
        assert!(specialist.read("workflow-node-agent").is_err());
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
