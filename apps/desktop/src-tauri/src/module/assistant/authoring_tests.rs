//! Protocol/engine acceptance with an isolated draft store. Scripted tests prove
//! handoff and repair, not model reasoning; the opt-in test exercises Gemini too.
use super::*;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct DraftStore {
    root: tempfile::TempDir,
    saved: Mutex<Option<Value>>,
    rejected: AtomicUsize,
}
impl DraftStore {
    fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            saved: Mutex::new(None),
            rejected: 0.into(),
        }
    }
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for DraftStore {
    async fn list(&self, _: &Value) -> Result<Value> {
        Ok(json!({"items":[],"nextCursor":null}))
    }
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        if let Some(id) = args["capability_id"].as_str() {
            let entry = authoring::load(
                self.root.path(),
                id.strip_prefix("draft:").context("Not a draft")?,
                true,
            )?;
            return Ok(json!({"items":[capability::Contract::workflow(&entry)?],"nextCursor":null}));
        }
        self.list(args).await
    }
    async fn describe(&self, id: &str) -> Result<tools::Capability> {
        let entry = authoring::load(
            self.root.path(),
            id.strip_prefix("draft:").context("Not a draft")?,
            true,
        )?;
        Ok(capability::Contract::workflow(&entry)?.legacy())
    }
    async fn authoring(&self, name: &str, args: &Value) -> Result<Value> {
        let result = match name {
            "validate_workflow_draft" => {
                let document = if let Some(id) = args["draft_id"].as_str() {
                    authoring::load(self.root.path(), id, false)?["document"].clone()
                } else {
                    authoring::parse_document(args)?
                };
                authoring::validate(&document, &Default::default()).await?
            },
            "save_workflow_draft" => {
                let saved =
                    authoring::save(self.root.path(), authoring::parse_document(args)?, &Default::default()).await?;
                *self.saved.lock().unwrap() = Some(saved.clone());
                saved
            },
            "get_workflow_draft" => authoring::load(
                self.root.path(),
                args["draft_id"].as_str().context("Missing draft ID")?,
                false,
            )?,
            "list_authoring_resources" => json!({"items":[]}),
            _ => bail!("Unknown test authoring tool"),
        };
        if result["valid"] == false {
            self.rejected.fetch_add(1, Ordering::SeqCst);
        }
        Ok(result)
    }
}
fn document() -> Value {
    let workflow: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json")).unwrap();
    workflow["document"].clone()
}
struct AuthorModel {
    step: AtomicUsize,
    store: Arc<DraftStore>,
}
#[async_trait::async_trait]
impl Llm for AuthorModel {
    fn name(&self) -> &str {
        "scripted-author"
    }
    async fn generate_content(&self, request: LlmRequest, _: bool) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        let count = self.step.fetch_add(1, Ordering::SeqCst);
        if count == 2 {
            assert!(request.tools.contains_key("transfer_to_agent"));
            return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::LlmResponse::new(
                super::tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
            ))])));
        }
        let step = if count >= 3 { count - 1 } else { count };
        let mut document = document();
        let (name, args) = match step {
            0 => return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::prelude::LlmResponse {
                content:Some(Content::new("model").with_text(json!({"intent":"execution","actionQuote":"创建并执行","authoringQuote":"创建并执行","summary":"编排金额分流工作流"}).to_string())),..Default::default()
            })]))),
            1 => {
                assert!(!request.tools.contains_key("get_workflow_reference"));
                ("prepare_workflow_task",json!({"goal":"创建金额分流流程","expected_outputs":["按条件选择分支"],"acceptance_criteria":["金额1500命中true分支"]}))
            },
            2 => ("read_skill",json!({"name":"workflow-authoring"})),
            3 => ("get_workflow_reference",json!({"topic":"nodes","node_types":["start","if_else","end"]})),
            4 => { document["edges"][1]["sourceHandle"]=json!("invalid"); ("validate_workflow_draft",json!({"document_json":document.to_string()})) },
            5 => ("validate_workflow_draft",json!({"document_json":document.to_string()})),
            6 => ("save_workflow_draft",json!({"document_json":document.to_string()})),
            7 => {
                assert!(!request.tools.contains_key("execute_capability"));
                return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::prelude::LlmResponse::new(Content::new("model").with_text(json!({"status":"completed","summary":"流程已保存","assumptions":[]}).to_string())))])));
            },
            8 => {
                assert!(!request.tools.contains_key("save_workflow_draft"));
                let saved=self.store.saved.lock().unwrap().clone().unwrap();
                ("execute_capability",json!({"capability_id":saved["capability_id"],"bindings":[{"input":"amount","source":"message","message":0,"quote":"1500","value_json":"1500"}]}))
            },
            9 => {
                assert!(!request.tools.contains_key("execute_capability"));
                return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::prelude::LlmResponse::new(Content::new("model").with_text("1500 命中 true 分支。")))])));
            },
            _=>panic!("Unexpected model step"),
        };
        assert!(request.tools.contains_key(name));
        Ok(Box::pin(futures::stream::iter([Ok(adk_rust::prelude::LlmResponse {
            content: Some(Content {
                role: "model".into(),
                parts: vec![Part::FunctionCall {
                    name: name.into(),
                    args,
                    id: Some(format!("author-{step}")),
                    thought_signature: None,
                }],
            }),
            ..Default::default()
        })])))
    }
}

