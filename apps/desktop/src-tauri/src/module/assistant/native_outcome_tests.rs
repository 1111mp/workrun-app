//! Scripted authoring + actual native execution with temporary persistence.
//! Fixtures choose the graph; these tests do not measure autonomous model choices.
use super::outcome_evaluation::{Verdict, assess};
use super::*;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    id: String,
    request: String,
    document: Value,
    runs: Vec<Run>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Run {
    input: Value,
    expected_route: String,
}
fn cases() -> Vec<Case> {
    serde_json::from_str(include_str!("fixtures/native-outcomes.json")).unwrap()
}

async fn save_fixture(case: &Case) -> Result<(authoring_tests::DraftStore, Value)> {
    let store = authoring_tests::DraftStore::new();
    let user = Content::new("user").with_text(&case.request);
    // Seed a matching approved proposal; interactive review is covered by
    // planning_tests. No unrelated sample plan authorizes this fixture.
    let plan_store = planning_agent::plans::Store::new(store.root.path());
    let plan = json!({
        "goal":case.request,"summary":case.id,
        "inputs":case.runs[0].input.as_object().unwrap().keys().map(|key|json!({"name":key,"description":"Run input"})).collect::<Vec<_>>(),
        "outputs":case.document["settings"]["outputSchema"]["fields"].as_array().unwrap().iter().map(|field|field["key"].clone()).collect::<Vec<_>>(),
        "steps":[{"title":"Apply agreed rule","description":case.document["nodes"][1]["data"].to_string(),"dependencies":[],"configuration_notes":"Use native routing and preserve the input"}],
        "constraints":["Do not run during creation"],"assumptions":[],"questions":[],
        "acceptance_criteria":case.runs.iter().map(|run|format!("{} selects {}",run.input,run.expected_route)).collect::<Vec<_>>()
    });
    let saved = plan_store.save(
        &store.session_id,
        "proposal",
        0,
        planning_agent::plans::Document::parse(&plan)?,
        vec![],
    )?;
    let history = protocol::normalize_assistant_contents(vec![user.clone()])?;
    plan_store.decide(
        &store.session_id,
        &saved.id,
        saved.version,
        true,
        &tool_execution::digest(&history)?,
    )?;
    let model = tests::ScriptedModel::new(vec![
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        tests::call("read_skill", json!({"name":"workrun-capabilities"})),
        tests::call(
            "validate_workflow_draft",
            json!({"document_json":case.document.to_string()}),
        ),
        tests::call(
            "save_workflow_draft",
            json!({"document_json":case.document.to_string()}),
        ),
        Content::new("model").with_text(json!({"status":"completed","summary":"Saved","assumptions":[]}).to_string()),
        Content::new("model").with_text("Saved without execution."),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
                contents: vec![user],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await?;
    anyhow::ensure!(reply.call.is_none(), "creation must not dispatch execution");
    let saved = store.saved.lock().unwrap().clone().context("author did not save")?;
    let draft = authoring::load(
        store.root.path(),
        saved["draft_id"].as_str().context("draft ID missing")?,
        true,
    )?;
    anyhow::ensure!(draft["document"] == case.document, "native save altered configuration");
    Ok((store, draft))
}

#[tokio::test]
async fn native_outcomes_scripted_authoring_saves_then_reuses_changed_inputs() -> Result<()> {
    for case in cases() {
        let (store, draft) = save_fixture(&case).await?;
        let checkpoint = store.root.path().join("evaluation.sqlite");
        std::fs::File::create(&checkpoint)?;
        let dsl = catalog::document_dsl(&draft)?;
        for (index, run) in case.runs.iter().enumerate() {
            // Native compiled graphs are consumed by execution; recompile the
            // same saved definition, without authoring a new one for each input.
            let graph = crate::module::workflow::TEST_CHECKPOINT_DB
                .scope(
                    format!("sqlite://{}", checkpoint.display()),
                    crate::module::workflow::compile(serde_json::from_value(dsl.clone())?, &Default::default(), None),
                )
                .await?;
            let result = graph
                .run_stream(
                    serde_json::from_value(run.input.clone())?,
                    &format!("{}-{index}", case.id),
                    false,
                    None,
                    |_| {},
                )
                .await?;
            anyhow::ensure!(!result.interrupted, "fixture unexpectedly paused");
            let observation = session::RunObservation {
                status: "completed".into(),
                name: case.id.clone(),
                error: None,
                state: serde_json::to_value(result.state)?,
            };
            let mut expected = vec![(
                "/workflow/workflow.trace/0/result/route".to_owned(),
                json!(run.expected_route),
            )];
            expected.extend(
                run.input
                    .as_object()
                    .unwrap()
                    .iter()
                    .map(|(key, value)| (format!("/global/{key}"), value.clone())),
            );
            let borrowed: Vec<_> = expected
                .iter()
                .map(|(key, value)| (key.as_str(), value.clone()))
                .collect();
            let assessment = assess(Some(&observation), &borrowed);
            anyhow::ensure!(
                assessment.verdict == Verdict::Passed,
                "{} input {} failed: {assessment:?}",
                case.id,
                run.input
            );
            capability::validated_output(&draft, &observation.state)?;
        }
    }
    Ok(())
}

#[tokio::test]
async fn native_outcomes_structurally_valid_wrong_rule_fails_outcome_check() -> Result<()> {
    let mut case = cases().remove(0);
    case.document["nodes"][1]["data"]["conditions"]["true"]["condition"] = json!("reading >= 100");
    case.document["nodes"][1]["data"]["conditions"]["false"]["condition"] = json!("reading < 100");
    // This tests the outcome evaluator, not the author's semantic plan compliance.
    let root = tempfile::tempdir()?;
    let saved = authoring::save(root.path(), case.document, &Default::default()).await?;
    anyhow::ensure!(
        saved["validation"]["valid"] == true,
        "negative fixture must be structurally valid"
    );
    let draft = authoring::load(root.path(), saved["draft_id"].as_str().unwrap(), true)?;
    let checkpoint = root.path().join("wrong.sqlite");
    std::fs::File::create(&checkpoint)?;
    let graph = crate::module::workflow::TEST_CHECKPOINT_DB
        .scope(
            format!("sqlite://{}", checkpoint.display()),
            crate::module::workflow::compile(
                serde_json::from_value(catalog::document_dsl(&draft)?)?,
                &Default::default(),
                None,
            ),
        )
        .await?;
    let result = graph
        .run_stream(
            serde_json::from_value(json!({"reading":10}))?,
            "wrong-rule",
            false,
            None,
            |_| {},
        )
        .await?;
    let observation = session::RunObservation {
        status: "completed".into(),
        name: case.id,
        error: None,
        state: serde_json::to_value(result.state)?,
    };
    let assessment = assess(
        Some(&observation),
        &[("/workflow/workflow.trace/0/result/route", json!("true"))],
    );
    assert_eq!(assessment.verdict, Verdict::Incorrect, "{assessment:?}");
    Ok(())
}

#[tokio::test]
async fn native_outcomes_saved_interactive_workflows_pause_reload_and_follow_both_decisions() -> Result<()> {
    use crate::module::workflow;
    for kind in ["human_review", "ask_user_question"] {
        let gate = if kind == "human_review" {
            json!({"title":"Review input","contentKey":"payload","editable":false})
        } else {
            json!({"title":"Choose a path","options":[{"id":"a","label":"First"},{"id":"b","label":"Second"}]})
        };
        let handles = if kind == "human_review" {
            ["approved", "rejected"]
        } else {
            ["option:a", "option:b"]
        };
        let branch =
            json!({"conditions":{"true":{"condition":"payload != \"\""},"false":{"condition":"payload == \"\""}}});
        let document = json!({
            "settings":{"name":format!("Interactive {kind}"),"mode":"task",
                "inputSchema":{"fields":[{"key":"payload","type":"string","required":true}]},
                "outputSchema":{"fields":[{"key":"payload","type":"string","required":true}]}},
            "nodes":[
                {"id":"start","type":"start","data":{},"position":{"x":0,"y":0}},
                {"id":"gate","type":kind,"data":gate,"position":{"x":200,"y":0}},
                {"id":"path_a","type":"if_else","data":branch,"position":{"x":400,"y":0}},
                {"id":"path_b","type":"if_else","data":branch,"position":{"x":400,"y":200}},
                {"id":"end","type":"end","data":{},"position":{"x":600,"y":0}}],
            "edges":[
                {"id":"entry","source":"start","target":"gate"},
                {"id":"choose-a","source":"gate","target":"path_a","sourceHandle":handles[0]},
                {"id":"choose-b","source":"gate","target":"path_b","sourceHandle":handles[1]},
                {"id":"a-true","source":"path_a","target":"end","sourceHandle":"true"},
                {"id":"a-false","source":"path_a","target":"end","sourceHandle":"false"},
                {"id":"b-true","source":"path_b","target":"end","sourceHandle":"true"},
                {"id":"b-false","source":"path_b","target":"end","sourceHandle":"false"}]});
        let case = Case {
            id: kind.into(),
            request: "Create a reusable workflow that waits for a human decision, follows the selected path and preserves the supplied text. Do not run during creation.".into(),
            document,
            runs: vec![
                Run { input:json!({"payload":"first input"}), expected_route:"path_a".into() },
                Run { input:json!({"payload":"changed input"}), expected_route:"path_b".into() },
            ],
        };
        let (store, draft) = save_fixture(&case).await?;
        let path = store.root.path().join("interactive.sqlite");
        std::fs::File::create(&path)?;
        let dsl: workflow::WorkflowDsl = serde_json::from_value(catalog::document_dsl(&draft)?)?;
        workflow::TEST_CHECKPOINT_DB
            .scope(format!("sqlite://{}", path.display()), async {
                for (index, run) in case.runs.iter().enumerate() {
                    let thread = format!("{kind}-{index}");
                    let graph = workflow::compile(dsl.clone(), &Default::default(), None).await?;
                    let paused = graph
                        .run_stream(serde_json::from_value(run.input.clone())?, &thread, false, None, |_| {})
                        .await?;
                    anyhow::ensure!(paused.interrupted, "human participation was bypassed");
                    let state = serde_json::to_value(paused.state)?;
                    anyhow::ensure!(
                        state
                            .pointer("/workflow/workflow.trace")
                            .is_none_or(|v| v.as_array().is_some_and(Vec::is_empty)),
                        "downstream work ran before a decision"
                    );
                    // Use the same native action preparation as the run center, not
                    // fabricated run inputs containing internal approval/answer keys.
                    let updates = if kind == "human_review" {
                        workflow::prepare_human_review_checkpoint(
                            serde_json::to_value(&dsl)?,
                            thread.clone(),
                            "gate".into(),
                            index == 0,
                            Default::default(),
                            None,
                        )
                        .await?
                    } else {
                        anyhow::ensure!(
                            workflow::prepare_ask_user_question_checkpoint(
                                serde_json::to_value(&dsl)?,
                                thread.clone(),
                                "gate".into(),
                                "unknown".into(),
                                None
                            )
                            .await
                            .is_err(),
                            "unknown option was accepted"
                        );
                        workflow::prepare_ask_user_question_checkpoint(
                            serde_json::to_value(&dsl)?,
                            thread.clone(),
                            "gate".into(),
                            if index == 0 { "a" } else { "b" }.into(),
                            None,
                        )
                        .await?
                    };
                    // Reload from the unchanged saved definition and durable SQLite
                    // checkpoint; no compiled graph instance survives the pause.
                    let graph = workflow::compile(dsl.clone(), &Default::default(), None).await?;
                    graph.update_state(&thread, updates).await?;
                    let resumed = graph
                        .run_stream(Default::default(), &thread, true, None, |_| {})
                        .await?;
                    anyhow::ensure!(!resumed.interrupted, "decision did not resume execution");
                    let observation = session::RunObservation {
                        status: "completed".into(),
                        name: kind.into(),
                        error: None,
                        state: serde_json::to_value(resumed.state)?,
                    };
                    let expected = [
                        ("/global/payload", run.input["payload"].clone()),
                        ("/workflow/workflow.trace/0/nodeId", json!("gate")),
                        ("/workflow/workflow.trace/1/nodeId", json!(run.expected_route)),
                    ];
                    let assessment = assess(Some(&observation), &expected);
                    anyhow::ensure!(
                        assessment.verdict == Verdict::Passed,
                        "{kind} decision {index}: {assessment:?}"
                    );
                    anyhow::ensure!(
                        observation.state["workflow"]["workflow.trace"]
                            .as_array()
                            .unwrap()
                            .len()
                            == 2,
                        "unexpected branch executed"
                    );
                    anyhow::ensure!(
                        capability::validated_output(&draft, &observation.state)? == run.input,
                        "export changed the input"
                    );
                }
                anyhow::Ok(())
            })
            .await?;
    }
    Ok(())
}

#[tokio::test]
async fn native_outcomes_subworkflow_reuses_persisted_definition_and_reports_unavailable_child() -> Result<()> {
    use crate::module::workflow;
    let child_case = cases()
        .into_iter()
        .find(|case| case.id == "boolean-routing")
        .context("missing reusable rule fixture")?;
    let (_child_store, child) = save_fixture(&child_case).await?;
    let catalog = tempfile::tempdir()?;
    let child_id = uuid::Uuid::new_v4().to_string();
    let child_file = catalog.path().join(format!("{child_id}.json"));
    // Persist the authored definition as an ordinary catalog entry; the only
    // substituted boundary is its storage root, not child execution or outputs.
    let entry = crate::config::IWorkflow {
        id: child_id.clone(),
        created_at: "2026-01-01T00:00:00Z".into(),
        updated_at: "2026-01-01T00:00:00Z".into(),
        document: child["document"].clone(),
    };
    std::fs::write(&child_file, serde_json::to_vec(&entry)?)?;
    let mut parent_document = child_case.document.clone();
    parent_document["settings"]["name"] = json!("Reuse a saved rule");
    parent_document["settings"]["inputSchema"]["fields"]
        .as_array_mut()
        .unwrap()
        .push(json!({"key":"extra_context","type":"string","required":true}));
    parent_document["nodes"] = json!([
        {"id":"start","type":"start","data":{},"position":{"x":0,"y":0}},
        {"id":"reuse","type":"subworkflow","data":{"workflowId":child_id,"state":{"globalKeys":["enabled"]}},"position":{"x":200,"y":0}},
        {"id":"end","type":"end","data":{},"position":{"x":400,"y":0}}]);
    parent_document["edges"] = json!([
        {"id":"enter","source":"start","target":"reuse"},
        {"id":"finish","source":"reuse","target":"end"}]);
    let case = Case {id:"subworkflow-reuse".into(),
        request:"Create a reusable workflow that invokes the selected saved boolean rule and exports its declared result. Do not run during creation.".into(),
        document:parent_document, runs:vec![
            Run {input:json!({"enabled":true,"extra_context":"first"}),expected_route:"true".into()},
            Run {input:json!({"enabled":false,"extra_context":"changed"}),expected_route:"false".into()}]};
    workflow::TEST_SUBWORKFLOW_CATALOG
        .scope(catalog.path().to_path_buf(), async {
            let (store, draft) = save_fixture(&case).await?;
            let checkpoint = store.root.path().join("reuse.sqlite");
            std::fs::File::create(&checkpoint)?;
            let dsl: workflow::WorkflowDsl = serde_json::from_value(catalog::document_dsl(&draft)?)?;
            workflow::TEST_CHECKPOINT_DB
                .scope(format!("sqlite://{}", checkpoint.display()), async {
                    for (index, run) in case.runs.iter().enumerate() {
                        let graph = workflow::compile(dsl.clone(), &Default::default(), None).await?;
                        let result = graph
                            .run_stream(
                                serde_json::from_value(run.input.clone())?,
                                &format!("reuse-{index}"),
                                false,
                                None,
                                |_| {},
                            )
                            .await?;
                        anyhow::ensure!(!result.interrupted, "unexpected child pause");
                        let observation = session::RunObservation {
                            status: "completed".into(),
                            name: case.id.clone(),
                            error: None,
                            state: serde_json::to_value(result.state)?,
                        };
                        let expected = [
                            (
                                "/workflow/workflow.trace/0/result",
                                json!({"enabled":run.input["enabled"]}),
                            ),
                            (
                                "/workflow/workflow.trace/0/execution/0/result/route",
                                json!(run.expected_route),
                            ),
                        ];
                        let assessment = assess(Some(&observation), &expected);
                        anyhow::ensure!(assessment.verdict == Verdict::Passed, "child outcome: {assessment:?}");
                        anyhow::ensure!(
                            capability::validated_output(&draft, &observation.state)?
                                == json!({"enabled":run.input["enabled"]}),
                            "undeclared child data escaped export"
                        );
                    }
                    // Disappearance after creation is a capability failure, not a reason
                    // to invent a replacement or use another workflow with a similar name.
                    std::fs::remove_file(&child_file)?;
                    let validation = authoring::validate(&draft["document"], &Default::default()).await?;
                    anyhow::ensure!(
                        validation["valid"] == false
                            && validation["issues"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|issue| issue["phase"] == "resource"
                                    && issue["message"]
                                        .as_str()
                                        .is_some_and(|message| message.contains(&child_id))),
                        "unavailable dependency was not exposed during validation"
                    );
                    let result = match workflow::compile(dsl.clone(), &Default::default(), None).await {
                        Ok(graph) => graph
                            .run_stream(
                                serde_json::from_value(case.runs[0].input.clone())?,
                                "missing-child",
                                false,
                                None,
                                |_| {},
                            )
                            .await
                            .map(|_| ()),
                        Err(error) => Err(error),
                    };
                    let error = result.err().context("missing dependency was reported as successful")?;
                    anyhow::ensure!(
                        error.to_string().contains(&child_id),
                        "missing dependency identity was lost: {error}"
                    );
                    let observation = session::RunObservation {
                        status: "failed".into(),
                        name: case.id.clone(),
                        error: Some(error.to_string()),
                        state: Value::Null,
                    };
                    anyhow::ensure!(
                        assess(Some(&observation), &[("/global/enabled", json!(true))]).verdict
                            == Verdict::ExecutionFailed,
                        "failure was graded as a valid output"
                    );
                    anyhow::Ok(())
                })
                .await
        })
        .await
}
