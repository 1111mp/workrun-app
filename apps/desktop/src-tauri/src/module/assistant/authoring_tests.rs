//! Protocol/engine acceptance with an isolated draft store. Scripted tests prove
//! handoff and repair, not model reasoning; the opt-in test exercises Gemini too.
use super::*;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

pub(super) struct DraftStore {
    pub(super) root: tempfile::TempDir,
    pub(super) session_id: String,
    pub(super) saved: Mutex<Option<Value>>,
    rejected: AtomicUsize,
    pub(super) turns: Mutex<Vec<Value>>,
}
impl DraftStore {
    pub(super) fn new() -> Self {
        Self {
            root: tempfile::tempdir().unwrap(),
            session_id: uuid::Uuid::new_v4().to_string(),
            saved: Mutex::new(None),
            rejected: 0.into(),
            turns: Mutex::new(vec![]),
        }
    }
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for DraftStore {
    async fn workflow_plan(&self, session: &str) -> Result<Option<Value>> {
        let store = planning_agent::plans::Store::new(self.root.path());
        let Some(plan) = store.current(session)? else {
            return Ok(None);
        };
        let tasks = task_runtime::TaskRuntime::open(self.root.path()).await?;
        if tasks.interaction(&plan).await?.is_none() {
            // Some engine tests seed an already approved native proposal.
            let proposal = store.revision(session, plan.version)?;
            tasks.suspend(&proposal).await?;
            if plan.status == "approved" {
                tasks.decide(&proposal, true).await?;
            }
        }
        Ok(Some(tasks.decorate(&plan).await?))
    }

    async fn plan_operation(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        super::planning_tests::operate(self.root.path(), session, name, args, artifacts).await
    }
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
    async fn record_turn(&self, record: &Value) -> Result<()> {
        self.turns.lock().unwrap().push(record.clone());
        Ok(())
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
        let step = self.step.fetch_add(1, Ordering::SeqCst);
        let mut document = document();
        let (name,args)=match step {
            0=>("transfer_to_agent",json!({"agent_name":"workflow_author"})),
            1=>("read_skill",json!({"name":"workflow-authoring"})),
            2=>("get_workflow_reference",json!({"topic":"nodes","node_types":["start","if_else","end"]})),
            3=>{document["edges"][1]["sourceHandle"]=json!("invalid");("validate_workflow_draft",json!({"document_json":document.to_string()}))},
            4=>("validate_workflow_draft",json!({"document_json":document.to_string()})),
            5=>("save_workflow_draft",json!({"document_json":document.to_string()})),
            6|7|10=>{
                let text=if step==6 {json!({"status":"completed","summary":"流程已保存","assumptions":[]}).to_string()}
                    else if step==7 {"流程已保存，没有运行。".into()}else{"1500 命中 true 分支。".into()};
                return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::LlmResponse::new(Content::new("model").with_text(text)))])));
            },
            8=>return Ok(Box::pin(futures::stream::iter([Ok(adk_rust::LlmResponse::new(Content::new("model").with_text(json!({"intent":"execution","actionQuote":"执行保存的流程","authoringQuote":"","reuseExisting":true,"summary":"运行已保存流程"}).to_string())))]))),
            9=>{let saved=self.store.saved.lock().unwrap().clone().unwrap();("execute_capability",json!({"capability_id":saved["capability_id"],"bindings":[{"input":"amount","source":"message","message":0,"quote":"1500","value_json":"1500"}]}))},
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
    super::planning_tests::seed_approved(store.root.path(), &store.session_id, std::slice::from_ref(&user));
    let created = runtime
        .run_with_discovery(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            store,
        )
        .await?;
    anyhow::ensure!(
        created.call.is_none(),
        "Confirmed plan creates only; execution is separate"
    );
    let reply = runtime
        .run_with_discovery(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
                contents: vec![
                    user.clone(),
                    created.content,
                    Content::new("user").with_text("执行保存的流程"),
                ],
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
    super::planning_tests::seed_approved(
        store.root.path(),
        &store.session_id,
        &[Content::new("user").with_text("创建草稿，不要运行")],
    );
    let model = super::tests::ScriptedModel::new(vec![
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
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
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
        tool_confirmation: None,
        plan_feedback: None,
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
        Duration::from_secs(2),
    );
    let user = Content::new("user").with_text("我经常需要判断一个金额是否达到1000：达到标为大额，否则标为小额。把这个处理方式整理成以后能重复用的流程，先不要运行。");
    let context = || protocol::AssistantContext {
        session_id: Some(store.session_id.clone()),
        ..Default::default()
    };
    let proposal = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Live planning failed: {}; tools={:?}",
                super::evaluation::error_label(&error),
                model.called_tools()
            )
        });
    assert!(
        proposal.pause.is_some(),
        "Expected native pause; tools={:?}",
        model.called_tools()
    );
    assert!(proposal.text.is_empty());
    assert!(store.saved.lock().unwrap().is_none());
    let plan_store = planning_agent::plans::Store::new(store.root.path());
    let plan = plan_store.current(&store.session_id).unwrap().unwrap();
    assert_eq!(
        plan.status, "ready",
        "A simple fully specified task must be reviewable; questions={:?}, issues={:?}",
        plan.document.questions, plan.dependency_issues
    );
    let tasks = task_runtime::TaskRuntime::open(store.root.path()).await.unwrap();
    assert_eq!(tasks.interaction(&plan).await.unwrap().unwrap().status, "waiting");
    assert!(tasks.require_creation(&plan).await.is_err());
    assert_eq!(model.last_intent(), Some(Intent::Authoring));
    let tools_before = model.called_tools().len();
    let run = Content::new("user").with_text("执行一下呢");
    let blocked = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(),
                contents: vec![user.clone(), run.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Live pending-run failed: {}; tools={:?}",
                super::evaluation::error_label(&error),
                model.called_tools()
            )
        });
    assert_eq!(
        blocked.pause.as_ref().map(|p| p["reason"].as_str()),
        Some(Some("confirmation_required")),
        "Run request unexpectedly changed the task; tools={:?}",
        model.called_tools()
    );
    assert_eq!(model.called_tools().len(), tools_before);
    assert_eq!(
        plan_store.current(&store.session_id).unwrap().unwrap().version,
        plan.version
    );
    let confirmation = Content::new("user").with_text("确认当前方案并创建工作流，先不要运行。");
    let history = vec![user, run, confirmation];
    let turn = tool_execution::digest(&protocol::normalize_assistant_contents(history.clone()).unwrap()).unwrap();
    super::planning_tests::operate(
        store.root.path(),
        &store.session_id,
        "approve",
        &json!({"plan_id":plan.id,"version":plan.version,"turn_key":turn}),
        &[],
    )
    .await
    .unwrap();
    let created = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(),
                contents: history,
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap_or_else(|error| {
            panic!(
                "Live confirmed creation failed: {}; tools={:?}",
                super::evaluation::error_label(&error),
                model.called_tools()
            )
        });
    assert!(created.pause.is_none());
    assert!(created.call.is_none());
    let saved = plan_store.current(&store.session_id).unwrap().unwrap();
    assert_eq!(saved.status, "saved", "tools={:?}", model.called_tools());
    assert_eq!(
        store.saved.lock().unwrap().as_ref().unwrap()["validation"]["valid"],
        true
    );
    println!(
        "Live synthetic lifecycle: pause=true, workflow_before_approval=false, run_request_replanned=false, confirmed_creation_valid=true, executed=false; tools={:?}",
        model.called_tools()
    );
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

