//! Model-facing execution views; durable receipts and binding evidence stay intact.
use adk_rust::{Content, Part};
use serde_json::{Value, json};

/// Reuse complete small-file reads from the session journal for result checking.
/// This does not create binding evidence or authorize access to another artifact.
pub(super) fn artifact_evidence(operations: &Value, artifacts: &[crate::module::artifact::ArtifactRef]) -> Vec<Value> {
    let mut evidence = Vec::new();
    for record in operations["items"].as_array().into_iter().flatten() {
        let result = &record["result"];
        let Some(text) = result["text"].as_str() else { continue };
        let chars = text.chars().count();
        if record["kind"] != "direct_tool"
            || record["name"] != "read_artifact"
            || record["status"] != "completed"
            || result["offset"] != 0
            || result["truncated"] != false
            || result["total_characters"].as_u64() != Some(chars as u64)
            || chars > 2000
        {
            continue;
        }
        let Some(artifact) = artifacts.iter().find(|artifact| {
            result["artifact"]["id"] == artifact.id && result["artifact"]["version"] == artifact.version
        }) else {
            continue;
        };
        if evidence
            .iter()
            .any(|item: &Value| item["artifact"]["id"] == artifact.id)
        {
            continue;
        }
        evidence.push(json!({"artifact":artifact,"text":text,"complete":true}));
        if evidence.len() == 2 {
            break;
        }
    }
    evidence
}

