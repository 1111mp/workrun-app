//! Lifecycle acceptance uses a temporary catalog, never the user's saved definitions.
use super::*;
use planning_agent::plans::{Document, Store};
use serde_json::Value;
use std::sync::{Arc, Mutex};

struct Workspace {
    root: tempfile::TempDir,
    id: String,
    reads: Mutex<usize>,
    writes: Mutex<Vec<Value>>,
}
impl Workspace {
    fn new() -> Self {
        let workspace = Self {
            root: tempfile::tempdir().unwrap(),
            id: uuid::Uuid::new_v4().to_string(),
            reads: Mutex::new(0),
            writes: Mutex::new(vec![]),
        };
        let mut entry: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json")).unwrap();
        entry["id"] = json!(workspace.id);
        std::fs::write(workspace.root.path().join("workflow.json"), entry.to_string()).unwrap();
        workspace
    }
    fn entry(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.root.path().join("workflow.json")).unwrap()).unwrap()
    }
    async fn saved_plan(&self, session: &str) {
        let store = Store::new(self.root.path());
        let plan = store
            .save(
                session,
                "earlier",
                0,
                Document::parse(&planning_tests::document()).unwrap(),
                vec![],
            )
            .unwrap();
        let tasks = task_runtime::TaskRuntime::open(self.root.path()).await.unwrap();
        tasks.suspend(&plan).await.unwrap();
        tasks.decide(&plan, true).await.unwrap();
        store.decide(session, &plan.id, 1, true, "earlier-approval").unwrap();
        store.transition(session, &plan.id, 1, "building", None).unwrap();
        let saved = store
            .transition(session, &plan.id, 1, "saved", Some(json!({"workflow_id":self.id})))
            .unwrap();
        tasks.finish(&saved).await.unwrap();
    }
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for Workspace {
    async fn list(&self, args: &Value) -> Result<Value> {
        if let Some(query) = args["query"].as_str() {
            let contract = capability::Contract::workflow(&self.entry())?;
            if !format!("{} {}", contract.name, contract.description)
                .to_lowercase()
                .contains(&query.to_lowercase())
            {
                return Ok(json!({"items":[],"nextCursor":null}));
            }
        }
        Ok(json!({"items":[capability::Contract::workflow(&self.entry())?.summary()],"nextCursor":null}))
    }
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        if let Some(id) = args["capability_id"].as_str() {
            anyhow::ensure!(id == self.id, "Unknown workflow");
            return Ok(json!({"items":[capability::Contract::workflow(&self.entry())?],"nextCursor":null}));
        }
        self.list(args).await
    }
    async fn describe(&self, id: &str) -> Result<tools::Capability> {
        anyhow::ensure!(id == self.id, "Unknown workflow");
        Ok(capability::Contract::workflow(&self.entry())?.legacy())
    }
    async fn workflow_plan(&self, session: &str) -> Result<Option<Value>> {
        Ok(Store::new(self.root.path())
            .current(session)?
            .map(|p| serde_json::to_value(p).unwrap()))
    }
    async fn plan_operation(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        planning_tests::operate(self.root.path(), session, name, args, artifacts).await
    }
    async fn authoring(&self, name: &str, args: &Value) -> Result<Value> {
        match name {
            "get_workflow_draft" => {
                anyhow::ensure!(args["draft_id"] == self.id, "Wrong revision read target");
                *self.reads.lock().unwrap() += 1;
                Ok(self.entry())
            },
            "save_workflow_draft" => {
                anyhow::ensure!(args["target_id"] == self.id, "Revision must preserve identity");
                let document = authoring::parse_document(args)?;
                let validation = authoring::validate(&document, &Default::default()).await?;
                anyhow::ensure!(validation["valid"] == true, "Invalid revision");
                self.writes.lock().unwrap().push(args.clone());
                let mut entry = self.entry();
                entry["document"] = document;
                std::fs::write(self.root.path().join("workflow.json"), entry.to_string())?;
                Ok(json!({"capability_id":self.id,"draft_id":self.id,"validation":validation,"executed":false}))
            },
            _ => bail!("Unexpected authoring tool"),
        }
    }
}
fn context(session: &str) -> protocol::AssistantContext {
    protocol::AssistantContext {
        session_id: Some(session.into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn approved_edit_receives_current_graph_once_and_saves_only_the_original_target() {
    let workspace = Workspace::new();
    let sid = uuid::Uuid::new_v4().to_string();
    workspace.saved_plan(&sid).await;
    let mut document = planning_tests::document();
    document["target_id"] = json!(workspace.id);
    let store = Store::new(workspace.root.path());
    let plan = store
        .save(&sid, "edit", 1, Document::parse(&document).unwrap(), vec![])
        .unwrap();
    task_runtime::TaskRuntime::open(workspace.root.path())
        .await
        .unwrap()
        .suspend(&plan)
        .await
        .unwrap();
    let history = vec![Content::new("user").with_text("Confirm the revised plan; save only")];
    let turn = tool_execution::digest(&protocol::normalize_assistant_contents(history.clone()).unwrap()).unwrap();
    planning_tests::operate(
        workspace.root.path(),
        &sid,
        "approve",
        &json!({"plan_id":plan.id,"version":2,"turn_key":turn}),
        &[],
    )
    .await
    .unwrap();
    let mut graph = workspace.entry()["document"].clone();
    graph["settings"]["name"] = json!("Revised rule");
    let scripted = Arc::new(tests::ScriptedModel::new(vec![
        tests::call("report_progress", json!({"summary":"Updating the existing rule"})),
        // Model-selected targets cannot replace the target confirmed by the user.
        tests::call(
            "save_workflow_draft",
            json!({"document_json":graph.to_string(),"target_id":uuid::Uuid::new_v4().to_string(),"session_id":"forged-session"}),
        ),
        Content::new("model")
            .with_text(r#"{"status":"completed","summary":"Updated the existing workflow","assumptions":[]}"#),
        Content::new("model").with_text("Updated; not run."),
    ]));
    let model = evaluation::ProbeModel::new(scripted.clone(), Duration::ZERO);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&sid),
                contents: history,
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    let cost = model.costs_since(0);
    assert_eq!(cost["phases"]["authoring"]["callCount"], 3);
    assert_eq!(cost["phases"]["conversation"]["callCount"], 1);
    assert_eq!(cost["missingUsageCalls"], 4);
    assert_eq!(cost["executionIncluded"], false);
    assert!(reply.call.is_none());
    assert_eq!(*workspace.reads.lock().unwrap(), 2);
    assert_eq!(workspace.writes.lock().unwrap().len(), 1);
    assert_eq!(workspace.writes.lock().unwrap()[0]["session_id"], sid);
    assert_eq!(workspace.entry()["document"], graph);
    let saved = store.current(&sid).unwrap().unwrap();
    assert_eq!(saved.workflow_id.as_deref(), Some(workspace.id.as_str()));
    {
        let requests = scripted.requests.lock().unwrap();
        assert_eq!(requests.len(), 4); // Progress, save, specialist outcome, delivery.
        assert!(requests[0].tools.contains_key("save_workflow_draft"));
        assert!(!requests[0].tools.contains_key("execute_capability"));
    }
    for request in scripted
        .requests
        .lock()
        .unwrap()
        .iter()
        .filter(|r| r.tools.contains_key("save_workflow_draft"))
    {
        assert!(
            request
                .contents
                .iter()
                .any(|c| content_text(c).contains("existing_workflow"))
        );
    }
}

#[tokio::test]
#[ignore = "uses configured Gemini; returns dispatches/proposals only, with temporary resources"]
async fn live_new_conversations_reuse_saved_workflow_report_usage() {
    let workspace = Workspace::new();
    let model = evaluation::ProbeModel::new(Arc::new(tests::live_gemini_model_from_env()), Duration::from_secs(6));
    // No earlier conversation: discovery must find the existing implementation.
    for message in ["审核金额为1500的费用。", "审核金额为500的费用。"] {
        let before = model.usage().len();
        let reply = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: context(&uuid::Uuid::new_v4().to_string()),
                    contents: vec![Content::new("user").with_text(message)],
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &workspace,
            )
            .await
            .unwrap();
        assert_eq!(reply.call.unwrap().workflow_id, workspace.id);
        assert!(workspace.writes.lock().unwrap().is_empty());
        eprintln!(
            "reuse_usage={} tools={:?}",
            json!(&model.usage()[before..]),
            model.called_tools()
        );
    }
}

#[tokio::test]
#[ignore = "uses configured Gemini; edits only a temporary workflow, never runs it"]
async fn live_saved_workflow_edit_preserves_identity_report_usage() {
    let workspace = Workspace::new();
    let model = evaluation::ProbeModel::new(Arc::new(tests::live_gemini_model_from_env()), Duration::from_secs(6));
    let sid = uuid::Uuid::new_v4().to_string();
    workspace.saved_plan(&sid).await;
    let before = model.usage().len();
    let reply =
        tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: context(&sid),
                    contents: vec![Content::new("user").with_text(
                        "修改一下刚才创建的工作流，把金额判断阈值从1000改成2000，其他保持不变，先不要运行。",
                    )],
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &workspace,
            )
            .await
            .unwrap();
    assert!(reply.pause.is_some());
    let plan = Store::new(workspace.root.path()).current(&sid).unwrap().unwrap();
    assert_eq!(plan.document.target_id.as_deref(), Some(workspace.id.as_str()));
    assert!(workspace.writes.lock().unwrap().is_empty());
    eprintln!("edit_plan_usage={}", json!(&model.usage()[before..]));
    let mut history = vec![
        Content::new("user").with_text("把刚才的金额判断阈值改成2000，其他保持不变"),
        reply.content,
        Content::new("user").with_text("确认第2版修改方案并保存，不运行"),
    ];
    history = protocol::normalize_assistant_contents(history).unwrap();
    let turn = tool_execution::digest(&history).unwrap();
    planning_tests::operate(
        workspace.root.path(),
        &sid,
        "approve",
        &json!({"plan_id":plan.id,"version":plan.version,"turn_key":turn}),
        &[],
    )
    .await
    .unwrap();
    let before = model.usage().len();
    let original = workspace.entry();
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&sid),
                contents: history,
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(workspace.writes.lock().unwrap().len(), 1);
    assert_eq!(*workspace.reads.lock().unwrap(), 2);
    let updated = workspace.entry();
    assert_eq!(updated["id"], original["id"]);
    assert!(updated["document"]["nodes"].to_string().contains("2000"));
    assert_eq!(updated["document"]["edges"], original["document"]["edges"]);
    assert_eq!(
        updated["document"]["settings"]["inputSchema"],
        original["document"]["settings"]["inputSchema"]
    );
    eprintln!("edit_save_usage={}", json!(&model.usage()[before..]));
}

