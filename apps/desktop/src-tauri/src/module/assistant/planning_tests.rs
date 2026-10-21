//! Plan persistence and SDK lifecycle acceptance use only temporary resources.
use super::planning_agent::plans::{Document, Store};
use super::*;
use serde_json::Value;
use std::path::Path;
pub(super) fn document() -> Value {
    json!({"goal":"按输入金额选择分支","summary":"检查输入并按规则选择分支","inputs":[{"name":"amount","description":"需要判断的金额"}],"outputs":["对应分支"],"steps":[{"title":"选择分支","description":"输入金额与已确定的阈值比较","node_types":["if_else"],"dependencies":[],"configuration_notes":"至少1000走true，否则false"}],"constraints":["不执行外部操作"],"assumptions":[],"questions":[],"acceptance_criteria":["金额1500选择true分支"]})
}
pub(super) fn seed_approved(root: &Path, session: &str, history: &[Content]) {
    let store = Store::new(root);
    let plan = store
        .save(session, "proposal", 0, Document::parse(&document()).unwrap(), vec![])
        .unwrap();
    let history = protocol::normalize_assistant_contents(history.to_vec()).unwrap();
    store
        .decide(
            session,
            &plan.id,
            plan.version,
            true,
            &tool_execution::digest(&history).unwrap(),
        )
        .unwrap();
}
pub(super) async fn operate(
    root: &Path,
    session: &str,
    name: &str,
    args: &Value,
    artifacts: &[crate::module::artifact::ArtifactRef],
) -> Result<Value> {
    let store = Store::new(root);
    let tasks = task_runtime::TaskRuntime::open(root).await?;
    if name == "get_workflow_plan" {
        return Ok(if let Some(v) = args["version"].as_u64() {
            serde_json::to_value(store.revision(session, v as u32)?)?
        } else {
            serde_json::to_value(store.current(session)?)?
        });
    }
    let turn = args["turn_key"].as_str().context("Missing turn")?;
    if name == "save_workflow_plan" {
        let document = Document::parse(&serde_json::from_str(
            args["document_json"].as_str().context("Missing document")?,
        )?)?;
        anyhow::ensure!(
            document.inputs.iter().all(|i| i
                .artifact_id
                .as_ref()
                .is_none_or(|id| artifacts.iter().any(|a| &a.id == id))),
            "Unauthorized attachment"
        );
        let old = store.current(session)?;
        let plan = store.save(
            session,
            turn,
            args["base_version"].as_u64().context("Missing base version")? as u32,
            document,
            vec![],
        )?;
        tasks.suspend(&plan).await?;
        if let Some(old) = old {
            tasks.decide(&old, false).await?;
        }
        return tasks.decorate(&plan).await;
    }
    let id = args["plan_id"].as_str().context("Missing plan ID")?;
    let version = args["version"].as_u64().context("Missing version")? as u32;
    let current = store.current(session)?.context("Missing plan")?;
    let plan = if matches!(name, "approve" | "cancel") {
        store.preview_decision(session, id, version, name == "approve", turn)?;
        tasks.decide(&current, name == "approve").await?;
        store.decide(session, id, version, name == "approve", turn)?
    } else {
        tasks.require_creation(&current).await?;
        let plan = store.transition(session, id, version, name, args.get("outcome").cloned())?;
        if matches!(name, "saved" | "failed") {
            tasks.finish(&plan).await?;
        }
        plan
    };
    tasks.decorate(&plan).await
}

fn assessment(intent: &str, quote: &str) -> Content {
    Content::new("model").with_text(json!({"intent":intent,"actionQuote":quote,"authoringQuote":if intent=="authoring"{quote}else{""},"summary":"规划可复用的规则处理流程"}).to_string())
}
fn context(session: &str) -> protocol::AssistantContext {
    protocol::AssistantContext {
        session_id: Some(session.into()),
        ..Default::default()
    }
}
fn finish(status: &str) -> Content {
    Content::new("model").with_text(json!({"status":status,"summary":"方案已更新","assumptions":[]}).to_string())
}

