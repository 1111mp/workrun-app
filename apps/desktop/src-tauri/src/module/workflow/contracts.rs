//! Node schemas are generated from editor workflow.d.ts; metadata adds runtime constraints.
use anyhow::{Context, Result};
use serde_json::Value;

pub const NODE_TYPES: &[&str] = &[
    "start",
    "end",
    "agent",
    "codeact_agent",
    "remote_agent",
    "process",
    "if_else",
    "switch",
    "human_review",
    "ask_user_question",
    "subworkflow",
    "terminate",
    "group",
];
pub fn node_contract(kind: &str) -> Result<Value> {
    let contracts: Value = serde_json::from_str(include_str!("node-contracts.json"))?;
    contracts.get(kind).cloned().context("Unknown workflow node type")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_supported_node_has_a_valid_schema_and_example() {
        let contracts: Value = serde_json::from_str(include_str!("node-contracts.json")).unwrap();
        assert_eq!(contracts.as_object().unwrap().len(), NODE_TYPES.len());
        for kind in NODE_TYPES {
            let contract = node_contract(kind).unwrap();
            assert!(
                jsonschema::validator_for(&contract["dataSchema"])
                    .unwrap()
                    .is_valid(&contract["example"]["data"]),
                "invalid example for {kind}"
            );
            assert!(!contract["guide"].as_str().unwrap().is_empty());
        }
    }
    #[test]
    fn agent_contracts_reject_label_unknown_fields_and_missing_editor_fields() {
        for kind in ["agent", "codeact_agent"] {
            let contract = node_contract(kind).unwrap();
            let validator = jsonschema::validator_for(&contract["dataSchema"]).unwrap();
            let valid = serde_json::json!({"name":"Agent","description":"","instruction":"Review inputs","modelProfileId":"model"});
            assert!(validator.is_valid(&valid));
            for field in ["name", "description", "instruction", "modelProfileId"] {
                let mut missing = valid.clone();
                missing.as_object_mut().unwrap().remove(field);
                assert!(!validator.is_valid(&missing), "{kind} must require {field}");
            }
            for field in ["label", "unexpected"] {
                let mut invalid = valid.clone();
                invalid[field] = serde_json::json!("not an editor field");
                assert!(!validator.is_valid(&invalid), "{kind} must reject {field}");
            }
        }
    }

    #[test]
    fn generated_remote_authentication_preserves_credential_constraints() {
        let contract = node_contract("remote_agent").unwrap();
        let validator = jsonschema::validator_for(&contract["dataSchema"]).unwrap();
        let mut data = serde_json::json!({"name":"Remote","description":"","url":"https://fixture.invalid","authentication":{"type":"none"}});
        assert!(validator.is_valid(&data));
        data["authentication"] = serde_json::json!({"type":"bearer","credentialId":""});
        assert!(!validator.is_valid(&data));
        data["authentication"] = serde_json::json!({"type":"apiKey","credentialId":"credential","headerName":""});
        assert!(!validator.is_valid(&data));
        data["authentication"]["headerName"] = serde_json::json!("X-API-Key");
        assert!(validator.is_valid(&data));
    }

    #[test]
    fn node_directory_matches_the_editor_node_types() {
        let source = include_str!("../../../../src/components/workflow.d.ts");
        let union = source
            .split("type WorkflowNodeType =")
            .nth(1)
            .unwrap()
            .split(';')
            .next()
            .unwrap();
        let editor = union
            .split('\'')
            .enumerate()
            .filter_map(|(index, value)| (index % 2 == 1).then_some(value))
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(editor, NODE_TYPES.iter().copied().collect());
    }
}
