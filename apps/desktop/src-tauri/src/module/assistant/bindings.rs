//! Resolve values from native conversation records, never model-authored receipts.
use adk_rust::prelude::{Content, Part};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "snake_case", deny_unknown_fields)]
enum Binding {
    Message {
        message: usize,
        quote: String,
        value: Value,
    },
    Default,
    Result {
        run_id: String,
        pointer: String,
    },
}
pub(super) fn resolve(schema: &Value, bindings: &Value, history: &[Content]) -> Result<Value> {
    // A list with fixed fields survives provider schema adapters which cannot
    // represent dynamic maps. Accept old map fixtures without weakening checks.
    let normalized;
    let bindings = if let Some(items) = bindings.as_array() {
        let mut map = Map::new();
        for item in items {
            let mut item = item.as_object().context("Binding must be an object")?.clone();
            let key = item
                .remove("input")
                .and_then(|v| v.as_str().map(str::to_owned))
                .context("Binding input key missing")?;
            if let Some(value) = item.remove("value_json") {
                let parsed: Value = serde_json::from_str(value.as_str().context("value_json must be a JSON string")?)
                    .context("value_json contains invalid JSON")?;
                ensure!(!item.contains_key("value"), "Binding contains competing values");
                item.insert("value".into(), parsed);
            }
            ensure!(map.insert(key, Value::Object(item)).is_none(), "Duplicate bound input");
        }
        normalized = Value::Object(map);
        &normalized
    } else {
        bindings
    };
    let bindings: BTreeMap<String, Binding> =
        serde_json::from_value(bindings.clone()).context("Invalid input bindings")?;
    let properties = schema["properties"]
        .as_object()
        .context("Capability input properties missing")?;
    let mut values = Map::new();
    for (key, binding) in bindings {
        let field = properties.get(&key).context("Unknown bound input")?;
        let value = match binding {
            Binding::Message { message, quote, value } => {
                let content = history
                    .get(message)
                    .filter(|c| c.role == "user")
                    .context("Input evidence must reference a user message")?;
                let text = content
                    .parts
                    .iter()
                    .filter_map(|p| {
                        if let Part::Text { text } = p {
                            Some(text.as_str())
                        } else {
                            None
                        }
                    })
                    .collect::<String>();
                // Evidence anchors extraction/normalization (e.g. 本周 -> this_week).
                // This checks provenance, not semantic equivalence of the value.
                ensure!(
                    !quote.trim().is_empty() && text.contains(&quote),
                    "Input evidence quote not found"
                );
                value
            },
            Binding::Default => field.get("default").cloned().context("Input has no declared default")?,
            Binding::Result { run_id, pointer } => {
                ensure!(
                    pointer.is_empty() || pointer.starts_with('/'),
                    "Result pointer must be a JSON Pointer"
                );
                let receipts = history
                    .iter()
                    .filter(|c| c.role == "function")
                    .flat_map(|c| &c.parts)
                    .filter_map(|p| match p {
                        Part::FunctionResponse { function_response, .. }
                            if function_response.response["runId"].as_str() == Some(run_id.as_str()) =>
                        {
                            Some(&function_response.response)
                        },
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                ensure!(receipts.len() == 1, "Result binding must identify one native receipt");
                let receipt = receipts[0];
                ensure!(
                    receipt["status"] == "completed",
                    "Result binding requires a completed execution"
                );
                receipt
                    .get("output")
                    .context("Receipt has no validated capability output")?
                    .pointer(&pointer)
                    .cloned()
                    .context("Result field missing")?
            },
        };
        ensure!(
            jsonschema::validator_for(field)?.is_valid(&value),
            "Bound input `{key}` does not match its schema"
        );
        values.insert(key, value);
    }
    let value = Value::Object(values);
    ensure!(
        jsonschema::validator_for(schema)?.is_valid(&value),
        "Required capability inputs are missing or invalid; ask the user"
    );
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn schema() -> Value {
        json!({"type":"object","properties":{"amount":{"type":"number","minimum":0},"locale":{"type":"string","default":"zh"}},"required":["amount"],"additionalProperties":false})
    }
    #[test]
    fn user_evidence_and_declared_defaults_preserve_types() {
        let history = vec![Content::new("user").with_text("审核金额1500")];
        let bindings = json!({"amount":{"source":"message","message":0,"quote":"1500","value":1500},"locale":{"source":"default"}});
        assert_eq!(
            resolve(&schema(), &bindings, &history).unwrap(),
            json!({"amount":1500,"locale":"zh"})
        );
        for bad in [
            json!({"amount":{"source":"default"}}),
            json!({"amount":{"source":"message","message":0,"quote":"999","value":999}}),
            json!({"amount":{"source":"message","message":0,"quote":"1500","value":"1500"}}),
            json!({}),
        ] {
            assert!(resolve(&schema(), &bad, &history).is_err());
        }
        assert!(resolve(&schema(), &bindings, &[Content::new("model").with_text("审核金额1500")]).is_err());
    }
    #[test]
    fn provider_binding_lists_decode_json_values_and_reject_duplicates() {
        let history = vec![Content::new("user").with_text("审核1500")];
        let binding = json!({"input":"amount","source":"message","message":0,"quote":"1500","value_json":"1500"});
        assert_eq!(
            resolve(
                &schema(),
                &json!([binding.clone(),{"input":"locale","source":"default"}]),
                &history
            )
            .unwrap(),
            json!({"amount":1500,"locale":"zh"})
        );
        assert!(resolve(&schema(), &json!([binding.clone(), binding]), &history).is_err());
        assert!(
            resolve(
                &schema(),
                &json!([{"input":"amount","source":"message","message":0,"quote":"1500","value_json":"invalid json"}]),
                &history
            )
            .is_err()
        );
    }
    #[test]
    fn workflow_output_binds_to_app_contract_without_copying_model_values() {
        let workflow = json!({"document":{"settings":{"outputSchema":{"fields":[{"key":"amount"}]}}}});
        let output = super::super::capability::validated_output(
            &workflow,
            &json!({"global":{"amount":1500,"private":"not exported"}}),
        )
        .unwrap();
        assert_eq!(output, json!({"amount":1500}));
        let receipt:Content=serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{"name":"execute_capability","response":{"runId":"source-run","status":"completed","output":output}}}]})).unwrap();
        let bindings = json!({"amount":{"source":"result","run_id":"source-run","pointer":"/amount"}});
        let app_schema = crate::module::process_node::contract_schema(&BTreeMap::from([(
            "amount".into(),
            json!({"type":"number"}),
        )]));
        assert_eq!(
            resolve(&app_schema, &bindings, std::slice::from_ref(&receipt)).unwrap(),
            json!({"amount":1500})
        );
        for bad in [
            json!({"amount":{"source":"result","run_id":"missing","pointer":"/amount"}}),
            json!({"amount":{"source":"result","run_id":"source-run","pointer":"/private"}}),
        ] {
            assert!(resolve(&app_schema, &bad, std::slice::from_ref(&receipt)).is_err());
        }
        let string_schema = crate::module::process_node::contract_schema(&BTreeMap::from([(
            "amount".into(),
            json!({"type":"string"}),
        )]));
        assert!(resolve(&string_schema, &bindings, std::slice::from_ref(&receipt)).is_err());
        let mut failed = serde_json::to_value(&receipt).unwrap();
        failed["parts"][0]["functionResponse"]["response"]["status"] = json!("failed");
        assert!(resolve(&app_schema, &bindings, &[serde_json::from_value(failed).unwrap()]).is_err());
        assert!(resolve(&app_schema, &bindings, &[receipt.clone(), receipt]).is_err());
    }
}
