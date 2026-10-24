//! Supported node types are shared by compilation and authoring discovery.
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
