//! Task-level regressions: ordinary work never enters workflow authoring.
use super::main_agent::direct;
use super::tools::WorkflowDiscovery;
use super::*;
use crate::module::artifact::{ArtifactRef, ArtifactStore};
use serde_json::Value;
use std::sync::{
    Mutex,
    atomic::{AtomicUsize, Ordering},
};

struct Workspace {
    root: tempfile::TempDir,
    store: ArtifactStore,
    saves: AtomicUsize,
    records: Mutex<Vec<Value>>,
    tool_backend: tool_execution::tests::FakeBackend,
}
impl Workspace {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(root.path().join("artifacts"));
        Self {
            root,
            store,
            saves: AtomicUsize::new(0),
            records: Mutex::new(vec![]),
            tool_backend: tool_execution::tests::FakeBackend::new(crate::config::ToolExecutionPolicy::AskEveryTime),
        }
    }
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for Workspace {
    async fn list(&self, _: &Value) -> Result<Value> {
        Ok(json!({"items":[]}))
    }
    async fn describe(&self, _: &str) -> Result<tools::Capability> {
        bail!("No workflow exists")
    }
    async fn workspace_resource(&self, name: &str, args: &Value) -> Result<Value> {
        Ok(json!({"resourceTool":name,"arguments":args,"executed":false}))
    }
    async fn pending_tool_call(&self, session: &str) -> Result<Option<Value>> {
        tool_execution::pending(self.root.path(), session).await
    }
    async fn deny_tool_call(&self, session: &str, id: &str) -> Result<Value> {
        tool_execution::deny(self.root.path(), session, id).await
    }
    async fn call_workspace_tool(
        &self,
        session: &str,
        turn: &str,
        args: &Value,
        approved: Option<&str>,
    ) -> Result<Value> {
        tool_execution::invoke(self.root.path(), session, turn, args, approved, &self.tool_backend).await
    }
    async fn direct(&self, name: &str, args: &Value, artifacts: &[ArtifactRef]) -> Result<Value> {
        direct::execute(self.store.clone(), name, args, artifacts)
    }
    async fn authoring(&self, name: &str, _: &Value) -> Result<Value> {
        if name == "save_workflow_draft" {
            self.saves.fetch_add(1, Ordering::SeqCst);
        }
        bail!("Unexpected authoring operation")
    }
    async fn record_operation(&self, record: &Value) -> Result<()> {
        self.records.lock().unwrap().push(record.clone());
        Ok(())
    }
}
fn task_decision() -> Content {
    Content::new("model").with_text(json!({"intent":"task","actionQuote":"分析","authoringQuote":"","reuseExisting":false,"summary":"检查文件并分析数据"}).to_string())
}

#[tokio::test]
async fn simple_file_request_and_declining_workflow_use_direct_tools_only() {
    for text in ["帮我分析一下这份数据", "不用整理成流程，只分析这一次"] {
        let workspace = Workspace::new();
        let reference = workspace
            .store
            .save_bytes("inventory.csv", "item,count,unit_cost\n笔,3,2\n本,4,5\n".as_bytes())
            .unwrap();
        let model = tests::ScriptedModel::new(vec![
            task_decision(),
            tests::call("read_artifact", json!({"artifact_id":reference.id})),
            tests::call(
                "run_code",
                json!({"code":"from pathlib import Path\nimport json\nfiles=json.loads(Path('/artifacts/manifest.json').read_text())\nrows=Path(files[0]['path']).read_text().strip().split('\\n')\nvalue=0\nfor row in rows[1:]:\n    fields=row.split(',')\n    value+=int(fields[1])*int(fields[2])\nPath('/outputs/summary.txt').write_text(str(value))\n{'inventory_value':value,'item_types':len(rows)-1}"}),
            ),
            Content::new("model").with_text("两类商品，库存价值26；结果已写入文件。"),
        ]);
        let reply = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    contents: vec![Content::new("user").with_text(text)],
                    capabilities: vec![],
                    context: protocol::AssistantContext {
                        session_id: Some("session".into()),
                        model_profile_id: None,
                        artifacts: vec![reference],
                    },
                },
                &|_| Ok(()),
                &workspace,
            )
            .await
            .unwrap();
        assert!(reply.call.is_none());
        assert_eq!(reply.artifacts.len(), 1);
        assert_eq!(
            std::fs::read_to_string(workspace.store.resolve(&reply.artifacts[0]).unwrap()).unwrap(),
            "26"
        );
        assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
        assert!(!workspace.root.path().join("workflow.json").exists());
        for request in model
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| !request.tools.is_empty())
        {
            assert!(request.tools.contains_key("run_code"));
            assert!(!request.tools.contains_key("prepare_workflow_task"));
            assert!(!request.tools.contains_key("get_workflow_reference"));
            assert!(
                !serde_json::to_string(&request.contents[0])
                    .unwrap()
                    .contains("workflow-node-agent")
            );
        }
        assert!(
            workspace
                .records
                .lock()
                .unwrap()
                .iter()
                .any(|record| record["status"] == "completed" && record["name"] == "run_code")
        );
    }
}

