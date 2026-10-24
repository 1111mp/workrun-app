//! Acceptance uses the real graph compiler/executor and the assistant's durable
//! dispatch/result handoff with a test transport instead of the production queue.
//! Only synthetic inputs and temporary checkpoint/session databases are used.
use super::evaluation::ProbeModel;
use super::session::{RunObservation, WorkflowRuns, dispatch};
use super::*;
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct GraphRuns {
    pool: SqlitePool,
    session_id: String,
    observations: Mutex<HashMap<String, Value>>,
    starts: AtomicUsize,
}
#[async_trait::async_trait]
impl WorkflowRuns for GraphRuns {
    fn status_changes(&self) -> tokio::sync::broadcast::Receiver<String> {
        // Acceptance executes synchronously in start; inspect already sees the result.
        tokio::sync::broadcast::channel(1).1
    }
    async fn start(&self, request: crate::module::run_manager::StartWorkflowRun) -> Result<()> {
        let persisted: String = sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id=?")
            .bind(&self.session_id)
            .fetch_one(&self.pool)
            .await?;
        let persisted: Value = serde_json::from_str(&persisted)?;
        anyhow::ensure!(
            persisted["activeCall"]["runId"] == request.run_id,
            "run identity was not committed before execution"
        );
        self.starts.fetch_add(1, Ordering::SeqCst);
        let directory = tempfile::tempdir()?;
        let file = directory.path().join("checkpoint.sqlite");
        std::fs::File::create(&file)?;
        let url = format!("sqlite://{}", file.display());
        let dsl = serde_json::from_value(request.dsl)?;
        let graph = crate::module::workflow::TEST_CHECKPOINT_DB
            .scope(url, crate::module::workflow::compile(dsl, &Default::default(), None))
            .await?;
        let input = serde_json::from_value(request.initial_state)?;
        let result = graph.run_stream(input, &request.thread_id, false, None, |_| {}).await?;
        anyhow::ensure!(!result.interrupted, "read-only acceptance flow should not pause");
        self.observations
            .lock()
            .unwrap()
            .insert(request.run_id, serde_json::to_value(result.state)?);
        Ok(())
    }
    async fn inspect(&self, id: &str) -> Result<RunObservation> {
        let state = self
            .observations
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("acceptance execution missing")?;
        Ok(RunObservation {
            status: "completed".into(),
            name: "Local expense review".into(),
            error: None,
            state,
        })
    }
}