async fn run_generated_graph(model: &dyn Llm, store: &DraftStore, input: &str) -> Result<Value> {
    let runtime = super::tests::runtime();
    let user = Content::new("user").with_text(input);
    let reply = runtime
        .run_with_discovery(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            store,
        )
        .await?;
    let call = reply.call.context("No generated workflow execution proposed")?;
    anyhow::ensure!(
        call.tool_name == "execute_capability" && call.workflow_id.starts_with("draft:"),
        "Expected generated draft execution"
    );
    anyhow::ensure!(
        call.input["amount"].as_f64() == Some(1500.0),
        "Incorrect extracted amount"
    );
    let draft = authoring::load(
        store.root.path(),
        call.workflow_id.strip_prefix("draft:").unwrap(),
        true,
    )?;
    anyhow::ensure!(
        draft["document"]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| matches!(node["type"].as_str(), Some("start" | "end" | "if_else" | "group"))),
        "Acceptance graph must use base rule nodes, no existing capabilities"
    );
    let dsl = catalog::document_dsl(&draft)?;
    let checkpoint = store.root.path().join("execution.sqlite");
    std::fs::File::create(&checkpoint)?;
    let graph = crate::module::workflow::TEST_CHECKPOINT_DB
        .scope(
            format!("sqlite://{}", checkpoint.display()),
            crate::module::workflow::compile(serde_json::from_value(dsl)?, &Default::default(), None),
        )
        .await?;
    let result = graph
        .run_stream(
            serde_json::from_value(call.input)?,
            "generated-acceptance",
            false,
            None,
            |_| {},
        )
        .await?;
    anyhow::ensure!(!result.interrupted, "Rule acceptance graph must complete");
    let state = serde_json::to_value(result.state)?;
    let trace = state["workflow"]["workflow.trace"]
        .as_array()
        .context("Execution trace missing")?;
    anyhow::ensure!(
        trace
            .iter()
            .any(|event| event["type"] == "if_else" && event["result"]["route"] == "true"),
        "Expected actual engine true branch"
    );
    let receipt: Content = serde_json::from_value(
        json!({"role":"function","parts":[{"functionResponse":{"name":call.tool_name,"response":{"runId":"generated-acceptance","status":"completed","result":state.to_string(),"output":capability::validated_output(&draft,&state)?}},"id":call.call_id}]}),
    )?;
    let summary = runtime
        .run_with_discovery(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: vec![user, reply.content, receipt],
                capabilities: vec![],
            },
            &|_| Ok(()),
            store,
        )
        .await?;
    anyhow::ensure!(
        summary.call.is_none() && !summary.text.trim().is_empty(),
        "Result delivery must not execute again"
    );
    for contradiction in ["未能实际执行", "未实际执行", "未执行", "无法执行"] {
        anyhow::ensure!(
            !summary.text.contains(contradiction),
            "Delivery contradicted the completed native receipt"
        );
    }
    Ok(json!({"status":"passed","draft":draft,"engineState":state,"answer":summary.text,"productionQueueTested":false}))
}

#[tokio::test]
async fn generated_workflow_is_repaired_saved_and_executed_from_base_nodes() {
    let store = Arc::new(DraftStore::new());
    let model = AuthorModel {
        step: 0.into(),
        store: store.clone(),
    };
    let report = run_generated_graph(
        &model,
        &store,
        "创建并执行金额分流工作流，金额1500，至少1000走true，否则false",
    )
    .await
    .unwrap();
    assert_eq!(store.rejected.load(Ordering::SeqCst), 1);
    assert_eq!(report["status"], "passed");
    assert_eq!(model.step.load(Ordering::SeqCst), 11);
}

