//! Model-facing execution views; durable receipts and binding evidence stay intact.
use adk_rust::{Content, Part};
use serde_json::{Value, json};

pub(super) fn project(contents: &mut [Content]) {
    for part in contents.iter_mut().flat_map(|content| &mut content.parts) {
        if let Part::FunctionResponse { function_response, .. } = part
            && matches!(
                function_response.name.as_str(),
                "execute_workflow" | "execute_capability"
            )
        {
            summarize(&mut function_response.response);
        }
    }
}

fn summarize(response: &mut Value) {
    // Only native terminal receipts have this envelope. Arbitrary tool results,
    // execution proposals and incomplete state must not be treated as success.
    if response["runId"].as_str().is_none()
        || !matches!(
            response["status"].as_str(),
            Some("completed" | "failed" | "cancelled" | "interrupted")
        )
        || response.get("result").is_none()
    {
        return;
    }
    let view = if response["status"] == "completed"
        && response["output"].as_object().is_some_and(|output| !output.is_empty())
    {
        // Validated output is the reusable contract. The parallel state dump
        // adds trace/node copies without supplying additional contract values.
        None
    } else {
        let Some(state) = response["result"]
            .as_str()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
        else {
            return;
        };
        if !state["global"].is_object() || !state["workflow"].is_object() || !state["nodes"].is_object() {
            return;
        }
        let last = state["workflow"]["workflow.trace"]
            .as_array()
            .and_then(|trace| trace.last());
        if state["global"].as_object().unwrap().is_empty() && last.is_none() {
            return;
        }
        // Legacy workflows may have no output contract. Keep global state and
        // the final node result so useful deliverables are not silently lost.
        Some(json!({"global":state["global"],"lastNodeResult":last}))
    };
    let mut candidate = response.clone();
    if let Some(view) = view {
        candidate["result"] = json!(view.to_string());
    } else {
        candidate.as_object_mut().unwrap().remove("result");
    }
    candidate["resultView"] = json!("delivery");
    candidate["detailHint"] = json!(
        "inspect_execution with this run_id and detail=full reads the stored receipt; it never reruns execution. Stored details may already be truncated."
    );
    // Small receipts need no projection. Avoid expanding a compact result or
    // falsely marking an already projected view as another reduction.
    if candidate.to_string().len() < response.to_string().len() {
        *response = candidate;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn receipt(name: &str, response: Value) -> Content {
        serde_json::from_value(json!({"role":"function","parts":[{
            "functionResponse":{"name":name,"response":response},"id":"original-call"
        }]}))
        .unwrap()
    }
    fn state() -> Value {
        json!({"global":{"answer":42},"nodes":{"worker":{"messages":["internal".repeat(3000)]}},
            "workflow":{"workflow.trace":[{"messages":["earlier".repeat(3000)]},{"messages":["Final result"]}]}})
    }
    #[test]
    fn validated_outputs_replace_duplicate_state_without_changing_receipt_evidence() {
        let source = receipt(
            "execute_capability",
            json!({"runId":"run-1","status":"completed","output":{"answer":42},
            "result":state().to_string(),"artifacts":[{"id":"file-1"}],"truncated":false}),
        );
        let original = serde_json::to_value(&source).unwrap();
        let mut view = vec![source.clone()];
        project(&mut view);
        let projected = serde_json::to_value(&view[0]).unwrap();
        let response = &projected["parts"][0]["functionResponse"]["response"];
        assert!(response.get("result").is_none());
        assert_eq!(response["output"], json!({"answer":42}));
        assert_eq!(response["artifacts"], json!([{"id":"file-1"}]));
        assert_eq!(projected["parts"][0]["id"], "original-call");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["runId"], "run-1");
        assert_eq!(serde_json::to_value(&source).unwrap(), original);
        assert!(projected.to_string().len() * 5 < original.to_string().len());
        let again = view.clone();
        project(&mut view);
        assert_eq!(
            serde_json::to_value(view).unwrap(),
            serde_json::to_value(again).unwrap()
        );
    }
    #[test]
    fn legacy_and_failed_results_keep_global_final_result_and_errors() {
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let mut contents = vec![receipt(
                "execute_workflow",
                json!({"runId":"run-1","status":status,
                "error":"native failure detail","outputError":"Contract mismatch","output":{},"result":state().to_string()}),
            )];
            project(&mut contents);
            let view = serde_json::to_value(contents).unwrap();
            let response = &view[0]["parts"][0]["functionResponse"]["response"];
            assert_eq!(response["error"], "native failure detail");
            assert_eq!(response["outputError"], "Contract mismatch");
            assert_eq!(response["status"], status);
            let result: Value = serde_json::from_str(response["result"].as_str().unwrap()).unwrap();
            assert_eq!(result["global"]["answer"], 42);
            assert_eq!(result["lastNodeResult"]["messages"][0], "Final result");
            assert!(!view.to_string().contains("earlierearlier"));
        }
    }
    #[test]
    fn unknown_shapes_partial_json_small_results_and_other_tools_are_not_compressed() {
        let source = vec![
            receipt(
                "execute_workflow",
                json!({"runId":"r","status":"completed","result":"{clipped"}),
            ),
            receipt(
                "execute_workflow",
                json!({"runId":"r","status":"completed","result":"Report ready"}),
            ),
            receipt(
                "execute_workflow",
                json!({"runId":"r","status":"running","result":state().to_string()}),
            ),
            receipt(
                "external_tool",
                json!({"runId":"r","status":"completed","output":{"answer":42},"result":state().to_string()}),
            ),
            receipt(
                "execute_workflow",
                json!({"status":"completed","output":{"answer":42},"result":state().to_string()}),
            ),
        ];
        let mut contents = source.clone();
        project(&mut contents);
        assert_eq!(
            serde_json::to_value(contents).unwrap(),
            serde_json::to_value(source).unwrap()
        );
    }
}