/// Set WORKRUN_ASSISTANT_BASELINE_DIR to an earlier assistant source tree.
/// Compare serialized request sizes locally, including tool schemas; no provider calls.
#[tokio::test]
#[ignore = "requires explicit earlier baseline resources; entirely local"]
async fn local_task_prompt_budget_against_explicit_baseline() {
    let baseline = std::path::PathBuf::from(
        std::env::var_os("WORKRUN_ASSISTANT_BASELINE_DIR").expect("Explicit baseline required"),
    );
    let workspace = Workspace::new();
    let scripted = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(r#"{"intent":"task","actionQuote":"整理文档","summary":"整理文档","reuseExisting":false,"authoringQuote":""}"#),
        Content::new("model").with_text("OK"),
    ]);
    tests::runtime()
        .run_with_discovery(
            &scripted,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&uuid::Uuid::new_v4().to_string()),
                contents: vec![Content::new("user").with_text("整理文档内容")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    let intent_after = scripted.requests.lock().unwrap()[0].clone();
    let mut intent_before = intent_after.clone();
    for content in &mut intent_before.contents {
        for part in &mut content.parts {
            if let Part::Text { text, .. } = part {
                *text = text.replace(
                    &resources::read("main_agent/INTENT.md").unwrap(),
                    &std::fs::read_to_string(baseline.join("main_agent/INTENT.md")).unwrap(),
                );
            }
        }
    }
    let after = scripted.requests.lock().unwrap()[1].clone();
    let mut before = after.clone();
    before.tools.remove("execute_capability");
    before.tools.remove("execute_workflow");
    for content in &mut before.contents {
        for part in &mut content.parts {
            if let Part::Text { text, .. } = part {
                for path in ["main_agent/AGENT.md", "main_agent/skills/capability-orchestration.md"] {
                    *text = text.replace(
                        &resources::read(path).unwrap(),
                        &std::fs::read_to_string(baseline.join(path)).unwrap(),
                    );
                }
                *text = text
                    .replace("Explicit existing-workflow rerun:", "Reuse existing workflow:")
                    .replace("Execution grant: true", "Execution grant: false");
            }
        }
    }
    let mut report = serde_json::Map::new();
    for (label, request) in [
        ("intent_before", intent_before),
        ("intent_after", intent_after),
        ("main_before", before),
        ("main_after", after),
    ] {
        let payload = json!({"contents":request.contents,"tools":request.tools,"config":request.config});
        let text = payload.to_string();
        eprintln!("{label}: request_bytes={} tools={}", text.len(), request.tools.len());
        report.insert(label.into(), payload);
    }
    if let Some(path) = std::env::var_os("WORKRUN_ASSISTANT_BUDGET_OUTPUT") {
        std::fs::write(path, serde_json::to_vec(&report).unwrap()).unwrap();
    }
}