#[tokio::test]
async fn authoring_intent_can_save_but_cannot_dispatch() {
    let store = DraftStore::new();
    let model = super::tests::ScriptedModel::new(vec![
        Content::new("model").with_text(
            json!({"intent":"authoring","actionQuote":"创建草稿","summary":"只保存流程，不运行"}).to_string(),
        ),
        super::tests::call(
            "prepare_workflow_task",
            json!({"goal":"创建金额分流草稿","expected_outputs":["可复用流程"],"acceptance_criteria":["编译通过"]}),
        ),
        super::tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        super::tests::call("save_workflow_draft", json!({"document_json":document().to_string()})),
        Content::new("model").with_text(json!({"status":"completed","summary":"已保存","assumptions":[]}).to_string()),
        Content::new("model").with_text("草稿已保存，未执行。"),
    ]);
    let reply = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: vec![Content::new("user").with_text("创建草稿，不要运行")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(
        store.saved.lock().unwrap().as_ref().unwrap()["validation"]["valid"],
        true
    );
    let decision = TurnDecision {
        intent: Intent::Authoring,
        action_quote: "创建草稿".into(),
        summary: "保存草稿".into(),
        reuse_existing: false,
        authoring_quote: String::new(),
    };
    assert!(decision.allows_authoring("创建草稿，不要运行"));
    assert!(!decision.allows_execution("创建草稿，不要运行"));
    let save_only = TurnDecision {
        action_quote: String::new(),
        authoring_quote: "创建草稿".into(),
        ..decision
    };
    assert!(save_only.allows_authoring("创建草稿，不要运行"));
    assert!(!save_only.allows_execution("创建草稿，不要运行"));
}

#[tokio::test]
#[ignore = "uses configured Gemini; saves only a temporary rule-graph draft"]
async fn live_draft_only_authoring_has_no_execution_grant() {
    let store = DraftStore::new();
    let model = super::evaluation::ProbeModel::new(
        Arc::new(super::tests::live_gemini_model_from_env()),
        Duration::from_secs(6),
    );
    let reply = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(uuid::Uuid::new_v4().to_string()),
                    ..Default::default()
                },
                contents: vec![Content::new("user").with_text(
                    "帮我保存一个以后能重复使用的金额分流流程：输入金额，至少1000归为大额，否则归为小额。先不要运行。",
                )],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Live draft authoring failed ({}); tools={:?}, saved={}, empty_answer={}, interrupted={}, intent={:?}",
                super::evaluation::error_label(&error),
                model.called_tools(),
                store.saved.lock().unwrap().is_some(),
                error.to_string().contains("no answer"),
                error.to_string().contains("interrupted"),
                model.last_intent()
            )
        });
    assert_eq!(model.last_intent(), Some(Intent::Authoring));
    assert!(reply.call.is_none());
    assert!(
        store.saved.lock().unwrap().is_some(),
        "No workflow saved; tools={:?}, reply={}",
        model.called_tools(),
        reply.text
    );
    assert_eq!(
        store.saved.lock().unwrap().as_ref().unwrap()["validation"]["valid"],
        true
    );
    println!("Draft-only authoring: saved valid draft without execution grant");
}

#[tokio::test]
#[ignore = "uses configured Gemini; generated base-node graph only, temporary draft and checkpoint storage"]
async fn live_base_node_workflow_authoring_acceptance() {
    let store = DraftStore::new();
    let model = super::evaluation::ProbeModel::new(
        Arc::new(super::tests::live_gemini_model_from_env()),
        Duration::from_secs(6),
    );
    let mut report=run_generated_graph(&model,&store,"请创建并执行一个全新的只读工作流，用基础节点按金额分流：输入amount为1500，amount >= 1000走true，否则走false，然后结束。不要引用已有工作流或App，不需要LLM节点或人工审核。请查阅编排说明、校验并保存草稿，实际执行后说明命中了哪个分支。").await.unwrap_or_else(|error|panic!("Live generated graph failed ({})",super::evaluation::error_label(&error)));
    let tools = model
        .called_tools()
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    assert!(
        tools.contains("get_workflow_reference"),
        "Model did not consult authoring reference"
    );
    report["toolsUsed"] = json!(tools);
    let path = std::env::var_os("WORKRUN_AUTHORING_REPORT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("workrun-authoring-acceptance.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
    println!("Generated Workflow acceptance: {}", path.display());
}