#[tokio::test]
async fn specialist_questions_return_to_parent_without_saving_or_executing() {
    let workspace = Workspace::new();
    let model=tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"authoring","actionQuote":"整理成流程","authoringQuote":"整理成流程","reuseExisting":false,"summary":"整理可复用流程"}).to_string()),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        Content::new("model").with_text(json!({"status":"needs_clarification","summary":"关键口径缺失","questions":["这里的有效记录如何界定？"]}).to_string()),
        Content::new("model").with_text("这里的有效记录如何界定？"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![
                    Content::new("user").with_text("public-user-context-marker"),
                    Content::new("user").with_text("帮我整理成流程"),
                ],
                capabilities: vec![],
                context: Default::default(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.text.contains("有效记录"));
    assert!(reply.call.is_none());
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    let requests = model.requests.lock().unwrap();
    assert!(!requests[1].tools.contains_key("prepare_workflow_task"));
    assert_eq!(
        requests[1].tools["transfer_to_agent"]["parameters"]["properties"]["agent_name"]["enum"],
        json!(["workflow_planner"])
    );
    assert_eq!(
        requests[2].tools["transfer_to_agent"]["parameters"]["properties"]["agent_name"]["enum"],
        json!(["main_agent"])
    );
    assert!(!requests.last().unwrap().tools.contains_key("transfer_to_agent"));
    assert!(!requests[1].tools.contains_key("save_workflow_draft"));
    assert!(!requests[2].tools.contains_key("save_workflow_draft"));
    assert!(requests[2].tools.contains_key("save_workflow_plan"));
    assert!(!requests[2].tools.contains_key("execute_capability"));
    assert!(!requests[2].tools.contains_key("prepare_workflow_task"));
    assert!(
        serde_json::to_string(&requests[2].contents)
            .unwrap()
            .contains("public-user-context-marker")
    );
    assert!(!requests[2].tools.contains_key("run_code"));
    assert!(
        workspace
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record["status"] == "needs_clarification")
    );
}