#[tokio::test]
async fn make_reusable_save_only_request_can_finish_with_existing_workflow_without_new_plan() {
    let workspace = Workspace::new();
    let sid = uuid::Uuid::new_v4().to_string();
    let mut entry = workspace.entry();
    entry["document"]["settings"]["name"] = json!("文档整理与摘要");
    entry["document"]["settings"]["description"] = json!("整理文档并生成摘要，可重复使用");
    std::fs::write(workspace.root.path().join("workflow.json"), entry.to_string()).unwrap();
    let scripted = Arc::new(tests::ScriptedModel::new(vec![
        Content::new("model").with_text(r#"{"intent":"authoring","actionQuote":"整理成流程","authoringQuote":"整理成流程","summary":"整理文档任务为可复用流程","reuseExisting":false}"#),
        tests::call("transfer_to_agent",json!({"agent_name":"workflow_planner"})),
        tests::call("list_capabilities",json!({"query":"document organization workflow"})),
        tests::call("list_capabilities",json!({"capability_id":workspace.id})),
        Content::new("model").with_text(json!({"status":"reuse_available","capability_id":workspace.id,"summary":"已有工作流符合需求，无需新建"}).to_string()),
        Content::new("model").with_text(format!("已有可复用的[工作流](/workflows/{})，没有新建或运行。",workspace.id)),
    ]));
    let model = evaluation::ProbeModel::new(scripted.clone(), Duration::ZERO);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&sid),
                contents: vec![
                    Content::new("user").with_text("先把文档整理好"),
                    Content::new("model").with_text("已整理文档"),
                    Content::new("user").with_text("以后要重复做，整理成流程，先不要运行。"),
                ],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    let cost = model.costs_since(0);
    assert_eq!(cost["phases"]["intent"]["callCount"], 1);
    assert_eq!(cost["phases"]["planning"]["callCount"], 3);
    assert_eq!(cost["phases"]["conversation"]["callCount"], 2);
    assert!(cost["phases"]["authoring"].is_null());
    assert!(reply.call.is_none());
    assert!(reply.pause.is_none());
    assert!(reply.text.contains(&workspace.id));
    assert!(Store::new(workspace.root.path()).current(&sid).unwrap().is_none());
    assert!(workspace.writes.lock().unwrap().is_empty());
    let requests = scripted.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    let context = requests
        .iter()
        .flat_map(|r| r.contents.iter())
        .map(|c| serde_json::to_string(c).unwrap())
        .collect::<String>();
    assert!(context.contains("searchFallback"));
    assert!(context.contains("reuse_available"));
    assert!(
        requests
            .last()
            .unwrap()
            .contents
            .iter()
            .any(|c| content_text(c).contains(&workspace.id))
    );
    assert!(!context.contains("No plan proposal was saved"));
}

