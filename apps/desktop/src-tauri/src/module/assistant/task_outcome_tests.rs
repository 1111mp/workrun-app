//! Offline task assets and recorded-run grading, never a provider/model runner.
use super::outcome_evaluation::{Verdict, assess};
use super::*;
use serde_json::Value;

fn requests() -> Value {
    serde_json::from_str(include_str!("fixtures/tasks/requests.json")).unwrap()
}
fn expectations() -> Value {
    serde_json::from_str(include_str!("fixtures/tasks/expected.json")).unwrap()
}

// JSON-valued text outputs are compared as JSON, not by whitespace/key order.
// Other strings remain exact: formatting and content preservation are task goals.
fn normalize(value: &Value) -> Result<Value> {
    let mut result = value.as_object().context("output must be an object")?.clone();
    for (key, value) in &mut result {
        if key.ends_with("_json") {
            *value = serde_json::from_str(value.as_str().context("JSON output field must be text")?)?;
        }
    }
    Ok(Value::Object(result))
}

fn grade_records(records: &[Value]) -> Result<Value> {
    let expected = expectations();
    let mut results = vec![];
    for task in requests().as_array().unwrap() {
        let id = task["id"].as_str().unwrap();
        let mut identity: Option<(Value, Value)> = None;
        for (index, expected) in expected[id].as_array().unwrap().iter().enumerate() {
            let matching: Vec<_> = records
                .iter()
                .filter(|record| record["caseId"] == id && record["runIndex"].as_u64() == Some(index as u64))
                .collect();
            let result: Result<Value> = (|| {
                anyhow::ensure!(
                    matching.len() == 1,
                    "expected one recorded run, found {}",
                    matching.len()
                );
                let record = matching[0];
                let workflow_id = record["workflowId"].as_str().context("workflow identity missing")?;
                anyhow::ensure!(!workflow_id.is_empty(), "workflow identity empty");
                let document = record.get("document").context("saved document missing")?;
                let current = (json!(workflow_id), document.clone());
                if let Some(identity) = &identity {
                    anyhow::ensure!(
                        identity == &current,
                        "changed input must reuse the same saved definition"
                    );
                } else {
                    identity = Some(current);
                }
                let raw = session::RunObservation {
                    status: record["status"].as_str().context("status missing")?.into(),
                    name: id.into(),
                    error: record["error"].as_str().map(str::to_owned),
                    state: record.get("state").context("native state missing")?.clone(),
                };
                // Native export checks the actual saved interface; the grader
                // cannot substitute a model's report for exported outputs.
                let output = capability::validated_output(&json!({"document":document}), &raw.state)?;
                let observed = session::RunObservation {
                    state: normalize(&output)?,
                    ..raw
                };
                let normalized = normalize(expected)?;
                let keys: Vec<_> = normalized
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| (format!("/{key}"), value.clone()))
                    .collect();
                let checks: Vec<_> = keys.iter().map(|(key, value)| (key.as_str(), value.clone())).collect();
                let assessment = assess(Some(&observed), &checks);
                Ok(json!({"caseId":id,"runIndex":index,
                    "passed":assessment.verdict == Verdict::Passed,
                    "verdict":format!("{:?}",assessment.verdict),
                    "checks":assessment.checks.iter().map(|check|json!({
                        "pointer":check.pointer,"expected":check.expected,"observed":check.observed,
                        "verdict":format!("{:?}",check.verdict)
                    })).collect::<Vec<_>>()
                }))
            })();
            results.push(result.unwrap_or_else(|error| {
                json!({"caseId":id,"runIndex":index,
                "passed":false,"error":error.to_string()})
            }));
        }
    }
    // Unknown observations must not silently inflate or evade the benchmark.
    let expected_count: usize = expectations()
        .as_object()
        .unwrap()
        .values()
        .map(|runs| runs.as_array().unwrap().len())
        .sum();
    Ok(
        json!({"passed":records.len()==expected_count && results.iter().all(|result|result["passed"]==true),
        "expectedRuns":expected_count,"recordedRuns":records.len(),"results":results,
        "autonomyEvaluated":false}),
    )
}

