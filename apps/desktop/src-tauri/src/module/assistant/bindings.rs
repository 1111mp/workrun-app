//! Resolve values from native conversation records, never model-authored receipts.
use adk_rust::prelude::{Content, Part};
use anyhow::{Context, Result, ensure};
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

#[derive(Debug, thiserror::Error)]
#[error(
    "Required capability inputs missing or empty without explicit empty-value evidence: {fields:?}. Ask the user for these inputs."
)]
pub(super) struct InputIssue {
    pub fields: Vec<String>,
}

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
    let mut missing = Vec::new();
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
                // An arbitrary matching quote proves provenance, not that an
                // absent input was supplied. Required empty placeholders require literal
                // typed evidence; defaults and native result bindings remain valid.
                let empty = value.is_null()
                    || value.as_str().is_some_and(|v| v.trim().is_empty())
                    || value.as_array().is_some_and(Vec::is_empty)
                    || value.as_object().is_some_and(Map::is_empty);
                let required = schema["required"]
                    .as_array()
                    .is_some_and(|keys| keys.iter().any(|required| required.as_str() == Some(key.as_str())));
                if empty && required && serde_json::from_str::<Value>(&quote).ok().as_ref() != Some(&value) {
                    missing.push(key.clone());
                    continue;
                }
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
    if let Some(required) = schema["required"].as_array() {
        missing.extend(
            required
                .iter()
                .filter_map(Value::as_str)
                .filter(|key| !values.contains_key(*key))
                .map(str::to_owned),
        );
    }
    missing.sort();
    missing.dedup();
    if !missing.is_empty() {
        return Err(InputIssue { fields: missing }.into());
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
    #[test]
    fn missing_values_cannot_be_invented_from_a_generic_task_quote() {
        let history = vec![Content::new("user").with_text("Process the supplied input")];
        for (field, empty) in [
            (json!({"type":"string"}), json!("")),
            (json!({"type":"string"}), json!("  ")),
            (json!({"type":"array","items":{"type":"string"}}), json!([])),
            (json!({"type":"object"}), json!({})),
            (json!({"type":["string","null"]}), Value::Null),
        ] {
            let schema = json!({"type":"object","properties":{"input":field},"required":["input"]});
            let binding = json!({"input":{"source":"message","message":0,
                "quote":"Process the supplied input","value":empty}});
            let error = resolve(&schema, &binding, &history).unwrap_err().to_string();
            assert!(error.contains("input"));
            assert!(error.contains("Ask the user"));
            // Literal empty JSON is an intentional value, not missing input.
            let literal = empty.to_string();
            let explicit = vec![Content::new("user").with_text(format!("Use this value: {literal}"))];
            let binding = json!({"input":{"source":"message","message":0,"quote":literal,"value":empty}});
            assert_eq!(resolve(&schema, &binding, &explicit).unwrap(), json!({"input":empty}));
        }
    }

    #[test]
    fn defaults_native_empty_results_zero_false_and_dates_remain_valid() {
        for value in [json!([]), json!({}), json!(""), Value::Null] {
            let schema = json!({"type":"object","properties":{"input":{"default":value}},"required":["input"]});
            assert_eq!(
                resolve(&schema, &json!({"input":{"source":"default"}}), &[]).unwrap(),
                json!({"input":value})
            );
            let receipt:Content = serde_json::from_value(json!({"role":"function","parts":[{
                "functionResponse":{"name":"execute_capability","response":{"runId":"r","status":"completed","output":{"input":value}}}
            }]})).unwrap();
            assert_eq!(
                resolve(
                    &schema,
                    &json!({"input":{"source":"result","run_id":"r","pointer":"/input"}}),
                    &[receipt]
                )
                .unwrap(),
                json!({"input":value})
            );
        }
        for (field, quote, value) in [
            (json!({"type":"number"}), "0", json!(0)),
            (json!({"type":"boolean"}), "false", json!(false)),
            (json!({"type":"string","format":"date"}), "明天", json!("2026-10-24")),
            (
                json!({"type":"object","required":["start","end"]}),
                "本周",
                json!({"start":"2026-10-19","end":"2026-10-25"}),
            ),
        ] {
            let schema = json!({"type":"object","properties":{"input":field},"required":["input"]});
            let binding = json!({"input":{"source":"message","message":0,"quote":quote,"value":value}});
            assert_eq!(
                resolve(&schema, &binding, &[Content::new("user").with_text(quote)]).unwrap(),
                json!({"input":value})
            );
        }
    }

    #[test]
    fn optional_empty_values_do_not_become_new_required_inputs() {
        let schema = json!({"type":"object","properties":{"amount":{"type":"number"},"note":{"type":"string"}},"required":["amount"]});
        let binding = json!({"amount":{"source":"message","message":0,"quote":"0","value":0},
            "note":{"source":"message","message":0,"quote":"清空备注","value":""}});
        assert_eq!(
            resolve(&schema, &binding, &[Content::new("user").with_text("金额0，清空备注")]).unwrap(),
            json!({"amount":0,"note":""})
        );
    }

    #[test]
    fn one_input_issue_collects_all_missing_and_ungrounded_empty_required_fields() {
        let schema = json!({"type":"object","properties":{"text":{"type":"string"},"files":{"type":"array"},"period":{"type":"string"}},"required":["text","files","period"]});
        let bindings = json!({"text":{"source":"message","message":0,"quote":"Process input","value":""},
            "files":{"source":"message","message":0,"quote":"Process input","value":[]}});
        let error = resolve(&schema, &bindings, &[Content::new("user").with_text("Process input")]).unwrap_err();
        assert_eq!(
            error.downcast_ref::<InputIssue>().unwrap().fields,
            vec!["files", "period", "text"]
        );
    }
}
