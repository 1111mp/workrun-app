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
        "outputs":["Selected route"],
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