#[tokio::test]
async fn planning_clarification_revision_native_approval_and_creation_are_separate_turns() {
    let workspace = authoring_tests::DraftStore::new();
    let sid = &workspace.session_id;
    let mut draft = document();
    draft["questions"] = json!(["分支阈值是多少？"]);
    let user = Content::new("user").with_text("以后重复做，整理成流程，先不要运行");
    let planner = tests::ScriptedModel::new(vec![
        assessment("authoring", "整理成流程"),
        // An invalid direct author handoff is repairable without a write.
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        tests::call("read_skill", json!({"name":"workflow-planning"})),
        tests::call(
            "save_workflow_plan",
            json!({"base_version":0,"document_json":draft.to_string()}),
        ),
        finish("needs_clarification"),
        Content::new("model").with_text("分支阈值是多少？"),
    ]);
    let events = std::sync::Mutex::new(vec![]);
    let first = tests::runtime()
        .run_with_discovery(
            &planner,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|event| {
                events.lock().unwrap().push(event);
                Ok(())
            },
            &workspace,
        )
        .await
        .unwrap();
    assert!(first.call.is_none());
    let store = Store::new(workspace.root.path());
    let plan = store.current(sid).unwrap().unwrap();
    assert_eq!(plan.status, "needs_clarification");
    assert!(plan.workflow_id.is_none());
    assert!(store.decide(sid, &plan.id, 1, true, "new-turn").is_err());
    assert!(events.lock().unwrap().iter().any(
        |event| matches!(event,AssistantStreamEvent::WorkflowPlan{plan} if plan["status"]=="needs_clarification")
    ));
    {
        let requests = planner.requests.lock().unwrap();
        let child = requests
            .iter()
            .find(|r| r.tools.contains_key("save_workflow_plan"))
            .unwrap();
        assert!(!child.tools.contains_key("save_workflow_draft"));
        assert!(!child.tools.contains_key("call_workspace_tool"));
        assert!(
            serde_json::to_string(&requests[2].contents)
                .unwrap()
                .contains("No transfer or write occurred")
        );
    }
    let mut history = vec![
        user,
        first.content,
        Content::new("user").with_text("阈值1000，并明确输出选择的分支"),
    ];
    let revised = document();
    let planner = tests::ScriptedModel::new(vec![
        assessment("planning", ""),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        tests::call("get_workflow_plan", json!({})),
        tests::call(
            "save_workflow_plan",
            json!({"base_version":1,"document_json":revised.to_string()}),
        ),
        finish("ready"),
        Content::new("model").with_text("第2版方案已就绪，请确认或调整。"),
    ]);
    let second = tests::runtime()
        .run_with_discovery(
            &planner,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: history.clone(),
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(second.call.is_none());
    let plan = store.current(sid).unwrap().unwrap();
    assert_eq!(plan.version, 2);
    assert_eq!(plan.status, "ready");
    assert!(!store.revision(sid, 1).unwrap().document.questions.is_empty());
    assert!(store.decide(sid, &plan.id, 1, true, "later").is_err());
    history.push(second.content);
    history.push(Content::new("user").with_text("确认第2版并创建，不运行"));
    let turn = tool_execution::digest(&protocol::normalize_assistant_contents(history.clone()).unwrap()).unwrap();
    operate(
        workspace.root.path(),
        sid,
        "approve",
        &json!({"plan_id":plan.id,"version":2,"turn_key":turn}),
        &[],
    )
    .await
    .unwrap();
    let graph: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json")).unwrap();
    // Native button approval starts configuration directly; no intent model can
    // reinterpret it as execution or revoke it with an unrelated nullable field.
    let author = tests::ScriptedModel::new(vec![
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        tests::call(
            "save_workflow_draft",
            json!({"document_json":graph["document"].to_string()}),
        ),
        finish("completed"),
        Content::new("model").with_text("已保存流程，未运行。"),
    ]);
    let created = tests::runtime()
        .run_with_discovery(
            &author,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: history,
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(created.call.is_none());
    let saved = store.current(sid).unwrap().unwrap();
    assert_eq!(saved.status, "saved");
    assert!(saved.workflow_id.is_some());
    let calls = author.requests.lock().unwrap();
    assert!(!calls[0].tools.contains_key("execute_capability"));
    assert!(!calls[1].tools.contains_key("save_workflow_plan"));
    let turns = workspace.turns.lock().unwrap();
    assert_eq!(turns.len(), 3);
    assert_eq!(turns[0]["result"]["planningAllowed"], true);
    assert_eq!(turns[0]["result"]["authoringAllowed"], false);
    assert_eq!(turns[2]["result"]["authoringAllowed"], true);
    assert_eq!(turns[2]["result"]["workflowExecutionAllowed"], false);
}

#[test]
fn revisions_and_approvals_are_scoped_and_cannot_skip_unresolved_work() {
    let root = tempfile::tempdir().unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    let store = Store::new(root.path());
    let proposal = store
        .save(&sid, "first", 0, Document::parse(&document()).unwrap(), vec![])
        .unwrap();
    assert!(store.decide(&sid, &proposal.id, 1, true, "first").is_err());
    assert!(store.decide(&sid, "wrong", 1, true, "second").is_err());
    assert!(store.current(&uuid::Uuid::new_v4().to_string()).unwrap().is_none());
    assert!(
        store
            .save(&sid, "another", 0, Document::parse(&document()).unwrap(), vec![])
            .is_err()
    );
    let newer = store
        .save(
            &sid,
            "edit",
            1,
            Document::parse(&document()).unwrap(),
            vec!["Missing dependency".into()],
        )
        .unwrap();
    assert_eq!(newer.status, "needs_clarification");
    assert!(newer.approved_turn_key.is_none());
    assert!(store.decide(&sid, &newer.id, 2, true, "third").is_err());
    assert!(store.decide(&sid, &proposal.id, 1, true, "third").is_err());
    assert_eq!(
        store.decide(&sid, &newer.id, 2, false, "third").unwrap().status,
        "cancelled"
    );
    assert!(
        Store::new(root.path())
            .current(&sid)
            .unwrap()
            .unwrap()
            .approved_turn_key
            .is_none()
    );
    assert!(store.current("../escape").is_err());
}

#[test]
fn approved_plan_preserves_resources_without_freezing_node_suggestions() {
    let mut plan = json!({"document":document()});
    let workflow = json!({"nodes":[{"type":"if_else","data":{}}]});
    planning_agent::plans::validate_graph(&plan, &workflow).unwrap();
    // Node suggestions do not define the graph. The native compiler validates it.
    planning_agent::plans::validate_graph(&plan, &json!({"nodes":[{"type":"switch","data":{}}]})).unwrap();
    let mut unspecified = document();
    unspecified["steps"][0].as_object_mut().unwrap().remove("node_types");
    assert!(Document::parse(&unspecified).unwrap().steps[0].node_types.is_empty());
    plan["document"]["steps"][0]["dependencies"] =
        json!([{"kind":"model","id":"selected-model","purpose":"Chosen resource"}]);
    assert!(planning_agent::plans::validate_graph(&plan, &workflow).is_err());
    let resource_graph = json!({"nodes":[{"type":"agent","data":{"modelProfileId":"selected-model"}}]});
    planning_agent::plans::validate_graph(&plan, &resource_graph).unwrap();
    assert!(Document::parse(&json!({"goal":"incomplete"})).is_err());
    let mut bad = document();
    bad["steps"][0]["node_types"] = json!(["invented-node"]);
    assert!(Document::parse(&bad).is_err());
}

#[tokio::test]
async fn natural_acceptance_binds_the_current_plan_version_and_creates_without_execution() {
    let workspace = authoring_tests::DraftStore::new();
    let sid = &workspace.session_id;
    let store = Store::new(workspace.root.path());
    let mut proposal = document();
    proposal["steps"][0]["node_types"] = json!(["agent"]);
    let plan = store
        .save(sid, "prior", 0, Document::parse(&proposal).unwrap(), vec![])
        .unwrap();
    let graph: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json")).unwrap();
    let model=tests::ScriptedModel::new(vec![Content::new("model").with_text(json!({"intent":"authoring","actionQuote":"按这个方案创建","authoringQuote":"按这个方案创建","summary":"创建确定的流程","planFeedback":{"id":plan.id,"version":plan.version,"decision":"approve","quote":"按这个方案创建"}}).to_string()),tests::call("transfer_to_agent",json!({"agent_name":"workflow_author"})),tests::call("save_workflow_draft",json!({"document_json":graph["document"].to_string()})),finish("completed"),Content::new("model").with_text("已保存，未运行。")]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![Content::new("user").with_text("按这个方案创建")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(store.current(sid).unwrap().unwrap().status, "saved");
    let replay = tests::ScriptedModel::new(vec![
        Content::new("model").with_text("已从保存记录恢复结果，没有再次创建。"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &replay,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![Content::new("user").with_text("按这个方案创建")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(store.current(sid).unwrap().unwrap().version, 1);
    assert!(
        !replay.requests.lock().unwrap()[0]
            .tools
            .contains_key("transfer_to_agent")
    );
}

#[test]
fn native_plan_decision_packet_matches_the_client_contract() {
    let action: session::TurnAction = serde_json::from_value(
        json!({"kind":"planDecision","plan_id":"plan","version":2,"decision":"approve","text":"确认并创建"}),
    )
    .unwrap();
    assert!(
        matches!(action,session::TurnAction::PlanDecision{plan_id,version:2,decision,..} if plan_id=="plan" && decision=="approve")
    );
    assert!(
        serde_json::from_value::<session::TurnAction>(
            json!({"kind":"planDecision","plan_id":"plan","version":-1,"decision":"approve","text":"Create"})
        )
        .is_err()
    );
}

#[test]
fn interrupted_configuration_preserves_the_plan_and_never_carries_approval_to_a_revision() {
    let root = tempfile::tempdir().unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    let store = Store::new(root.path());
    let plan = store
        .save(&sid, "proposal", 0, Document::parse(&document()).unwrap(), vec![])
        .unwrap();
    store.decide(&sid, &plan.id, 1, true, "accepted").unwrap();
    store.transition(&sid, &plan.id, 1, "building", None).unwrap();
    let restored = Store::new(root.path());
    assert_eq!(restored.current(&sid).unwrap().unwrap().status, "building");
    restored
        .transition(
            &sid,
            &plan.id,
            1,
            "failed",
            Some(json!({"status":"failed","summary":"Interrupted"})),
        )
        .unwrap();
    let revision = restored
        .save(&sid, "edit", 1, Document::parse(&document()).unwrap(), vec![])
        .unwrap();
    assert_eq!(revision.version, 2);
    assert!(revision.approved_turn_key.is_none());
    assert!(
        restored
            .transition(&sid, &plan.id, 1, "saved", Some(json!({"workflow_id":"old"})))
            .is_err()
    );
}

#[tokio::test]
async fn explicit_plan_acceptance_and_separate_run_request_can_propose_only_the_created_workflow() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Combined<'a> {
        workspace: &'a authoring_tests::DraftStore,
        script: tests::ScriptedModel,
        step: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl Llm for Combined<'_> {
        fn name(&self) -> &str {
            "combined-test"
        }
        async fn generate_content(
            &self,
            request: LlmRequest,
            stream: bool,
        ) -> adk_rust::Result<adk_rust::LlmResponseStream> {
            if self.step.fetch_add(1, Ordering::SeqCst) == 4 {
                let saved = self.workspace.saved.lock().unwrap().clone().unwrap();
                let content = tests::call(
                    "execute_capability",
                    json!({"capability_id":saved["capability_id"],"bindings":[{"input":"amount","source":"message","message":0,"quote":"1500","value_json":"1500"}]}),
                );
                return Ok(Box::pin(futures::stream::once(async move {
                    Ok(adk_rust::LlmResponse::new(content))
                })));
            }
            self.script.generate_content(request, stream).await
        }
    }
    let workspace = authoring_tests::DraftStore::new();
    let sid = &workspace.session_id;
    let store = Store::new(workspace.root.path());
    let plan = store
        .save(sid, "prior", 0, Document::parse(&document()).unwrap(), vec![])
        .unwrap();
    let graph: Value = serde_json::from_str(include_str!("fixtures/expense-review.workflow.json")).unwrap();
    let model=Combined{workspace:&workspace,step:AtomicUsize::new(0),script:tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"execution","actionQuote":"运行","authoringQuote":"确认方案并创建","summary":"创建确认的流程并运行","planFeedback":{"id":plan.id,"version":1,"decision":"approve","quote":"确认方案并创建"}}).to_string()),
        tests::call("transfer_to_agent",json!({"agent_name":"workflow_author"})),tests::call("save_workflow_draft",json!({"document_json":graph["document"].to_string()})),finish("completed")])};
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![Content::new("user").with_text("确认方案并创建，然后运行，金额1500")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    let call = reply.call.unwrap();
    assert_eq!(
        call.workflow_id,
        store.current(sid).unwrap().unwrap().workflow_id.unwrap()
    );
    assert_eq!(call.input["amount"], 1500);
}

#[tokio::test]
async fn natural_cancellation_closes_checkpoint_without_authoring_or_execution() {
    let workspace = authoring_tests::DraftStore::new();
    let store = Store::new(workspace.root.path());
    let plan = store
        .save(
            &workspace.session_id,
            "proposal",
            0,
            Document::parse(&document()).unwrap(),
            vec![],
        )
        .unwrap();
    let user = Content::new("user").with_text("取消这个方案");
    let model = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"conversation","actionQuote":"","summary":"取消规划","planFeedback":{"id":plan.id,"version":1,"decision":"cancel","quote":"取消这个方案"}}).to_string()),
        Content::new("model").with_text("已取消方案，未创建工作流。"),
    ]);
    let reply = AssistantRuntime::load(workspace.root.path())
        .unwrap()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![user],
                context: context(&workspace.session_id),
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(workspace.saved.lock().unwrap().is_none());
    let current = store.current(&workspace.session_id).unwrap().unwrap();
    assert_eq!(current.status, "cancelled");
    let tasks = task_runtime::TaskRuntime::open(workspace.root.path()).await.unwrap();
    assert_eq!(tasks.interaction(&current).await.unwrap().unwrap().status, "cancelled");
    assert!(tasks.require_creation(&current).await.is_err());
}