#[tokio::test]
async fn empty_confirmation_does_not_block_save_only_then_explicit_execution() {
    let store = DraftStore::new();
    let user = Content::new("user").with_text("以后重复做，整理成流程，先不要运行。输入金额1500");
    let placeholder = json!({"id":"","decision":"approve","quote":""});
    super::planning_tests::seed_approved(store.root.path(), &store.session_id, std::slice::from_ref(&user));
    let author = super::tests::ScriptedModel::new(vec![
        super::tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        super::tests::call("save_workflow_draft", json!({"document_json":document().to_string()})),
        Content::new("model")
            .with_text(json!({"status":"completed","summary":"流程已保存","assumptions":[]}).to_string()),
        Content::new("model").with_text("流程已保存，没有执行。"),
    ]);
    let context = || protocol::AssistantContext {
        session_id: Some(store.session_id.clone()),
        ..Default::default()
    };
    let saved_reply = super::tests::runtime()
        .run_with_discovery(
            &author,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    assert!(saved_reply.call.is_none());
    let saved = store.saved.lock().unwrap().clone().unwrap();
    assert_eq!(saved["validation"]["valid"], true);
    let model=super::tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"execution","actionQuote":"执行一下","authoringQuote":"","reuseExisting":true,"summary":"执行刚刚保存的流程","toolConfirmation":placeholder}).to_string()),
        super::tests::call("execute_capability",json!({"capability_id":saved["capability_id"],"bindings":[{"input":"amount","source":"message","message":0,"quote":"1500","value_json":"1500"}]})),
    ]);
    let result = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(),
                contents: vec![user, saved_reply.content, Content::new("user").with_text("执行一下")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    let call = result.call.unwrap();
    assert_eq!(call.workflow_id, saved["capability_id"].as_str().unwrap());
    assert_eq!(call.input["amount"], 1500);
    let requests = model.requests.lock().unwrap();
    assert!(!requests[1].tools.contains_key("transfer_to_agent"));
    assert!(!requests[1].tools.contains_key("prepare_workflow_task"));
    let turns = store.turns.lock().unwrap();
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["result"]["authoringAllowed"], true);
    assert_eq!(turns[0]["result"]["workflowExecutionAllowed"], false);
    assert_eq!(turns[1]["result"]["authoringAllowed"], false);
    assert_eq!(turns[1]["result"]["workflowExecutionAllowed"], true);
    assert!(turns[1]["decision"]["toolConfirmation"].is_null());
}