#[tokio::test]
async fn specialist_cannot_dispatch_even_if_it_requests_the_tool() {
    let workspace = Workspace::new();
    let model = tests::ScriptedModel::new(vec![
        Content::new("model")
            .with_text(json!({"intent":"authoring","actionQuote":"创建流程","summary":"创建流程"}).to_string()),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        tests::call(
            "execute_capability",
            json!({"capability_id":"unauthorized","bindings":[]}),
        ),
        Content::new("model").with_text("编排未完成，没有执行任何流程。"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("创建流程，不执行")],
                capabilities: vec![],
                context: Default::default(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    assert!(
        workspace
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record["status"] == "failed")
    );
}

fn has_number(value: &Value, expected: f64) -> bool {
    value
        .as_f64()
        .is_some_and(|number| (number - expected).abs() < 0.000001)
        // Interpreter results may be printed rather than returned as JSON.
        || value.as_str().is_some_and(|text| {
            text.split(|character: char| !character.is_ascii_digit() && character != '.' && character != '-')
                .filter_map(|token| token.parse::<f64>().ok())
                .any(|number| (number - expected).abs() < 0.000001)
        })
        || value
            .as_array()
            .is_some_and(|values| values.iter().any(|value| has_number(value, expected)))
        || value
            .as_object()
            .is_some_and(|values| values.values().any(|value| has_number(value, expected)))
}

#[tokio::test]
#[ignore = "uses configured Gemini; direct tools on temporary files, no workflows or business Apps"]
async fn live_main_agent_handles_natural_file_requests_without_workflows() {
    let model = super::evaluation::ProbeModel::new(
        std::sync::Arc::new(tests::live_gemini_model_from_env()),
        std::time::Duration::from_secs(6),
    );
    for (filename, data, prompt, expected) in [
        (
            "inventory.csv",
            "item,count,unit_cost\n笔,3,2\n本,4,5\n",
            "帮我分析一下这份库存数据",
            26.0,
        ),
        (
            "sales.csv",
            "date,product,quantity,unit_price\n2026-10-01,产品A,10,100\n2026-10-02,产品B,5,200\n2026-10-03,产品A,3,100\n2026-10-04,产品C,2,500\n",
            "帮我分析一下这份销售数据。这次只分析，不需要整理成流程。",
            3300.0,
        ),
    ] {
        let workspace = Workspace::new();
        let reference = workspace.store.save_bytes(filename, data.as_bytes()).unwrap();
        let reply = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    contents: vec![Content::new("user").with_text(prompt)],
                    capabilities: vec![],
                    context: protocol::AssistantContext {
                        session_id: Some(uuid::Uuid::new_v4().to_string()),
                        model_profile_id: Some("gemini-gemini-3.5-flash-lite".into()),
                        artifacts: vec![reference],
                    },
                },
                &|_| Ok(()),
                &workspace,
            )
            .await
            .unwrap_or_else(|error| panic!("Natural task failed ({})", super::evaluation::error_label(&error)));
        assert!(reply.call.is_none());
        assert!(!reply.text.trim().is_empty());
        assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
        let records = workspace.records.lock().unwrap();
        // run_code can inspect the authorized file directly; a separate preview is optional.
        assert!(
            records.iter().any(|record| record["name"] == "run_code"
                && record["status"] == "completed"
                && has_number(&record["result"], expected)),
            "{} did not produce verified calculation {}: records={:?}, answer={}",
            filename,
            expected,
            records,
            reply.text
        );
        assert!(!records.iter().any(|record| record["kind"] == "workflow_authoring"));
        println!(
            "Verified natural direct task: {}, numeric result {}, zero workflow saves",
            filename, expected
        );
    }
}

#[tokio::test]
async fn missing_operation_context_returns_feedback_without_aborting_the_turn() {
    let workspace = Workspace::new();
    let model = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"status","actionQuote":"","authoringQuote":"","reuseExisting":false,"summary":"查看操作记录"}).to_string()),
        tests::call("inspect_operations", json!({})),
        Content::new("model").with_text("当前没有会话标识，无法读取操作记录。"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("查看操作记录")],
                capabilities: vec![],
                context: Default::default(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    let requests = model.requests.lock().unwrap();
    assert!(
        serde_json::to_string(&requests[2].contents)
            .unwrap()
            .contains("requires a session ID")
    );
}

