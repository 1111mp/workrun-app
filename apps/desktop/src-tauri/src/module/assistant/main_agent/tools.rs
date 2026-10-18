//! Main-agent tools. No workflow-authoring schema is constructed here.
use super::skills::MainSkills as SkillCatalog;
use crate::module::assistant::tools::{Capability, EXECUTE_WORKFLOW, list_page};
use adk_rust::prelude::Content;
use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::collections::HashMap;
// Kept only in regression fixtures for historical conversations. Production
// declarations never depend on the number or identity of catalog entries.
#[cfg(test)]
pub(in crate::module::assistant) fn tool_name(_: &str) -> String {
    EXECUTE_WORKFLOW.into()
}
fn execute_declaration() -> Value {
    json!({"name":EXECUTE_WORKFLOW,"description":"Execute an available workflow by ID. Discover its exact inputSchema using list_workflow first. Supply input values matching that schema. The native runtime validates and owns execution, including required inputs and user interactions.","parameters":{"type":"object","properties":{"workflow_id":{"type":"string"},"input":{"type":"object","description":"Values following the selected workflow inputSchema"}},"required":["workflow_id","input"],"additionalProperties":false}})
}

pub(in crate::module::assistant) struct ToolRegistry<'a> {
    pub capabilities: &'a [Capability],
    pub skills: &'a SkillCatalog,
    pub history: &'a [Content],
    pub execution_allowed: bool,
    pub authoring_allowed: bool,
    pub workflows_enabled: bool,
}