#[test]
fn task_outcomes_reference_answers_match_independent_fixture_operations() -> Result<()> {
    let expected = expectations();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/module/assistant/fixtures/tasks");
    for task in requests().as_array().unwrap() {
        let id = task["id"].as_str().unwrap();
        anyhow::ensure!(task.get("expected").is_none(), "answers leaked into requests");
        for (index, run) in task["runs"].as_array().unwrap().iter().enumerate() {
            let actual = match id {
                "file-aggregation" => {
                    let rows: Vec<Value> = serde_json::from_slice(&std::fs::read(
                        root.join(run["attachments"]["records_file"].as_str().unwrap()),
                    )?)?;
                    let mut groups = std::collections::BTreeMap::<String, i64>::new();
                    let mut total = 0;
                    for row in &rows {
                        let value = row["value"].as_i64().unwrap();
                        total += value;
                        *groups.entry(row["group"].as_str().unwrap().into()).or_default() += value;
                    }
                    json!({"total":total,"record_count":rows.len(),"groups_json":serde_json::to_string(&groups)?,"unit":""})
                },
                "stable-deduplication" => {
                    let input: Vec<String> = serde_json::from_str(run["input"]["items_json"].as_str().unwrap())?;
                    let mut seen = std::collections::HashSet::new();
                    let result: Vec<_> = input
                        .iter()
                        .map(|item| item.trim())
                        .filter(|item| !item.is_empty() && seen.insert(*item))
                        .collect();
                    json!({"count":result.len(),"result_json":serde_json::to_string(&result)?})
                },
                "text-formatting" => json!({"markdown":format!("# {}\n\n{}\n",
                    run["input"]["title"].as_str().unwrap().trim(),run["input"]["body"].as_str().unwrap().trim())}),
                _ => anyhow::bail!("unknown reference operation"),
            };
            assert_eq!(
                normalize(&actual)?,
                normalize(&expected[id][index])?,
                "{id} run {index}"
            );
        }
    }
    Ok(())
}

#[test]
fn task_outcomes_missing_recordings_never_count_as_success() -> Result<()> {
    let report = grade_records(&[])?;
    assert_eq!(report["passed"], false);
    assert_eq!(report["expectedRuns"], 6);
    assert_eq!(report["results"].as_array().unwrap().len(), 6);
    Ok(())
}

#[test]
fn task_outcomes_recording_grader_rejects_wrong_outputs_and_reauthored_definitions() -> Result<()> {
    // Synthetic recordings exercise the grader, never count as model/run evidence.
    let mut records = vec![];
    for (id, runs) in expectations().as_object().unwrap() {
        let fields: Vec<_> = runs[0]
            .as_object()
            .unwrap()
            .iter()
            .map(|(key, value)| json!({"key":key,"type":if value.is_number(){"number"}else{"string"},"required":true}))
            .collect();
        for (index, output) in runs.as_array().unwrap().iter().enumerate() {
            records.push(json!({"caseId":id,"runIndex":index,"workflowId":id,
                "document":{"settings":{"outputSchema":{"fields":fields}}},
                "status":"completed","error":null,"state":{"global":output}}));
        }
    }
    assert_eq!(grade_records(&records)?["passed"], true);
    let original = records.clone();
    let index = records
        .iter()
        .position(|record| record["caseId"] == "file-aggregation")
        .unwrap();
    records[index]["state"]["global"]["total"] = json!(-1);
    assert_eq!(grade_records(&records)?["passed"], false);
    records = original.clone();
    records[index]["status"] = json!("failed");
    assert_eq!(grade_records(&records)?["passed"], false);
    records = original.clone();
    records[index]["document"]["settings"]["name"] = json!("changed between runs");
    assert_eq!(grade_records(&records)?["passed"], false);
    records = original.clone();
    records.push(records[0].clone());
    assert_eq!(grade_records(&records)?["passed"], false);
    Ok(())
}

#[test]
#[ignore = "offline only: set WORKRUN_TASK_RECORDINGS to a JSON array of recorded native runs"]
fn task_outcomes_grade_recorded_native_runs() -> Result<()> {
    let path = std::env::var_os("WORKRUN_TASK_RECORDINGS").context("WORKRUN_TASK_RECORDINGS is required")?;
    let records: Vec<Value> = serde_json::from_slice(&std::fs::read(path)?)?;
    let report = grade_records(&records)?;
    println!("{}", serde_json::to_string_pretty(&report)?);
    anyhow::ensure!(report["passed"] == true, "task outcome checks failed; see report");
    Ok(())
}
