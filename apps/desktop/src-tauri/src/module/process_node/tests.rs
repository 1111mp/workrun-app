use super::*;
use crate::module::tool_registry::{ToolRiskLevel, ToolSource};
use std::collections::BTreeMap;

fn definition() -> ProcessNodeDefinition {
    ProcessNodeDefinition {
        id: "019b812d-4958-7d37-8a45-47e1e20a4744".into(),
        name: "Web Search".into(),
        description: "Search the web".into(),
        version: "0.1.0".into(),
        created_at: "2026-01-01T00:00:00+00:00".into(),
        updated_at: "2026-01-01T00:00:00+00:00".into(),
        entry: "main.py".into(),
        project_root: None,
        kind: ProcessNodeKind::Workflow,
        tool_execution_policy: ToolExecutionPolicy::AskEveryTime,
        tool_risk_level: ToolRiskLevel::Low,
        tool_permissions: Vec::new(),
        inputs: BTreeMap::from([("query".into(), serde_json::json!({ "type": "string" }))]),
        outputs: BTreeMap::new(),
    }
}

#[test]
fn catalog_rejects_noncanonical_and_duplicate_ids() {
    let mut invalid = definition();
    invalid.id = "019B812D-4958-7D37-8A45-47E1E20A4744".into();
    assert!(validate_catalog(&ProcessNodeCatalog { nodes: vec![invalid] }).is_err());

    let duplicate = definition();
    assert!(
        validate_catalog(&ProcessNodeCatalog {
            nodes: vec![definition(), duplicate],
        })
        .is_err()
    );
}

#[test]
fn tool_definition_requires_input_and_output_schemas() {
    let mut tool = definition();
    tool.kind = ProcessNodeKind::Tool;
    tool.outputs = BTreeMap::from([("result".into(), serde_json::json!({ "type": "string" }))]);

    let tool_definition = process_tool_definition(tool).unwrap();
    assert_eq!(tool_definition.id, "019b812d-4958-7d37-8a45-47e1e20a4744");
    assert_eq!(tool_definition.source, ToolSource::Process);
    assert_eq!(tool_definition.version, "0.1.0");
    assert_eq!(tool_definition.risk_level, ToolRiskLevel::Low);
    assert!(tool_definition.permissions.is_empty());
    assert_eq!(tool_definition.name, "process_019b812d_4958_7d37_8a45_47e1e20a4744");
    assert_eq!(tool_definition.input_schema["required"], serde_json::json!(["query"]));

    let mut invalid = definition();
    invalid.kind = ProcessNodeKind::Tool;
    assert!(process_tool_definition(invalid).is_err());
}

#[test]
fn tool_schema_allows_fields_marked_optional() {
    let mut tool = definition();
    tool.kind = ProcessNodeKind::Tool;
    tool.inputs.insert(
        "locale".into(),
        serde_json::json!({ "type": "string", "x-workrun-optional": true }),
    );
    tool.outputs = BTreeMap::from([
        ("temperatureC".into(), serde_json::json!({ "type": "number" })),
        (
            "observationId".into(),
            serde_json::json!({ "type": "string", "x-workrun-optional": true }),
        ),
    ]);

    let tool = process_tool_definition(tool).unwrap();
    assert_eq!(tool.input_schema["required"], serde_json::json!(["query"]));
    assert_eq!(tool.output_schema["required"], serde_json::json!(["temperatureC"]));
    assert!(
        tool.input_schema["properties"]["locale"]
            .get("x-workrun-optional")
            .is_none()
    );
}

#[test]
fn rejects_a_default_value_that_does_not_match_its_schema() {
    let mut node = definition();
    node.inputs.insert(
        "max_commits".into(),
        serde_json::json!({ "type": "integer", "default": "250" }),
    );

    assert!(validate_definition(&node).is_err());
}

#[test]
fn legacy_catalog_entries_default_to_workflow_apps() {
    let mut value = serde_json::to_value(definition()).unwrap();
    value.as_object_mut().unwrap().remove("kind");

    let parsed: ProcessNodeDefinition = serde_json::from_value(value).unwrap();
    assert_eq!(parsed.kind, ProcessNodeKind::Workflow);
}

#[test]
fn project_root_must_be_absolute() {
    let mut node = definition();
    node.project_root = Some("projects/my-app".into());
    assert!(validate_definition(&node).is_err());

    node.project_root = Some(std::env::temp_dir().join("my-app"));
    assert!(validate_definition(&node).is_ok());
}

#[test]
fn project_path_is_nested_under_the_configured_root() {
    let mut node = definition();
    let root = std::env::temp_dir().join("workrun-apps");
    node.project_root = Some(root.clone());

    assert_eq!(ProcessNodeRegistry::project_path(&node).unwrap(), root.join(&node.id));
}

#[tokio::test]
async fn installation_status_only_checks_for_a_project_directory() {
    let project = std::env::temp_dir().join(format!("workrun-process-node-{}", uuid::Uuid::new_v4()));
    let (status, error) = installation_status(&project).await;
    assert!(matches!(status, ProcessNodeInstallStatus::NotInstalled));
    assert!(error.is_none());

    tokio::fs::create_dir_all(&project).await.unwrap();
    let (status, error) = installation_status(&project).await;
    assert!(matches!(status, ProcessNodeInstallStatus::Installed));
    assert!(error.is_none());

    tokio::fs::remove_dir_all(project).await.unwrap();
}