#[tokio::test]
async fn hard_pause_repairs_invalid_plan_then_accepts_unspecified_nodes_and_preserves_review_gate() {
    let workspace = authoring_tests::DraftStore::new();
    let sid = &workspace.session_id;
    let user = Content::new("user").with_text("以后重复做，整理成流程，先不要运行");
    let mut incomplete = document();
    incomplete["goal"] = json!("");
    let mut valid = document();
    valid["steps"][0].as_object_mut().unwrap().remove("node_types");
    // No specialist completion or coordinator narrative is provided. Any model
    // call after the successful save panics, reproducing the actual missing gate.
    let model = tests::ScriptedModel::new(vec![
        assessment("authoring", "整理成流程"),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        tests::call(
            "save_workflow_plan",
            json!({"base_version":0,"document_json":incomplete.to_string()}),
        ),
        tests::call(
            "save_workflow_plan",
            json!({"base_version":0,"document_json":valid.to_string()}),
        ),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert_eq!(reply.pause.as_ref().unwrap()["reason"], "review_required");
    assert!(reply.text.is_empty());
    assert!(workspace.saved.lock().unwrap().is_none());
    assert_eq!(model.requests.lock().unwrap().len(), 4);
    let store = Store::new(workspace.root.path());
    let plan = store.current(sid).unwrap().unwrap();
    assert_eq!(plan.version, 1);
    assert_eq!(plan.status, "ready");
    let tasks = task_runtime::TaskRuntime::open(workspace.root.path()).await.unwrap();
    let checkpoint = tasks.interaction(&plan).await.unwrap().unwrap().checkpoint_id;
    assert!(tasks.require_creation(&plan).await.is_err());
    // Retrying delivery must not perform even an intent or final-answer call.
    let retry = tests::ScriptedModel::new(vec![]);
    let retried = tests::runtime()
        .run_with_discovery(
            &retry,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![user.clone()],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(retried.pause.is_some());
    assert!(retry.requests.lock().unwrap().is_empty());
    // Match the real session's recorded intent=execution + authoring quote:
    // a run request cannot manufacture another planning revision.
    let run = Content::new("user").with_text("执行一下呢");
    let model =
        tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":"execution","actionQuote":"执行","authoringQuote":"执行","summary":"执行当前流程"})
                    .to_string(),
            ),
        ]);
    let blocked = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(sid),
                contents: vec![user, run],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert_eq!(blocked.pause.as_ref().unwrap()["reason"], "confirmation_required");
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    let current = store.current(sid).unwrap().unwrap();
    assert_eq!(current.version, 1);
    assert_eq!(current.document.summary, plan.document.summary);
    assert_eq!(
        tasks.interaction(&current).await.unwrap().unwrap().checkpoint_id,
        checkpoint
    );
    assert!(workspace.saved.lock().unwrap().is_none());
}