#[tokio::test]
async fn sdk_direct_handoff_does_not_require_a_custom_delegation_tool() {
    let workspace = Workspace::new();
    let model = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"authoring","actionQuote":"整理成流程","authoringQuote":"整理成流程","reuseExisting":false,"summary":"创建可复用的数据处理流程"}).to_string()),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
        Content::new("model").with_text(json!({"status":"needs_clarification","summary":"缺少输入约定","questions":["需要处理哪类输入？"]}).to_string()),
        Content::new("model").with_text("需要处理哪类输入？"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("帮我整理成流程")],
                capabilities: vec![],
                context: Default::default(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(reply.text.contains("输入"));
    let requests = model.requests.lock().unwrap();
    assert!(requests[1].tools.contains_key("transfer_to_agent"));
    assert!(requests[2].tools.contains_key("get_workflow_reference"));
    assert!(!requests[3].tools.contains_key("get_workflow_reference"));
    assert!(
        serde_json::to_string(&requests[2].contents)
            .unwrap()
            .contains("创建可复用的数据处理流程")
    );
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    assert!(
        workspace
            .records
            .lock()
            .unwrap()
            .iter()
            .any(|record| record["status"] == "needs_clarification")
    );
}

fn signed_transfer_batch(entries: &[(&str, Value)]) -> Content {
    Content {
        role: "model".into(),
        parts: entries
            .iter()
            .enumerate()
            .map(|(index, (name, args))| Part::FunctionCall {
                name: (*name).into(),
                args: args.clone(),
                id: Some(format!("handoff-{index}")),
                thought_signature: Some(format!("handoff-signature-{index}")),
            })
            .collect(),
    }
}