async fn acceptance(model: &dyn Llm, amount: f64) -> Result<Value> {
    let workflow: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json"))?;
    let input = format!("使用费用审核工作流检查金额 {amount} 是否需要人工审核");
    let capabilities = || {
        vec![tools::Capability {
            id: "expense-review".into(),
            name: "费用审核".into(),
            description: "只读本地费用规则审核，金额不少于1000需人工审核，不进行付款或业务变更".into(),
            parameters: json!({"type":"object","properties":{"amount":{"type":"number","minimum":0}},"required":["amount"],"additionalProperties":false}),
        }]
    };
    let runtime = super::tests::runtime();
    let reply = runtime
        .run(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: vec![Content::new("user").with_text(&input)],
                capabilities: capabilities(),
            },
            &|_| Ok(()),
        )
        .await?;
    let call = reply.call.context("model did not select the expense-review workflow")?;
    anyhow::ensure!(
        call.workflow_id == "expense-review" && call.input["amount"].as_f64() == Some(amount),
        "incorrect workflow selection or amount"
    );
    anyhow::ensure!(
        catalog::validate_input(&workflow["document"]["settings"], &call.input)?,
        "acceptance input incomplete"
    );
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await?;
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261016100000_assistant_sessions.up.sql"
    ))
    .execute(&pool)
    .await?;
    sqlx::query("CREATE TABLE run_records(id TEXT PRIMARY KEY,workspace_id TEXT)")
        .execute(&pool)
        .await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut session = json!({"id":id,"status":"thinking","messages":[
        {"id":"user","role":"user","text":input,"content":Content::new("user").with_text(&input)},
        {"id":"assistant","role":"assistant","text":reply.text,"content":reply.content}
    ],"activeCall":{"workflowId":call.workflow_id,"toolName":call.tool_name,"callId":call.call_id,"input":call.input,"workflow":workflow}});
    let runs = GraphRuns {
        pool: pool.clone(),
        session_id: id,
        observations: Mutex::new(HashMap::new()),
        starts: AtomicUsize::new(0),
    };
    let dsl = catalog::document_dsl(&workflow)?;
    dispatch(&pool, "personal", &mut session, call.input, dsl, &runs).await?;
    let record = session["messages"].as_array().unwrap().last().unwrap();
    let response = &record["content"]["parts"][0]["functionResponse"]["response"];
    // Exercise result binding from the real engine receipt into an App input
    // contract, including providers that omit function-call IDs. This does not
    // execute the downstream App or grant another execution in this turn.
    let app_input_schema = crate::module::process_node::contract_schema(&std::collections::BTreeMap::from([(
        "amount".into(),
        json!({"type":"number"}),
    )]));
    let app_input = super::bindings::resolve(
        &app_input_schema,
        &json!({"amount":{"source":"result","run_id":response["runId"],"pointer":"/amount"}}),
        &[serde_json::from_value(record["content"].clone())?],
    )?;
    anyhow::ensure!(
        app_input["amount"].as_f64() == Some(amount),
        "Real workflow output did not bind to App input"
    );
    let state: Value = serde_json::from_str(response["result"].as_str().context("real graph result missing")?)?;
    let expected_route = if amount >= 1000.0 { "true" } else { "false" };
    let observation = runs
        .inspect(response["runId"].as_str().context("run ID missing")?)
        .await?;
    let assessment = super::outcome_evaluation::assess(
        Some(&observation),
        &[
            ("/global/amount", json!(amount)),
            ("/workflow/workflow.trace/0/result/route", json!(expected_route)),
        ],
    );
    anyhow::ensure!(
        assessment.verdict == super::outcome_evaluation::Verdict::Passed,
        "native run did not fulfill independent outcome checks: {assessment:?}"
    );
    let contents = session["messages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|message| serde_json::from_value(message["content"].clone()))
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let summary = runtime
        .run(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents,
                capabilities: capabilities(),
            },
            &|_| Ok(()),
        )
        .await?;
    anyhow::ensure!(
        summary.call.is_none() && !summary.text.trim().is_empty(),
        "delivery attempted another execution or returned no answer"
    );
    anyhow::ensure!(
        runs.starts.load(Ordering::SeqCst) == 1,
        "workflow was dispatched more than once"
    );
    Ok(
        json!({"status":"passed","amount":amount,"route":expected_route,"dispatches":1,"engineState":state,"answer":summary.text,"productionQueueTested":false}),
    )
}

#[tokio::test]
async fn assistant_acceptance_executes_real_expense_rules_and_returns_receipts() {
    for (amount, route) in [(800.0, "false"), (1000.0, "true"), (1500.0, "true")] {
        let model = super::tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":"execution","actionQuote":format!("金额 {amount}"),"summary":"执行本地费用审核"})
                    .to_string(),
            ),
            Content {
                role: "model".into(),
                parts: vec![Part::FunctionCall {
                    name: "execute_workflow".into(),
                    args: json!({"workflow_id":"expense-review","input":{"amount":amount}}),
                    id: Some("expense-call".into()),
                    thought_signature: None,
                }],
            },
            Content::new("model").with_text("费用审核完成。"),
        ]);
        let result = acceptance(&model, amount).await.unwrap();
        assert_eq!(result["route"], route);
    }
}

#[tokio::test]
#[ignore = "uses configured Gemini and a real read-only graph in temporary storage"]
async fn live_assistant_real_workflow_acceptance() {
    let model = ProbeModel::new(
        Arc::new(super::tests::live_gemini_model_from_env()),
        Duration::from_secs(6),
    );
    let result = acceptance(&model, 1500.0).await.unwrap();
    let path = std::env::var_os("WORKRUN_ASSISTANT_ACCEPTANCE_REPORT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("workrun-assistant-acceptance.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&result).unwrap()).unwrap();
    println!("Real workflow acceptance report: {}", path.display());
}