/// Scripted models test feedback transport/versioning, not question-selection quality.
#[tokio::test]
async fn partial_answers_and_delegated_choices_revise_without_approval() {
    let workspace = authoring_tests::DraftStore::new();
    let sid = &workspace.session_id;
    let store = Store::new(workspace.root.path());
    let mut draft = json!({
        "goal":"把资料整理为可复用摘要流程","summary":"先确认用途与篇幅",
        "inputs":[{"name":"source","description":"输入资料"}],"outputs":["摘要"],
        "steps":[{"title":"整理资料","description":"按明确的用途与篇幅生成摘要","dependencies":[],"configuration_notes":"使用原生可用能力"}],
        "constraints":["不执行外部操作"],"assumptions":[],
        "questions":["摘要面向谁？这决定表述方式。","篇幅需要多长？这决定输出范围。"],
        "acceptance_criteria":["摘要适合确定的受众，且保留原文事实"]
    });
    let mut history = vec![];
    for (index, message) in [
        "把资料整理成可复用流程，先不要运行",
        "面向新同事，篇幅还没决定",
        "篇幅你决定，先给我看更新的方案",
    ]
    .into_iter()
    .enumerate()
    {
        if index == 1 {
            draft["constraints"] = json!(["不执行外部操作", "面向新同事，避免未解释的术语"]);
            draft["questions"] = json!(["篇幅需要多长？这决定输出范围。"]);
            draft["summary"] = json!("受众已明确为新同事，篇幅待定");
        } else if index == 2 {
            draft["assumptions"] = json!(["用户委托选择篇幅，默认简短摘要；不改变原文事实"]);
            draft["questions"] = json!([]);
            draft["summary"] = json!("保留新同事受众，采用简短摘要，等待确认");
        }
        history.push(Content::new("user").with_text(message));
        let model = tests::ScriptedModel::new(vec![
            assessment(if index == 0 { "authoring" } else { "planning" }, message),
            tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
            tests::call("get_workflow_plan", json!({})),
            tests::call(
                "save_workflow_plan",
                json!({"base_version":index,"document_json":draft.to_string()}),
            ),
        ]);
        let reply = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: context(sid),
                    contents: history.clone(),
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &workspace,
            )
            .await
            .unwrap();
        assert!(reply.call.is_none());
        assert!(workspace.saved.lock().unwrap().is_none());
        let plan = store.current(sid).unwrap().unwrap();
        assert_eq!(plan.version, (index + 1) as u32);
        assert_eq!(plan.status, if index == 2 { "ready" } else { "needs_clarification" });
        assert!(plan.approved_turn_key.is_none());
        if index > 0 {
            assert!(plan.document.constraints.iter().any(|value| value.contains("新同事")));
            let requests = model.requests.lock().unwrap();
            let child = requests
                .iter()
                .find(|request| request.tools.contains_key("save_workflow_plan"))
                .unwrap();
            let context = serde_json::to_string(&child.contents).unwrap();
            assert!(context.contains("面向新同事"));
        }
        history.push(reply.content);
    }
    let plan = store.current(sid).unwrap().unwrap();
    assert!(store.decide(sid, &plan.id, 2, true, "stale-approval").is_err());
    assert!(!store.revision(sid, 1).unwrap().document.questions.is_empty());
    assert!(!store.revision(sid, 2).unwrap().document.questions.is_empty());
    assert!(plan.document.questions.is_empty());
    assert_eq!(plan.document.assumptions.len(), 1);
}