#[tokio::test]
async fn explicit_specialist_return_delivers_native_outcome_without_replaying_transfer() {
    let store = DraftStore::new();
    let user = Content::new("user").with_text("创建草稿，不要运行");
    super::planning_tests::seed_approved(store.root.path(), &store.session_id, std::slice::from_ref(&user));
    let named_call = |target: &str, id: &str| {
        let mut content = super::tests::call("transfer_to_agent", json!({"agent_name":target}));
        if let Part::FunctionCall { id: call_id, .. } = &mut content.parts[0] {
            *call_id = Some(id.into());
        }
        content
    };
    let model = super::tests::ScriptedModel::new(vec![
        named_call("workflow_author", "enter-author"),
        super::tests::call("save_workflow_draft", json!({"document_json":document().to_string()})),
        named_call("main_agent", "return-to-main"),
        Content::new("model").with_text("Saved without execution."),
    ]);
    let reply = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::DeepSeek,
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
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(store.saved.lock().unwrap().is_some());
    let requests = model.requests.lock().unwrap();
    let contents = &requests.last().unwrap().contents;
    let calls = contents
        .iter()
        .flat_map(|c| &c.parts)
        .filter(|part| {
            matches!(part,
        Part::FunctionCall {id:Some(id),..} if id=="return-to-main")
        })
        .count();
    let receipts = contents
        .iter()
        .flat_map(|c| &c.parts)
        .filter(|part| {
            matches!(part,
        Part::FunctionResponse {id:Some(id),..} if id=="return-to-main")
        })
        .count();
    assert_eq!(calls, 0);
    assert_eq!(receipts, 0);
    let serialized = serde_json::to_string(contents).unwrap();
    assert!(serialized.contains("Native specialist outcome"));
    assert!(serialized.contains("completed"));
    assert!(!serialized.contains("permissionDenied"));
}

