//! Common contracts adapt existing executors; they do not grant new permissions.
use super::tools::Capability;
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contract {
    pub id: String,
    pub kind: &'static str,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub input_schema: Value,
    pub output_schema: Value,
    pub constraints: Value,
}
impl Contract {
    pub fn summary(&self) -> Value {
        // Discovery is not an execution contract. Fetch by ID before binding
        // inputs; keep native constraints visible even on the summary path.
        json!({"id":self.id,"kind":self.kind,"name":self.name,
            "description":self.description.chars().take(400).collect::<String>(),
            "descriptionTruncated":self.description.chars().count()>400,
            "version":self.version,"constraints":self.constraints})
    }
    pub fn legacy(&self) -> Capability {
        Capability {
            id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone(),
            parameters: self.input_schema.clone(),
        }
    }
    pub fn workflow(entry: &Value) -> Result<Self> {
        let settings = &entry["document"]["settings"];
        Ok(Self {
            id: entry["id"].as_str().context("Workflow ID missing")?.into(),
            kind: "workflow",
            name: settings["name"].as_str().context("Workflow name missing")?.into(),
            description: settings["description"].as_str().unwrap_or("").into(),
            version: entry["version"].as_str().map(str::to_owned),
            input_schema: super::catalog::parameters(settings),
            // Old workflow outputs often declare only keys. An unknown type is
            // deliberately unconstrained instead of falsely claiming string.
            output_schema: interface_output(settings),
            constraints: json!({"executable":true,"executor":"workflow","effects":"unspecified"}),
        })
    }
}
pub fn interface_output(settings: &Value) -> Value {
    settings.get("capabilityOutputSchema").cloned().unwrap_or_else(|| {
        let mut schema = super::catalog::parameters(&json!({"inputSchema":settings["outputSchema"]}));
        for field in settings["outputSchema"]["fields"].as_array().into_iter().flatten() {
            if field.get("type").is_none()
                && let Some(key) = field["key"].as_str()
            {
                schema["properties"][key] = json!({});
            }
        }
        schema
    })
}
pub(super) fn validated_output(workflow: &Value, state: &Value) -> Result<Value> {
    let schema = interface_output(&workflow["document"]["settings"]);
    let mut output = serde_json::Map::new();
    for key in schema["properties"]
        .as_object()
        .context("Output properties missing")?
        .keys()
    {
        if let Some(value) = state["global"].get(key) {
            output.insert(key.clone(), value.clone());
        }
    }
    let output = Value::Object(output);
    ensure!(
        jsonschema::validator_for(&schema)?.is_valid(&output),
        "Execution output does not match capability contract"
    );
    // Keep complete, reusable values or reject export; truncating JSON would
    // silently change downstream inputs. Large content should use ArtifactRefs.
    ensure!(
        serde_json::to_vec(&output)?.len() <= 24_000,
        "Capability output exceeds inline limit; use artifact references"
    );
    Ok(output)
}
pub fn app_contract(app: &crate::module::process_node::ProcessNode) -> Contract {
    use crate::{config::ProcessNodeKind, module::process_node::ProcessNodeInstallStatus};
    let node = &app.definition;
    let executable =
        node.kind == ProcessNodeKind::Workflow && matches!(app.install_status, ProcessNodeInstallStatus::Installed);
    Contract {
        // App IDs are namespaced; workflow IDs remain compatible with sessions.
        id: format!("app:{}", node.id),
        kind: "app",
        name: node.name.clone(),
        description: node.description.clone(),
        version: Some(node.version.clone()),
        input_schema: crate::module::process_node::contract_schema(&node.inputs),
        output_schema: crate::module::process_node::contract_schema(&node.outputs),
        constraints: json!({"executable":executable,"executor":"workflow","appKind":node.kind,"installation":app.install_status,"executionPolicy":node.tool_execution_policy,"riskLevel":node.tool_risk_level,"permissions":node.tool_permissions,"effects":"unspecified","reason":if node.kind == ProcessNodeKind::Tool {Some("Tool Apps require an Agent tool confirmation context")} else if !executable {Some("Install the App before execution")} else {None}}),
    }
}
pub fn app_workflow(app: &crate::module::process_node::ProcessNode) -> Result<Value> {
    let contract = app_contract(app);
    ensure!(
        contract.constraints["executable"] == true,
        "App is not executable in this context"
    );
    let fields = contract.input_schema["properties"].as_object().context("App input schema missing")?.iter().map(|(key,schema)| {
        json!({"key":key,"label":key,"type":match schema["type"].as_str() {Some("number"|"integer")=>"number",Some("boolean")=>"boolean",_=>"text"},"required":contract.input_schema["required"].as_array().is_some_and(|items|items.contains(&json!(key)))})
    }).collect::<Vec<_>>();
    let keys = contract.output_schema["properties"]
        .as_object()
        .context("App output schema missing")?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({"id":contract.id,"capability":contract,"document":{"settings":{"name":app.definition.name,"description":app.definition.description,"mode":"task","inputSchema":{"fields":fields},"outputSchema":{"fields":keys.iter().map(|key|json!({"key":key})).collect::<Vec<_>>()},"capabilityInputSchema":contract.input_schema,"capabilityOutputSchema":contract.output_schema},"nodes":[{"id":"start","type":"start","data":{}},{"id":"app","type":"process","data":{"name":app.definition.name,"processNodeId":app.definition.id,"state":{"globalKeys":keys}}},{"id":"end","type":"end","data":{}}],"edges":[{"source":"start","target":"app"},{"source":"app","target":"end"}]}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        config::IProcessNode,
        module::process_node::{ProcessNode, ProcessNodeInstallStatus},
    };
    #[test]
    fn discovery_summaries_are_bounded_without_changing_exact_contracts() {
        let contract = Contract {
            id: "capability-1".into(),
            kind: "workflow",
            name: "Analysis".into(),
            description: "说明".repeat(1000),
            version: Some("v2".into()),
            input_schema: json!({"type":"object","properties":{"file":{"type":"string","description":"private full schema"}},"required":["file"]}),
            output_schema: json!({"type":"object","properties":{"report":{"type":"string"}}}),
            constraints: json!({"executable":false,"reason":"Install first"}),
        };
        let summary = contract.summary();
        assert_eq!(summary["id"], contract.id);
        assert_eq!(summary["version"], "v2");
        assert_eq!(summary["constraints"], contract.constraints);
        assert_eq!(summary["description"].as_str().unwrap().chars().count(), 400);
        assert_eq!(summary["descriptionTruncated"], true);
        assert!(summary.get("inputSchema").is_none());
        assert!(summary.get("outputSchema").is_none());
        let exact = serde_json::to_value(&contract).unwrap();
        assert_eq!(exact["inputSchema"]["required"], json!(["file"]));
        assert_eq!(exact["outputSchema"], contract.output_schema);
        assert!(summary.to_string().len() < exact.to_string().len());
    }
    fn app() -> ProcessNode {
        let definition:IProcessNode=serde_json::from_value(json!({"id":"019b812d-4958-7d37-8a45-47e1e20a4744","name":"Review","description":"Local review","version":"1.0.0","entry":"main.py","inputs":{"amount":{"type":"number"},"locale":{"type":"string","default":"zh","x-workrun-optional":true}},"outputs":{"review":{"type":"boolean"}}})).unwrap();
        ProcessNode {
            definition,
            project_path: "/unused-test-project".into(),
            install_status: ProcessNodeInstallStatus::Installed,
            install_error: None,
        }
    }
    #[tokio::test]
    async fn app_adapter_preserves_contract_and_compiles_existing_process_executor() {
        let app = app();
        let contract = app_contract(&app);
        assert_eq!(contract.kind, "app");
        assert_eq!(contract.input_schema["required"], json!(["amount"]));
        assert_eq!(contract.input_schema["properties"]["locale"]["default"], "zh");
        let workflow = app_workflow(&app).unwrap();
        let settings = &workflow["document"]["settings"];
        assert!(super::super::catalog::validate_input(settings, &json!({"amount":1500})).unwrap());
        assert!(super::super::catalog::validate_input(settings, &json!({"amount":"1500"})).is_err());
        let nullable = json!({"capabilityInputSchema":{"type":"object","properties":{"value":{"type":["number","null"]}},"required":["value"],"additionalProperties":false}});
        assert!(super::super::catalog::validate_input(&nullable, &json!({"value":null})).unwrap());
        assert!(!super::super::catalog::validate_input(&nullable, &json!({})).unwrap());
        assert!(validated_output(&workflow, &json!({"global":{"review":"yes"}})).is_err());
        assert_eq!(
            validated_output(&workflow, &json!({"global":{"review":true,"private":42}})).unwrap(),
            json!({"review":true})
        );
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("checkpoint.db");
        std::fs::File::create(&file).unwrap();
        let dsl = super::super::catalog::document_dsl(&workflow).unwrap();
        crate::module::workflow::TEST_CHECKPOINT_DB
            .scope(
                format!("sqlite://{}", file.display()),
                crate::module::workflow::compile(serde_json::from_value(dsl).unwrap(), &Default::default(), None),
            )
            .await
            .unwrap();
    }
    #[test]
    fn unavailable_and_tool_apps_cannot_bypass_existing_execution_policy() {
        let mut app = app();
        app.install_status = ProcessNodeInstallStatus::NotInstalled;
        assert!(app_workflow(&app).is_err());
        app.install_status = ProcessNodeInstallStatus::Installed;
        app.definition.kind = crate::config::ProcessNodeKind::Tool;
        assert_eq!(app_contract(&app).constraints["executable"], false);
        assert!(app_workflow(&app).is_err());
    }
    #[test]
    fn workflow_outputs_preserve_declared_types_and_inline_limit() {
        let workflow = json!({"document":{"settings":{"outputSchema":{"fields":[{"key":"amount","type":"number","required":true},{"key":"legacy"}]}}}});
        assert!(validated_output(&workflow, &json!({"global":{"amount":"1500"}})).is_err());
        assert!(validated_output(&workflow, &json!({"global":{}})).is_err());
        assert_eq!(
            validated_output(
                &workflow,
                &json!({"global":{"amount":1500,"legacy":false,"private":42}})
            )
            .unwrap(),
            json!({"amount":1500,"legacy":false})
        );
        assert!(
            validated_output(
                &workflow,
                &json!({"global":{"amount":1500,"legacy":"x".repeat(24_001)}})
            )
            .is_err()
        );
    }
}
