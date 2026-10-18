//! Task-level regressions: ordinary work never enters workflow authoring.
use super::main_agent::direct;
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
        tests::call("prepare_workflow_task",json!({"goal":"整理分析流程","expected_outputs":["分析结果"],"acceptance_criteria":["满足已确认的分析口径"]})),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
        Content::new("model").with_text(json!({"status":"needs_clarification","summary":"关键口径缺失","questions":["这里的有效记录如何界定？"]}).to_string()),
        Content::new("model").with_text("这里的有效记录如何界定？"),
    ]);
    let reply = tests::runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                contents: vec![
                    Content::new("user").with_text("private-parent-history-marker"),
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
    assert!(requests[1].tools.contains_key("prepare_workflow_task"));
    assert_eq!(
        requests[1].tools["transfer_to_agent"]["parameters"]["properties"]["agent_name"]["enum"],
        json!(["workflow_author"])
    );
    assert_eq!(
        requests[3].tools["transfer_to_agent"]["parameters"]["properties"]["agent_name"]["enum"],
        json!(["main_agent"])
    );
    assert!(!requests.last().unwrap().tools.contains_key("transfer_to_agent"));
    assert!(!requests[1].tools.contains_key("save_workflow_draft"));
    assert!(requests[3].tools.contains_key("save_workflow_draft"));
    assert!(!requests[3].tools.contains_key("execute_capability"));
    assert!(!requests[3].tools.contains_key("prepare_workflow_task"));
    assert!(
        !serde_json::to_string(&requests[3].contents)
            .unwrap()
            .contains("private-parent-history-marker")
    );
    assert!(!requests[3].tools.contains_key("run_code"));
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
        tests::call(
            "prepare_workflow_task",
            json!({"goal":"创建流程","expected_outputs":["流程"],"acceptance_criteria":["结构有效"]}),
        ),
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
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
        tests::call("transfer_to_agent", json!({"agent_name":"workflow_author"})),
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