#[tokio::test]
async fn planner_receives_source_labeled_conversation_without_historical_replay() {
    let workspace = authoring_tests::DraftStore::new();
    let mut proposal = document();
    proposal["questions"] = json!(["输入值的处理口径是什么？不同口径会改变输出。"]);
    let model = tests::ScriptedModel::new(vec![
        assessment("authoring", "整理成流程"),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        tests::call(
            "save_workflow_plan",
            json!({"base_version":0,"document_json":proposal.to_string()}),
        ),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: context(&workspace.session_id),
                capabilities: vec![],
                contents: vec![
                    Content::new("user").with_text("先看输入资料"),
                    Content::new("model").with_text("我猜所有记录都已获批准"),
                    Content::new("user").with_text("以后重复做，整理成流程，先不要运行"),
                ],
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(workspace.saved.lock().unwrap().is_none());
    let requests = model.requests.lock().unwrap();
    let request = requests
        .iter()
        .find(|request| request.tools.contains_key("save_workflow_plan"))
        .unwrap();
    let injected: Value = request
        .contents
        .iter()
        .find_map(|content| {
            serde_json::from_str::<Value>(&model::content_text(content))
                .ok()
                .filter(|value| value.get("conversation").is_some())
        })
        .unwrap();
    assert_eq!(injected["conversation"][1]["source"], "assistant_generated_unverified");
    assert_eq!(injected["conversation"][2]["source"], "user_expression");
    assert!(injected.get("prior_execution_evidence").is_none());
    assert!(!request.tools.contains_key("run_code"));
    assert!(!request.tools.contains_key("save_workflow_draft"));
    let plan = Store::new(workspace.root.path())
        .current(&workspace.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(plan.status, "needs_clarification");
    assert!(plan.approved_turn_key.is_none());
}