#[tokio::test]
async fn planner_cannot_claim_reuse_without_inspecting_the_exact_contract() {
    let workspace = Workspace::new();
    let sid = uuid::Uuid::new_v4().to_string();
    let model = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(r#"{"intent":"authoring","actionQuote":"整理成流程","authoringQuote":"整理成流程","summary":"整理可复用流程","reuseExisting":false}"#),
        tests::call("transfer_to_agent",json!({"agent_name":"workflow_planner"})),
        tests::call("list_capabilities",json!({})),
        Content::new("model").with_text(json!({"status":"reuse_available","capability_id":workspace.id,"summary":"Already fits"}).to_string()),
        Content::new("model").with_text("还需要核对候选工作流的契约。"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&sid),
                contents: vec![Content::new("user").with_text("整理成流程，先不要运行")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(workspace.writes.lock().unwrap().is_empty());
    let requests = model.requests.lock().unwrap();
    assert!(
        requests
            .last()
            .unwrap()
            .contents
            .iter()
            .any(|c| content_text(c).contains("\"status\":\"failed\""))
    );
}

#[tokio::test]
#[ignore = "uses explicitly configured DeepSeek; temporary fixtures only, no execution or creation"]
async fn live_make_reusable_save_only_selects_existing_workflow() {
    let directory = std::path::PathBuf::from(
        std::env::var_os("WORKRUN_ASSISTANT_LIVE_CONFIG_DIR").expect("Explicit live config required"),
    );
    let config: Value =
        serde_yaml_ng::from_str(&std::fs::read_to_string(directory.join("workrun.yaml")).unwrap()).unwrap();
    let credential = config["provider_credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["provider"] == json!(ModelProvider::DeepSeek))
        .expect("DeepSeek must be configured");
    let key = std::fs::read(directory.join(".encryption_key")).unwrap();
    let decrypted = crate::config::decrypt_data_with_key(credential["apiKey"].as_str().unwrap(), &key).unwrap();
    let api_key: Option<String> = serde_json::from_str(&decrypted).unwrap();
    let mut model_config = adk_rust::model::deepseek::DeepSeekConfig::new(api_key.unwrap(), "deepseek-v4-flash");
    if let Some(url) = credential["baseUrl"].as_str().filter(|url| !url.is_empty()) {
        model_config = model_config.with_base_url(url);
    }
    let model = evaluation::ProbeModel::new(
        Arc::new(adk_rust::model::deepseek::DeepSeekClient::new(model_config).unwrap()),
        Duration::from_secs(2),
    );
    let workspace = Workspace::new();
    let mut entry = workspace.entry();
    entry["document"]["settings"]["name"] = json!("费用审核与阈值判断");
    entry["document"]["settings"]["description"] =
        json!("可重复检查输入金额，金额达到1000时进入需审核分支，否则进入无需审核分支。不操作付款或外部系统。");
    std::fs::write(workspace.root.path().join("workflow.json"), entry.to_string()).unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::DeepSeek,
            AssistantRequest {
                context: context(&sid),
                contents: vec![
                    Content::new("user").with_text("检查金额1500的费用是否需要审核，达到1000需审核。"),
                    Content::new("model").with_text("金额1500达到1000，属于需审核分支。"),
                    Content::new("user").with_text("以后要重复做，整理成流程，先不要运行。"),
                ],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    eprintln!(
        "reuse_authoring_trace tools={:?} usage={}",
        model.called_tools(),
        json!(model.usage())
    );
    if let Some(plan) = Store::new(workspace.root.path()).current(&sid).unwrap() {
        eprintln!("unexpected_plan={}", serde_json::to_string(&plan.document).unwrap());
    }
    assert!(reply.call.is_none(), "Must respect save-only request");
    assert!(
        reply.pause.is_none(),
        "An existing compatible workflow must not produce a new proposal"
    );
    assert!(Store::new(workspace.root.path()).current(&sid).unwrap().is_none());
    assert!(workspace.writes.lock().unwrap().is_empty());
    assert!(
        reply.text.contains(&workspace.id),
        "Must identify the reusable workflow"
    );
}

#[tokio::test]
#[ignore = "paid Gemini comparison; saves only temporary create/edit fixtures, never executes"]
async fn live_native_save_cost_comparison() {
    let model = evaluation::ProbeModel::new(Arc::new(tests::live_gemini_model_from_env()), Duration::from_secs(6));
    let mut results = vec![];
    let selected = std::env::var("WORKRUN_ASSISTANT_SAVE_CASE").ok();
    let mut expected = 0;
    for edit in [false, true] {
        let case_id = if edit { "confirmed-edit" } else { "confirmed-create" };
        if selected.as_deref().is_some_and(|id| id != case_id) {
            continue;
        }
        expected += 1;
        let create = authoring_tests::DraftStore::new();
        let existing = Workspace::new();
        let session = if edit {
            uuid::Uuid::new_v4().to_string()
        } else {
            create.session_id.clone()
        };
        let (root, discovery): (_, &dyn tools::WorkflowDiscovery) = if edit {
            (existing.root.path(), &existing)
        } else {
            (create.root.path(), &create)
        };
        let mut document = planning_tests::document();
        if edit {
            document["target_id"] = json!(existing.id);
            document["steps"][0]["configuration_notes"] =
                json!("把现有判断阈值改为2000，至少2000走true，否则false；保留其他设置。");
            document["acceptance_criteria"] = json!(["金额1500选择false分支，金额2000选择true分支"]);
        }
        let text = if edit {
            "确认修改方案：把现有工作流的金额判断阈值改成2000，保留其他设置，保存但不要运行。"
        } else {
            "确认方案：创建金额分流工作流，输入amount，至少1000走true，否则false；保存但不要运行。"
        };
        let history = vec![Content::new("user").with_text(text)];
        let store = Store::new(root);
        let plan = store
            .save(&session, "proposal", 0, Document::parse(&document).unwrap(), vec![])
            .unwrap();
        task_runtime::TaskRuntime::open(root)
            .await
            .unwrap()
            .suspend(&plan)
            .await
            .unwrap();
        let turn = tool_execution::digest(&protocol::normalize_assistant_contents(history.clone()).unwrap()).unwrap();
        planning_tests::operate(
            root,
            &session,
            "approve",
            &json!({"plan_id":plan.id,"version":1,"turn_key":turn}),
            &[],
        )
        .await
        .unwrap();
        let first = model.costs_since(0)["callCount"].as_u64().unwrap() as usize;
        let reply = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: context(&session),
                    contents: history,
                    capabilities: vec![],
                },
                &|_| Ok(()),
                discovery,
            )
            .await;
        let saved = store.current(&session).unwrap().unwrap();
        let (answer, error, dispatched) = match reply {
            Ok(reply) => (Some(reply.text), None, reply.call.is_some()),
            Err(error) => (None, Some(evaluation::error_label(&error)), false),
        };
        let graph = if edit {
            existing.entry()["document"].clone()
        } else {
            create
                .saved
                .lock()
                .unwrap()
                .as_ref()
                .and_then(|v| v["draft_id"].as_str())
                .and_then(|id| authoring::load(root, id, false).ok())
                .map(|v| v["document"].clone())
                .unwrap_or(Value::Null)
        };
        let settings_preserved = !edit
            || graph["settings"]
                == serde_json::from_str::<Value>(include_str!("fixtures/expense-review.workflow.json")).unwrap()["document"]
                    ["settings"];
        let threshold = if edit { "2000" } else { "1000" };
        let passed = error.is_none()
            && !dispatched
            && saved.status == "saved"
            && (!edit || saved.workflow_id.as_deref() == Some(existing.id.as_str()))
            && settings_preserved
            && graph["nodes"].to_string().contains(threshold);
        let result = json!({"id":if edit {"confirmed-edit"} else {"confirmed-create"},
            "passed":passed,"saved":saved.status == "saved","dispatched":dispatched,
            "identityPreserved":!edit || saved.workflow_id.as_deref() == Some(existing.id.as_str()),
            "settingsPreserved":settings_preserved,"savedSettings":graph["settings"],"thresholdPresent":graph["nodes"].to_string().contains(threshold),
            "answer":answer,"error":error,"cost":model.costs_since(first)});
        println!("{}: {}", result["id"], if passed { "passed" } else { "failed" });
        let transport_error = result["error"]
            .as_str()
            .is_some_and(|e| !e.starts_with("runtime_rejection"));
        results.push(result);
        if transport_error {
            break;
        }
    }
    let path = std::path::PathBuf::from(
        std::env::var_os("WORKRUN_ASSISTANT_SAVE_REPORT").expect("Explicit report path required"),
    );
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&json!({"model":model.name(),"cases":results,"executionIncluded":false})).unwrap(),
    )
    .unwrap();
    assert!(
        expected > 0 && results.len() == expected && results.iter().all(|r| r["passed"] == true),
        "inspect save comparison report"
    );
}