#[tokio::test]
async fn mixed_sdk_handoffs_are_repaired_without_running_siblings_or_losing_signatures() {
    let workspace = Workspace::new();
    let rejected = signed_transfer_batch(&[
        ("get_workflow_plan", json!({})),
        ("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
    ]);
    let progress = signed_transfer_batch(&[
        ("report_progress", json!({"summary":"must not be emitted"})),
        ("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
    ]);
    let model = tests::ScriptedModel::new(vec![
        Content::new("model").with_text(json!({"intent":"authoring","actionQuote":"整理成流程","authoringQuote":"整理成流程","reuseExisting":false,"summary":"创建可复用流程"}).to_string()),
        rejected.clone(),
        tests::call("get_workflow_plan",json!({})),
        progress,
        tests::call("transfer_to_agent",json!({"agent_name":"workflow_planner"})),
        Content::new("model").with_text(json!({"status":"needs_clarification","summary":"输入范围缺失","questions":["需要处理哪些输入？"]}).to_string()),
        Content::new("model").with_text("需要处理哪些输入？"),
    ]);
    let activity = Mutex::new(vec![]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("以后还要重复做，整理成流程，先不要运行")],
                capabilities: vec![],
                context: Default::default(),
            },
            &|event| {
                if let AssistantStreamEvent::Activity { summary } = event {
                    activity.lock().unwrap().push(summary);
                }
                Ok(())
            },
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(reply.text.contains("输入"));
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    assert!(activity.lock().unwrap().is_empty());
    let records = workspace.records.lock().unwrap();
    assert!(records.iter().all(|record| record["task"]["goal"] == "创建可复用流程"));
    assert!(records.iter().any(|record| record["status"] == "needs_clarification"));
    let requests = model.requests.lock().unwrap();
    let retry = &requests[2].contents;
    assert!(
        retry
            .iter()
            .any(|content| serde_json::to_value(content).unwrap() == serde_json::to_value(&rejected).unwrap())
    );
    let receipt = retry.last().unwrap();
    assert_eq!(receipt.parts.len(), 2);
    let wire = serde_json::to_value(receipt).unwrap().to_string();
    assert!(wire.contains("handoff-0") && wire.contains("handoff-1"));
    assert_eq!(wire.matches("\"executed\":false").count(), 2);
    assert!(!requests[5].tools.contains_key("execute_capability"));
    assert!(requests[5].tools.contains_key("get_workflow_reference"));
    assert!(!requests[6].tools.contains_key("get_workflow_reference"));
}

#[tokio::test]
async fn repeated_mixed_sdk_handoffs_stop_at_the_existing_model_budget_without_side_effects() {
    let workspace = Workspace::new();
    let invalid = signed_transfer_batch(&[
        ("report_progress", json!({"summary":"must not be emitted"})),
        ("transfer_to_agent", json!({"agent_name":"workflow_planner"})),
    ]);
    let model = tests::ScriptedModel::new(vec![
        Content::new("model")
            .with_text(json!({"intent":"authoring","actionQuote":"整理成流程","summary":"创建可复用流程"}).to_string()),
        invalid.clone(),
        invalid,
    ]);
    let mut runtime = tests::runtime();
    runtime.profile.max_model_steps = 2;
    let error = runtime
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("整理成流程，先不要运行")],
                capabilities: vec![],
                context: Default::default(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("limit"));
    assert!(workspace.records.lock().unwrap().is_empty());
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    assert_eq!(model.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn main_agent_discovers_installed_dependencies_without_creating_or_executing() {
    let workspace = Workspace::new();
    let model = tests::ScriptedModel::new(vec![
        task_decision(),
        tests::call("list_workspace_tools", json!({"query":"documents"})),
        tests::call("list_workspace_skills", json!({"query":"documents"})),
        tests::call("read_workspace_skill", json!({"name":"document-reader"})),
        Content::new("model").with_text("已查看可用能力；还没有执行。"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("分析可用的文档处理能力")],
                capabilities: vec![],
                context: protocol::AssistantContext {
                    session_id: Some("discovery".into()),
                    model_profile_id: None,
                    artifacts: vec![],
                },
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    let requests = model.requests.lock().unwrap();
    let serialized = serde_json::to_string(&requests.last().unwrap().contents).unwrap();
    for name in ["list_workspace_tools", "list_workspace_skills", "read_workspace_skill"] {
        let marker = format!("\"resourceTool\":\"{name}\"");
        assert!(
            serialized.contains(&marker),
            "Missing native resource response for {name}: {serialized}"
        );
    }
    assert!(serialized.contains("executed"));
    assert!(!serialized.contains("Workspace resources are unavailable"));
}

#[tokio::test]
async fn main_agent_proposes_then_executes_one_exact_confirmed_tool_call_without_workflows() {
    let workspace = Workspace::new();
    let initial = Content::new("user").with_text("分析工具结果");
    let args = tool_execution::tests::arguments(2);
    let model = tests::ScriptedModel::new(vec![
        task_decision(),
        tests::call("call_workspace_tool", args.clone()),
        Content::new("model").with_text("工具 test-tool，参数 value=2，是否确认调用？"),
    ]);
    let context = || protocol::AssistantContext {
        session_id: Some("tool-session".into()),
        model_profile_id: None,
        artifacts: vec![],
    };
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![initial.clone()],
                capabilities: vec![],
                context: context(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(workspace.tool_backend.calls.load(Ordering::SeqCst), 0);
    let pending = workspace.pending_tool_call("tool-session").await.unwrap().unwrap();
    let decision=Content::new("model").with_text(json!({"intent":"task","actionQuote":"确认这次调用","summary":"执行已确认的工具调用","toolConfirmation":{"id":pending["id"],"decision":"approve","quote":"确认这次调用"}}).to_string());
    let model = tests::ScriptedModel::new(vec![
        decision,
        tests::call("call_workspace_tool", args.clone()),
        tests::call("call_workspace_tool", args),
        Content::new("model").with_text("工具返回 answer=7。"),
    ]);
    let result = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![initial, reply.content, Content::new("user").with_text("确认这次调用")],
                capabilities: vec![],
                context: context(),
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(result.call.is_none());
    assert_eq!(workspace.tool_backend.calls.load(Ordering::SeqCst), 1);
    assert_eq!(workspace.saves.load(Ordering::SeqCst), 0);
    let requests = model.requests.lock().unwrap();
    let last = requests.last().unwrap();
    let history = serde_json::to_string(&last.contents).unwrap();
    assert!(history.contains("replayed"));
    assert!(history.contains("completed"));
    assert!(!last.tools.contains_key("execute_capability"));
    assert!(!last.tools.contains_key("transfer_to_agent"));
}

#[tokio::test]
async fn native_tool_refusal_closes_pending_call_without_exposing_execution() {
    let workspace = Workspace::new();
    let proposed = tool_execution::invoke(
        workspace.root.path(),
        "tool-session",
        "previous-turn",
        &tool_execution::tests::arguments(2),
        None,
        &workspace.tool_backend,
    )
    .await
    .unwrap();
    let decision=Content::new("model").with_text(json!({"intent":"clarification","actionQuote":"","summary":"取消调用","toolConfirmation":{"id":proposed["confirmation"]["id"],"decision":"deny","quote":"取消这次调用"}}).to_string());
    let model = tests::ScriptedModel::new(vec![decision, Content::new("model").with_text("已取消，没有执行。")]);
    tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("取消这次调用")],
                capabilities: vec![],
                context: protocol::AssistantContext {
                    session_id: Some("tool-session".into()),
                    model_profile_id: None,
                    artifacts: vec![],
                },
            },
            &|_| Ok(()),
            &workspace,
        )
        .await
        .unwrap();
    assert!(workspace.pending_tool_call("tool-session").await.unwrap().is_none());
    assert_eq!(workspace.tool_backend.calls.load(Ordering::SeqCst), 0);
    let requests = model.requests.lock().unwrap();
    assert!(!requests.last().unwrap().tools.contains_key("call_workspace_tool"));
}

#[tokio::test]
async fn status_and_receipt_continuations_cannot_call_workspace_tools() {
    for contents in [
        vec![Content::new("user").with_text("看看进度")],
        vec![Content::new("function").with_text("Existing receipt")],
    ] {
        let workspace = Workspace::new();
        let has_user = contents.last().unwrap().role == "user";
        let mut responses = vec![];
        if has_user {
            responses.push(
                Content::new("model")
                    .with_text(json!({"intent":"status","actionQuote":"看看进度","summary":"查看状态"}).to_string()),
            )
        }
        responses.push(tests::call("call_workspace_tool", tool_execution::tests::arguments(2)));
        let model = tests::ScriptedModel::new(responses);
        let result = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    contents,
                    capabilities: vec![],
                    context: protocol::AssistantContext {
                        session_id: Some("tool-session".into()),
                        model_profile_id: None,
                        artifacts: vec![],
                    },
                },
                &|_| Ok(()),
                &workspace,
            )
            .await;
        assert!(result.is_err());
        assert_eq!(workspace.tool_backend.calls.load(Ordering::SeqCst), 0);
        assert!(workspace.pending_tool_call("tool-session").await.unwrap().is_none());
    }
}