pub(super) fn project(contents: &mut [Content]) {
    deduplicate_reads(contents);
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

fn deduplicate_reads(contents: &mut [Content]) {
    let mut seen: Vec<(&str, &Value, &str)> = Vec::new();
    let mut duplicates = Vec::new();
    // Keep the latest complete response in this request, not an external cache.
    // Exact equality includes IDs, versions, pagination and validation metadata.
    for (message, content) in contents.iter().enumerate().rev() {
        for (part_index, part) in content.parts.iter().enumerate().rev() {
            let Part::FunctionResponse {
                function_response,
                id: Some(id),
                ..
            } = part
            else {
                continue;
            };
            let name = function_response.name.as_str();
            let response = &function_response.response;
            if id.is_empty()
                || !matches!(
                    name,
                    "read_skill"
                        | "get_workflow_reference"
                        | "get_workflow_draft"
                        | "get_workflow_plan"
                        | "list_capabilities"
                        | "list_authoring_resources"
                        | "read_artifact"
                )
                || response.get("error").is_some()
                || response.to_string().len() < 1024
            {
                continue;
            }
            if let Some((_, _, target)) = seen
                .iter()
                .find(|(other_name, other_response, _)| *other_name == name && *other_response == response)
            {
                if *target != id.as_str() {
                    duplicates.push((message, part_index, (*target).to_owned()));
                }
            } else {
                seen.push((name, response, id.as_str()));
            }
        }
    }
    for (message, part, target) in duplicates {
        if let Part::FunctionResponse { function_response, .. } = &mut contents[message].parts[part] {
            function_response.response = json!({"duplicateOfToolCallId":target,
                "detailHint":"The identical full response is present later in this request under that tool call ID. Use it without rereading."});
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

    fn read_receipt(name: &str, id: &str, response: Value) -> Content {
        serde_json::from_value(json!({"role":"function","parts":[{
            "functionResponse":{"name":name,"response":response},"id":id
        }]}))
        .unwrap()
    }

    #[test]
    fn repeated_large_reads_keep_latest_full_evidence_and_original_call_identity() {
        for name in [
            "get_workflow_reference",
            "get_workflow_plan",
            "get_workflow_draft",
            "read_artifact",
        ] {
            let result = json!({"id":"resource","version":3,"offset":0,"truncated":false,
                "content":"完整契约、原始内容与约束。".repeat(500)});
            let source = vec![
                read_receipt(name, "first", result.clone()),
                read_receipt(name, "second", result.clone()),
                read_receipt(name, "latest", result.clone()),
            ];
            let original = serde_json::to_value(&source).unwrap();
            let mut view = source.clone();
            project(&mut view);
            let projected = serde_json::to_value(&view).unwrap();
            for index in 0..2 {
                assert_eq!(
                    projected[index]["parts"][0]["functionResponse"]["response"]["duplicateOfToolCallId"],
                    "latest"
                );
                assert_eq!(projected[index]["parts"][0]["id"], original[index]["parts"][0]["id"]);
                assert_eq!(projected[index]["parts"][0]["functionResponse"]["name"], name);
            }
            assert_eq!(projected[2], original[2]);
            assert!(projected.to_string().len() * 2 < original.to_string().len());
            assert_eq!(serde_json::to_value(source).unwrap(), original);
            project(&mut view);
            assert_eq!(serde_json::to_value(view).unwrap(), projected);
        }
    }

    #[test]
    fn changed_versions_pages_errors_effects_and_unidentified_reads_stay_intact() {
        let result = json!({"id":"resource","version":1,"offset":0,"content":"evidence".repeat(500)});
        let mut source = vec![];
        for (index, (key, value)) in [("version", json!(2)), ("offset", json!(20)), ("id", json!("other"))]
            .into_iter()
            .enumerate()
        {
            let mut changed = result.clone();
            changed[key] = value;
            source.push(read_receipt("read_artifact", &format!("changed-{index}"), changed));
        }
        source.push(read_receipt("read_artifact", "latest", result.clone()));
        for name in [
            "save_workflow_draft",
            "call_workspace_tool",
            "execute_capability",
            "unknown_tool",
        ] {
            source.push(read_receipt(name, "first", result.clone()));
            source.push(read_receipt(name, "second", result.clone()));
        }
        let error = json!({"error":"validation failed","detail":"detail".repeat(500)});
        source.push(read_receipt("get_workflow_plan", "error-1", error.clone()));
        source.push(read_receipt("get_workflow_plan", "error-2", error));
        source.push(read_receipt("read_artifact", "", result.clone()));
        source.push(read_receipt("read_artifact", "", result));
        source.push(read_receipt("read_skill", "small-1", json!({"content":"brief"})));
        source.push(read_receipt("read_skill", "small-2", json!({"content":"brief"})));
        let original = serde_json::to_value(&source).unwrap();
        project(&mut source);
        assert_eq!(serde_json::to_value(source).unwrap(), original);
    }

    #[test]
    fn delivery_evidence_requires_authorized_version_and_complete_small_reads() {
        let artifact: crate::module::artifact::ArtifactRef = serde_json::from_value(
            json!({"$type":"artifact","id":"file","version":1,"name":"data.txt","mimeType":"text/plain","size":3}),
        )
        .unwrap();
        let record = json!({"kind":"direct_tool","name":"read_artifact","status":"completed","result":{"artifact":artifact,"text":"abc","offset":0,"total_characters":3,"truncated":false}});
        let operations = json!({"items":[record.clone(),record.clone()]});
        let original = operations.clone();
        assert_eq!(artifact_evidence(&operations, std::slice::from_ref(&artifact)).len(), 1);
        assert!(artifact_evidence(&operations, &[]).is_empty());
        for (field, value) in [
            ("truncated", json!(true)),
            ("offset", json!(1)),
            ("total_characters", json!(4)),
            ("text", json!("a".repeat(2001))),
        ] {
            let mut invalid = record.clone();
            invalid["result"][field] = value;
            assert!(artifact_evidence(&json!({"items":[invalid]}), std::slice::from_ref(&artifact)).is_empty());
        }
        let mut stale = record;
        stale["result"]["artifact"]["version"] = json!(2);
        assert!(artifact_evidence(&json!({"items":[stale]}), &[artifact]).is_empty());
        assert_eq!(operations, original);
    }

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