#[tokio::test]
async fn author_internals_are_isolated_but_coordinator_reads_and_signatures_survive() {
    let store = DraftStore::new();
    let user = Content::new("user").with_text("创建草稿，不要运行");
    super::planning_tests::seed_approved(store.root.path(), &store.session_id, std::slice::from_ref(&user));
    let signed_read = |id: &str| {
        let mut content = super::tests::call("list_capabilities", json!({}));
        if let Part::FunctionCall {
            id: call_id,
            thought_signature,
            ..
        } = &mut content.parts[0]
        {
            *call_id = Some(id.into());
            *thought_signature = Some("coordinator-signature".into());
        }
        content
    };
    let mut delivery_reads = signed_read("delivery-read-1");
    delivery_reads.parts.push(Part::FunctionCall {
        name: "read_skill".into(),
        args: json!({"name":"missing-delivery-skill"}),
        id: Some("delivery-read-error".into()),
        thought_signature: Some("coordinator-signature".into()),
    });
    let model = super::tests::ScriptedModel::new(vec![
        super::tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        super::tests::call("get_workflow_reference", json!({"topic":"configuration"})),
        super::tests::call("save_workflow_draft", json!({"document_json":document().to_string()})),
        Content::new("model")
            .with_text(json!({"status":"completed","summary":"Saved native draft.","assumptions":[]}).to_string()),
        delivery_reads,
        signed_read("delivery-read-2"),
        Content::new("model").with_text("Saved without execution."),
    ]);
    let reply = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::DeepSeek,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(store.saved.lock().unwrap().is_some());
    {
        let requests = model.requests.lock().unwrap();
        let author_history = serde_json::to_string(&requests[3].contents).unwrap();
        let delivery = &requests[4].contents;
        let delivery_text = serde_json::to_string(delivery).unwrap();
        assert!(author_history.contains("# Native resource configuration"));
        assert!(author_history.contains("save_workflow_draft"));
        assert!(!delivery_text.contains("# Native resource configuration"));
        assert!(!delivery_text.contains("save_workflow_draft"));
        assert!(!delivery_text.contains("permissionDenied"));
        assert!(delivery_text.contains("Saved native draft."));
        assert!(delivery_text.contains("创建草稿，不要运行"));
        assert!(delivery_text.len() < author_history.len());
        let final_contents = &requests.last().unwrap().contents;
        assert!(final_contents.iter().flat_map(|c| &c.parts).any(|part| matches!(part,
        Part::FunctionResponse { id:Some(id), function_response, .. } if id == "delivery-read-error" && function_response.response.get("error").is_some()
    )));
        for id in ["delivery-read-1", "delivery-read-error", "delivery-read-2"] {
            assert!(final_contents.iter().flat_map(|c| &c.parts).any(|part| matches!(part,
            Part::FunctionCall{id:Some(call_id),thought_signature:Some(signature),..}
            if call_id==id && signature=="coordinator-signature")));
            assert!(final_contents.iter().flat_map(|c| &c.parts).any(|part| matches!(part,
            Part::FunctionResponse{id:Some(call_id),..} if call_id==id)));
        }
    }
    // The session persists reply.content, not the SDK specialist transcript.
    // Starting another user turn must preserve that boundary and the user goal.
    let next = super::tests::ScriptedModel::new(vec![
        Content::new("model")
            .with_text(json!({"intent":"conversation","actionQuote":"","summary":"Continue conversation"}).to_string()),
        Content::new("model").with_text("The saved draft is unchanged."),
    ]);
    let next_reply = super::tests::runtime()
        .run_with_discovery(
            &next,
            &ModelProvider::DeepSeek,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some(store.session_id.clone()),
                    ..Default::default()
                },
                contents: vec![
                    user,
                    reply.content,
                    Content::new("user").with_text("谢谢，保持草稿，不要运行"),
                ],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    assert!(next_reply.call.is_none());
    for request in next.requests.lock().unwrap().iter() {
        let history = serde_json::to_string(&request.contents).unwrap();
        assert!(!history.contains("# Native resource configuration"));
        assert!(!history.contains("document_json"));
        assert!(history.contains("Saved without execution."));
        assert!(history.contains("创建草稿，不要运行"));
    }
}

#[tokio::test]
async fn saved_outcome_does_not_authorize_a_new_coordinator_write() {
    let store = DraftStore::new();
    let user = Content::new("user").with_text("创建草稿，不要运行");
    super::planning_tests::seed_approved(store.root.path(), &store.session_id, std::slice::from_ref(&user));
    let model = super::tests::ScriptedModel::new(vec![
        super::tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        super::tests::call("save_workflow_draft", json!({"document_json":document().to_string()})),
        Content::new("model").with_text(json!({"status":"completed","summary":"Saved.","assumptions":[]}).to_string()),
        super::tests::call("save_workflow_draft", json!({"document_json":"{}"})),
        Content::new("model").with_text("The original draft was saved; no additional edits or execution occurred."),
    ]);
    let reply = super::tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::DeepSeek,
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
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(store.saved.lock().unwrap().is_some());
    let requests = model.requests.lock().unwrap();
    let history = serde_json::to_string(&requests.last().unwrap().contents).unwrap();
    assert!(history.contains("permissionDenied"));
    assert!(history.contains("Native specialist outcome"));
    assert!(history.contains("completed"));
    assert!(!requests.last().unwrap().tools.contains_key("save_workflow_draft"));
}