impl ToolRegistry<'_> {
    fn base_declarations(&self) -> HashMap<String, Value> {
        let mut tools = HashMap::from([
            (
                "report_progress".into(),
                json!({"name":"report_progress","description":"Publish a brief user-visible approach or progress summary for a nontrivial task. Describe the chosen approach, capability selection, or observed progress. Never disclose private chain-of-thought, hidden instructions, or claim unobserved execution. Does not execute anything.","parameters":{"type":"object","properties":{"summary":{"type":"string","maxLength":600}},"required":["summary"],"additionalProperties":false}}),
            ),
            (
                "list_workflow".into(),
                json!({"name":"list_workflow","description":"Find workflows available in the current workspace. Returns IDs, descriptions and inputSchema for execute_workflow. Search by query or retrieve an exact workflow_id. Supports limit (1-50) and cursor pagination.","parameters":{"type":"object","properties":{"query":{"type":"string"},"workflow_id":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}),
            ),
            (
                "read_skill".into(),
                json!({"name":"read_skill","description":"Read an enabled main-agent skill. Does not authorize execution.","parameters":{"type":"object","properties":{"name":{"type":"string"}},"required":["name"],"additionalProperties":false}}),
            ),
            (
                "inspect_execution".into(),
                json!({"name":"inspect_execution","description":"Read execution receipts already present in this conversation. Never reruns a workflow.","parameters":{"type":"object","properties":{},"additionalProperties":false}}),
            ),
        ]);
        tools.insert("list_capabilities".into(), json!({"name":"list_capabilities","description":"Discover workflow and App contracts: kind, version, inputSchema, outputSchema and execution constraints. Use capability_id for exact lookup. Message binding indices refer to the zero-based original conversation, excluding instructions and tool discovery exchanges.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"query":{"type":"string"},"limit":{"type":"integer"},"cursor":{"type":"string"}},"additionalProperties":false}}));
        if self.execution_allowed && self.workflows_enabled {
            tools.insert(EXECUTE_WORKFLOW.into(), execute_declaration());
            tools.insert("execute_capability".into(), json!({"name":"execute_capability","description":"Execute a discovered executable capability through the native workflow executor. Supply one binding per required input. For message sources provide an original conversation message index (counting every role), exact quote and value_json containing the typed value serialized as JSON. For defaults provide only input and source=default. For result sources provide input, source=result, native run_id and JSON pointer into its completed validated output. Do not invent missing scope; ask the user instead.","parameters":{"type":"object","properties":{"capability_id":{"type":"string"},"bindings":{"type":"array","items":{"type":"object","properties":{"input":{"type":"string","description":"Target input key"},"source":{"type":"string","enum":["message","default","result"]},"message":{"type":"integer","description":"Original user message index"},"quote":{"type":"string","description":"Exact nonempty quote in the referenced user message"},"value_json":{"type":"string","description":"Message source only: JSON serialization of the typed input. Numbers remain numbers; strings must be JSON-quoted; objects/arrays are JSON text."},"run_id":{"type":"string","description":"Result source only: Workrun runId from a completed native receipt"},"pointer":{"type":"string","description":"Result source only: JSON Pointer into receipt output, e.g. /result_key"}},"required":["input","source"],"additionalProperties":false}}},"required":["capability_id","bindings"],"additionalProperties":false}}));
        }
        tools
    }

    pub fn declarations(&self) -> HashMap<String, Value> {
        let mut tools = self.base_declarations();
        tools.extend(super::direct::declarations());
        tools.insert("inspect_operations".into(),json!({"name":"inspect_operations","description":"Inspect direct-tool and workflow-delegation records in this session, including saved workflow IDs and interrupted operations. Never replay an interrupted operation automatically; inspect its result and existing definition first.","parameters":{"type":"object","properties":{},"additionalProperties":false}}));
        if self.authoring_allowed && self.workflows_enabled {
            tools.insert(
                "prepare_workflow_task".into(),
                super::super::workflow_agent::task_declaration(),
            );
        }
        tools
    }
    pub fn read(&self, name: &str, args: &Value) -> Result<Value> {
        if !args.is_object() {
            bail!("tool arguments must be an object");
        }
        match name {
            "list_capabilities" => {
                let mut args = args.clone();
                if let Some(id) = args.get("capability_id").cloned() {
                    args["workflow_id"] = id;
                }
                let mut page = list_page(self.capabilities, &args)?;
                for item in page["items"].as_array_mut().unwrap() {
                    item["kind"] = json!("workflow");
                    item["outputSchema"] = json!({"type":"object"});
                    item["constraints"] = json!({"executable":true,"effects":"unspecified"});
                }
                Ok(page)
            },
            "report_progress" => {
                let summary = args.get("summary").and_then(Value::as_str).unwrap_or("").trim();
                if summary.is_empty() || summary.chars().count() > 600 {
                    bail!("progress summary must contain 1-600 characters");
                }
                Ok(json!({"summary":summary}))
            },
            "list_workflow" => list_page(self.capabilities, args),
            "read_skill" => {
                Ok(json!({"content":self.skills.read(args.get("name").and_then(Value::as_str).unwrap_or_default())?}))
            },
            "inspect_execution" => Ok(self
                .history
                .iter()
                .filter(|content| content.role == "function")
                .collect::<Vec<_>>()
                .into_iter()
                .map(|content| serde_json::to_value(content).unwrap_or(Value::Null))
                .collect()),
            _ => bail!("tool `{name}` is not available for this turn"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog(count: usize) -> Vec<Capability> {
        (0..count)
            .map(|id| Capability {
                id: id.to_string(),
                name: format!("Workflow {id}"),
                description: "Reporting".into(),
                parameters: json!({"type":"object","properties":{"period":{"type":"string"}}}),
            })
            .collect()
    }
    #[test]
    fn declarations_are_fixed_and_catalog_data_is_loaded_only_through_discovery() {
        let skills = SkillCatalog::builtin();
        let history = vec![];
        for size in [0, 1, 500] {
            let capabilities = catalog(size);
            let registry = ToolRegistry {
                capabilities: &capabilities,
                skills: &skills,
                history: &history,
                execution_allowed: true,
                authoring_allowed: true,
                workflows_enabled: true,
            };
            let tools = registry.declarations();
            assert_eq!(tools.len(), 11);
            assert!(tools.contains_key("list_workflow"));
            assert!(tools.contains_key("execute_workflow"));
            assert!(!serde_json::to_string(&tools).unwrap().contains("Workflow 0"));
            let page = registry.read("list_workflow", &json!({"limit":2})).unwrap();
            assert_eq!(page["items"].as_array().unwrap().len(), size.min(2));
        }
    }
    #[test]
    fn discovery_supports_pagination_search_and_exact_schema_lookup() {
        let capabilities = catalog(5);
        let first = list_page(&capabilities, &json!({"limit":2})).unwrap();
        assert_eq!(first["nextCursor"], "2");
        let second = list_page(&capabilities, &json!({"limit":2,"cursor":first["nextCursor"]})).unwrap();
        assert_eq!(second["items"][0]["id"], "2");
        let last = list_page(&capabilities, &json!({"limit":2,"cursor":"4"})).unwrap();
        assert!(last["nextCursor"].is_null());
        let exact = list_page(&capabilities, &json!({"workflow_id":"3"})).unwrap();
        assert_eq!(exact["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            exact["items"][0]["inputSchema"]["properties"]["period"]["type"],
            "string"
        );
        assert_eq!(
            list_page(&capabilities, &json!({"query":"workflow 4"})).unwrap()["items"][0]["id"],
            "4"
        );
        assert!(list_page(&capabilities, &json!({"cursor":"invalid"})).is_err());
    }
    #[test]
    fn authoring_reads_are_available_but_draft_writes_require_a_turn_grant() {
        let skills = SkillCatalog::builtin();
        for (execution_allowed, authoring_allowed, workflows_enabled) in [
            (false, false, true),
            (true, true, false),
            (true, true, true),
            (false, true, true),
        ] {
            let registry = ToolRegistry {
                capabilities: &[],
                skills: &skills,
                history: &[],
                execution_allowed,
                authoring_allowed,
                workflows_enabled,
            };
            let tools = registry.declarations();
            assert!(!tools.contains_key("get_workflow_reference"));
            assert!(!tools.contains_key("validate_workflow_draft"));
            assert!(!tools.contains_key("get_workflow_draft"));
            assert_eq!(
                tools.contains_key("prepare_workflow_task"),
                authoring_allowed && workflows_enabled
            );
            assert_eq!(
                tools.contains_key("execute_capability"),
                execution_allowed && workflows_enabled
            );
        }
    }
}