#[tokio::test]
async fn forged_confirmation_and_mixed_tool_batch_have_no_external_effects() {
    for forged in [true, false] {
        let workspace = Workspace::new();
        workspace.tool_backend.definition.lock().unwrap().execution_policy = crate::config::ToolExecutionPolicy::Auto;
        let mut decision = json!({"intent":"task","actionQuote":"分析","summary":"分析工具结果"});
        if forged {
            decision["toolConfirmation"] = json!({"id":"invented","decision":"approve","quote":"分析"});
        }
        let call = tests::call("call_workspace_tool", tool_execution::tests::arguments(2));
        let response = if forged {
            call
        } else {
            let mut batch = call;
            batch
                .parts
                .extend(tests::call("report_progress", json!({"summary":"Checking"})).parts);
            batch
        };
        let mut responses = vec![Content::new("model").with_text(decision.to_string()), response];
        if !forged {
            responses.push(Content::new("model").with_text("调用尚未执行。"));
        }
        let model = tests::ScriptedModel::new(responses);
        let result = tests::runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    contents: vec![Content::new("user").with_text("分析工具结果")],
                    capabilities: vec![],
                    context: protocol::AssistantContext {
                        session_id: Some("tool-session".into()),
                        model_profile_id: None,
                        artifacts: vec![],
                    },
                },
                &|_| Ok(()),
                &workspace,
            )
            .await;
        if forged {
            assert!(result.is_err())
        } else {
            assert!(result.is_ok())
        }
        assert_eq!(workspace.tool_backend.calls.load(Ordering::SeqCst), 0);
        assert!(workspace.pending_tool_call("tool-session").await.unwrap().is_none());
    }
}
