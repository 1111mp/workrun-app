use super::*;
use adk_rust::prelude::LlmResponse;
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};
use tools::{Capability, tool_name};

pub(super) struct ScriptedModel {
    responses: Mutex<VecDeque<Content>>,
    requests: Mutex<Vec<LlmRequest>>,
}
impl ScriptedModel {
    pub(super) fn new(responses: Vec<Content>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            requests: Mutex::new(vec![]),
        }
    }
}
#[async_trait::async_trait]
impl Llm for ScriptedModel {
    fn name(&self) -> &str {
        "test"
    }
    async fn generate_content(&self, request: LlmRequest, _: bool) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        self.requests.lock().unwrap().push(request);
        let content = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra model invocation");
        Ok(Box::pin(futures::stream::iter(vec![Ok(LlmResponse {
            content: Some(content),
            partial: false,
            ..Default::default()
        })])))
    }
}
pub(super) fn runtime() -> AssistantRuntime {
    AssistantRuntime {
        profile: AgentProfile::default(),
        skills: SkillCatalog::builtin(),
    }
}
fn capabilities() -> Vec<Capability> {
    vec![Capability {
        id: "cancel-order".into(),
        name: "Cancel order".into(),
        description: "Cancel the requested order".into(),
        parameters: json!({"type":"object","properties":{"message":{"type":"string"}}}),
    }]
}
fn request(contents: Vec<Content>) -> AssistantRequest {
    AssistantRequest {
        contents,
        capabilities: capabilities(),
    }
}
fn text(text: &str) -> Content {
    Content::new("model").with_text(text)
}
fn decision(intent: Intent, quote: &str, summary: &str) -> Content {
    text(&json!({"intent":intent,"actionQuote":quote,"summary":summary}).to_string())
}
fn call(name: &str, args: Value) -> Content {
    Content {
        role: "model".into(),
        parts: vec![Part::FunctionCall {
            name: name.into(),
            args: if name == "execute_workflow" {
                json!({"workflow_id":"cancel-order","input":args})
            } else {
                args
            },
            id: Some("call-43".into()),
            thought_signature: Some("signature".into()),
        }],
    }
}
fn receipt() -> Content {
    serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{"name":tool_name("cancel-order"),"response":{"status":"completed","result":{"orderId":"43","outcome":"pending_review"}}},"id":"call-43"}]})).unwrap()
}

#[tokio::test]
async fn conversation_execution_status_explanation_and_explicit_retry_have_separate_grants() {
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "帮我取消订单43", "我会为你提交订单43的取消请求。"),
        call(&tool_name("cancel-order"), json!({"message":"帮我取消订单43"})),
        text("订单43已转人工审核，尚未取消。"),
        decision(Intent::Status, "", "查询上一轮任务是否成功"),
        text("尚未成功：订单43正在等待人工审核。"),
        decision(Intent::Explanation, "", "解释执行结果"),
        text("现有回执显示进入了人工审核，没有取消成功的证据。"),
        decision(Intent::Conversation, "", "了解助手能力"),
        text("我可以对话，也能按需调用工作流。"),
        decision(Intent::Execution, "重新取消订单43", "我会重新提交订单43的取消请求。"),
        call(&tool_name("cancel-order"), json!({"message":"重新取消订单43"})),
    ]);
    let runtime = runtime();
    let mut history = vec![Content::new("user").with_text("帮我取消订单43")];
    let first = runtime
        .run(&model, &ModelProvider::Gemini, request(history.clone()), &|_| Ok(()))
        .await
        .unwrap();
    assert_eq!(first.call.as_ref().unwrap().input["message"], "帮我取消订单43");
    assert!(
        first.text.is_empty(),
        "tool-only output must not manufacture a separate answer"
    );
    history.push(first.content);
    history.push(receipt());
    let summary = runtime
        .run(&model, &ModelProvider::Gemini, request(history.clone()), &|_| Ok(()))
        .await
        .unwrap();
    assert!(summary.call.is_none());
    history.push(summary.content);
    for input in ["任务成功了吗", "为什么执行失败", "你能做什么"] {
        history.push(Content::new("user").with_text(input));
        let reply = runtime
            .run(&model, &ModelProvider::Gemini, request(history.clone()), &|_| Ok(()))
            .await
            .unwrap();
        assert!(reply.call.is_none(), "follow-up must not dispatch: {input}");
        history.push(reply.content);
    }
    history.push(Content::new("user").with_text("重新取消订单43"));
    let retry = runtime
        .run(&model, &ModelProvider::Gemini, request(history), &|_| Ok(()))
        .await
        .unwrap();
    assert!(retry.call.is_some());
    let requests = model.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.tools.contains_key(&tool_name("cancel-order")))
            .count(),
        2
    );
    for request in requests.iter() {
        // Simulates the Gemini adapter's accepted role set; instructions must
        // survive that boundary instead of being silently discarded as system.
        assert_eq!(request.contents[0].role, "user");
        let instruction = content_text(&request.contents[0]);
        assert!(instruction.contains("Classify ONLY") || instruction.contains("independent conversational agent"));
        if request
            .config
            .as_ref()
            .is_some_and(|config| config.response_schema.is_some())
        {
            assert!(request.tools.is_empty());
        }
    }
}

#[tokio::test]
async fn provider_cannot_dispatch_even_if_it_ignores_the_read_only_tool_schema() {
    for intent in [
        Intent::Status,
        Intent::Explanation,
        Intent::Conversation,
        Intent::Clarification,
    ] {
        let model = ScriptedModel::new(vec![
            decision(intent, "", "查询之前的结果"),
            call(&tool_name("cancel-order"), json!({})),
        ]);
        let error = runtime()
            .run(
                &model,
                &ModelProvider::Gemini,
                request(vec![Content::new("user").with_text("任务成功了吗")]),
                &|_| Ok(()),
            )
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("not permitted"));
    }
}

#[tokio::test]
async fn execution_requires_evidence_from_current_message_and_profile_permission() {
    for (quote, enabled) in [("帮我取消订单43", true), ("", true), ("重试", false)] {
        let mut runtime = runtime();
        runtime.profile.workflow_execution = enabled;
        let model = ScriptedModel::new(vec![
            decision(Intent::Execution, quote, "重试取消订单43"),
            call(&tool_name("cancel-order"), json!({})),
        ]);
        assert!(
            runtime
                .run(
                    &model,
                    &ModelProvider::OpenAi,
                    request(vec![Content::new("user").with_text("重试")]),
                    &|_| Ok(())
                )
                .await
                .is_err()
        );
    }
}

#[tokio::test]
async fn status_agent_can_read_receipts_and_skills_without_execution_permission() {
    let model = ScriptedModel::new(vec![
        decision(Intent::Status, "", "查看执行回执"),
        call("read_skill", json!({"name":"result-delivery"})),
        call("inspect_execution", json!({})),
        text("订单43正在等待人工审核。"),
    ]);
    let history = vec![
        Content::new("user").with_text("取消订单43"),
        call(&tool_name("cancel-order"), json!({})),
        receipt(),
        text("等待审核"),
        Content::new("user").with_text("任务成功了吗"),
    ];
    let reply = runtime()
        .run(&model, &ModelProvider::Gemini, request(history), &|_| Ok(()))
        .await
        .unwrap();
    assert!(reply.call.is_none());
    let requests = model.requests.lock().unwrap();
    let final_request = requests.last().unwrap();
    let serialized = serde_json::to_string(&final_request.contents).unwrap();
    assert!(serialized.contains("pending_review"));
    assert!(serialized.contains("success criteria"));
    assert!(!final_request.tools.contains_key(&tool_name("cancel-order")));
}

#[tokio::test]
async fn receipt_continuation_cannot_dispatch_again_or_reclassify_as_execution() {
    let model = ScriptedModel::new(vec![call(&tool_name("cancel-order"), json!({}))]);
    assert!(
        runtime()
            .run(&model, &ModelProvider::Gemini, request(vec![receipt()]), &|_| Ok(()))
            .await
            .is_err()
    );
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn readonly_tool_loop_is_bounded_and_unknown_tools_fail_closed() {
    let mut runtime = runtime();
    runtime.profile.max_model_steps = 1;
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "查看能力"),
        call("list_workflow", json!({})),
    ]);
    assert!(
        runtime
            .run(
                &model,
                &ModelProvider::OpenAi,
                request(vec![Content::new("user").with_text("你能做什么")]),
                &|_| Ok(())
            )
            .await
            .unwrap_err()
            .to_string()
            .contains("limit")
    );
}

#[test]
fn workspace_profile_is_independent_and_rejects_unknown_configuration() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("assistant")).unwrap();
    let path = dir.path().join("assistant/agent.json");
    std::fs::write(
        &path,
        r#"{"workflowExecution":false,"skills":[],"maxModelSteps":3,"instructions":"Use concise answers"}"#,
    )
    .unwrap();
    let runtime = AssistantRuntime::load(dir.path()).unwrap();
    assert!(!runtime.profile.workflow_execution);
    assert_eq!(runtime.profile.max_model_steps, 3);
    std::fs::write(path, r#"{"maxModelSteps":0}"#).unwrap();
    assert!(AssistantRuntime::load(dir.path()).is_err());
}

/// Exercises the real SDK role conversion and streaming parser, with a local
/// provider substitute. No credentials or real workflow side effects are used.
#[tokio::test]
#[ignore = "requires a local HTTP listener"]
async fn gemini_wire_keeps_instructions_and_status_turn_has_no_execution_tool() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let server = std::thread::spawn(move || {
        let mut bodies = vec![];
        for reply in [
            json!({"intent":"status","actionQuote":"","summary":"查看上一轮任务结果"}).to_string(),
            "订单43正在人工审核，尚未取消。".into(),
        ] {
            let deadline = std::time::Instant::now() + Duration::from_secs(15);
            let mut connection = loop {
                match listener.accept() {
                    Ok((connection, _)) => break connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(std::time::Instant::now() < deadline, "provider request not received");
                        std::thread::sleep(Duration::from_millis(10));
                    },
                    Err(error) => panic!("{error}"),
                }
            };
            connection.set_nonblocking(false).unwrap();
            connection.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let mut raw = vec![];
            let mut buffer = [0; 8192];
            let (offset, length) = loop {
                let n = connection.read(&mut buffer).unwrap();
                assert!(n > 0);
                raw.extend_from_slice(&buffer[..n]);
                if let Some(offset) = raw.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                    let headers = String::from_utf8_lossy(&raw[..offset]).to_lowercase();
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("content-length:"))
                        .unwrap()
                        .trim()
                        .parse::<usize>()
                        .unwrap();
                    break (offset + 4, length);
                }
            };
            while raw.len() < offset + length {
                let n = connection.read(&mut buffer).unwrap();
                assert!(n > 0);
                raw.extend_from_slice(&buffer[..n]);
            }
            bodies.push(serde_json::from_slice::<Value>(&raw[offset..offset + length]).unwrap());
            let payload =
                json!({"candidates":[{"content":{"role":"model","parts":[{"text":reply}]},"finishReason":"STOP"}]})
                    .to_string();
            let body = format!("data: {payload}\n\n");
            write!(connection, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
        }
        bodies
    });
    let model =
        adk_rust::model::GeminiModel::new_with_base_url("test-key", "gemini-test", format!("http://{address}/v1beta/"))
            .unwrap();
    let history = vec![
        Content::new("user").with_text("取消订单43"),
        call(&tool_name("cancel-order"), json!({"message":"取消订单43"})),
        receipt(),
        text("等待人工审核"),
        Content::new("user").with_text("任务成功了吗"),
    ];
    let reply = runtime()
        .run(&model, &ModelProvider::Gemini, request(history), &|_| Ok(()))
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(reply.text.contains("尚未取消"));
    let bodies = server.join().unwrap();
    assert!(bodies[0]["contents"].to_string().contains("Classify ONLY"));
    assert!(
        !bodies[0]["generationConfig"]
            .to_string()
            .contains("additionalProperties")
    );
    assert!(
        bodies[1]["contents"]
            .to_string()
            .contains("independent conversational agent")
    );
    assert!(bodies[1]["contents"].to_string().contains("conversation"));
    // Discovery descriptions can mention execute_workflow. Permission is
    // determined by declared function names, not arbitrary descriptive text.
    let names = bodies[1]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|tool| tool["functionDeclarations"].as_array().unwrap())
        .map(|declaration| declaration["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert!(names.contains(&"list_workflow"));
    assert!(!names.contains(&super::tools::EXECUTE_WORKFLOW));
}

/// Opt-in semantic regression against a configured Gemini provider. It only asks
/// the model to propose tool calls; no workflow executor exists in this test.
#[tokio::test]
#[ignore = "uses configured Gemini API credentials and network"]
async fn live_gemini_followups_do_not_propose_another_execution() {
    let model = live_gemini_model_from_env();
    let filter = std::env::var("WORKRUN_ASSISTANT_LIVE_FILTER").ok();
    for input in ["任务成功了吗", "为什么执行失败", "你能做什么", "重新取消订单43"] {
        if filter.as_ref().is_some_and(|filter| !input.contains(filter)) {
            continue;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
        let history = vec![
            Content::new("user").with_text("帮我取消订单43"),
            text(
                "执行回执（只读历史记录）：{\"status\":\"completed\",\"result\":{\"orderId\":\"43\",\"outcome\":\"pending_review\"}}\n先前的回答：订单42已取消。如果您需要取消订单43，请再次告诉我。",
            ),
            Content::new("user").with_text(input),
        ];
        let reply = runtime()
            .run(&model, &ModelProvider::Gemini, request(history), &|_| Ok(()))
            .await
            .expect("live assistant turn failed");
        assert_eq!(
            reply.call.is_some(),
            input == "重新取消订单43",
            "unexpected execution decision for {input}"
        );
        println!("{input}: execution={}", reply.call.is_some());
    }
    // Product-level coverage spans direct deliverables, planning and tool-backed
    // work; the historical incident above remains only a regression fixture.
    for (input, execute) in [
        ("帮我写一封简短的项目进展邮件", false),
        ("先帮我规划资料整理步骤", false),
        ("我想把报表自动化，有什么建议", false),
        ("生成本周销售报表", true),
    ] {
        if filter.as_ref().is_some_and(|filter| !input.contains(filter)) {
            continue;
        }
        tokio::time::sleep(Duration::from_secs(10)).await;
        let request = AssistantRequest {
            contents: vec![Content::new("user").with_text(input)],
            capabilities: vec![Capability {
                id: "sales-report".into(),
                name: "Sales report".into(),
                description: "Read workspace sales data and generate a sales report for the requested period.".into(),
                parameters: json!({"type":"object","properties":{"period":{"type":"string","description":"Requested reporting period"}},"required":["period"]}),
            }, Capability {
                id: "invoice-summary".into(),
                name: "Invoice summary".into(),
                description: "Extract invoice totals from supplied invoice files. Does not query sales data or generate sales reports.".into(),
                parameters: json!({"type":"object","properties":{"files":{"type":"array","items":{"type":"object"}}},"required":["files"]}),
            }, Capability {
                id: "document-translation".into(),
                name: "Document translation".into(),
                description: "Translate a supplied document into a requested language. Does not query sales data or generate sales reports.".into(),
                parameters: json!({"type":"object","properties":{"language":{"type":"string"}},"required":["language"]}),
            }],
        };
        let reply = runtime()
            .run(&model, &ModelProvider::Gemini, request, &|_| Ok(()))
            .await
            .expect("live product scenario failed");
        assert_eq!(
            reply.call.is_some(),
            execute,
            "unexpected execution decision for {input}"
        );
        println!("{input}: execution={}", reply.call.is_some());
        if let Some(call) = reply.call {
            assert_eq!(
                call.workflow_id, "sales-report",
                "selected the wrong capability for {input}"
            );
            assert!(
                call.input["period"]
                    .as_str()
                    .is_some_and(|period| !period.trim().is_empty()),
                "missing report period"
            );
            println!("Selected sales-report with a nonempty period from three candidates");
            // Use the real provider's signed call, then substitute only the
            // workflow receipt. This verifies native result continuation without
            // attaching an executor or producing any business side effects.
            let receipt: Content = serde_json::from_value(json!({"role":"function","parts":[{
                "functionResponse":{"name":call.tool_name,"response":{"status":"completed","result":{"summary":"Weekly sales report is ready"}}},"id":call.call_id
            }]})).unwrap();
            let summary = runtime()
                .run(
                    &model,
                    &ModelProvider::Gemini,
                    AssistantRequest {
                        contents: vec![Content::new("user").with_text(input), reply.content, receipt],
                        capabilities: vec![],
                    },
                    &|_| Ok(()),
                )
                .await
                .expect("live result continuation failed");
            assert!(summary.call.is_none());
            assert!(!summary.text.trim().is_empty());
            println!("Result continuation: answered without another execution");
        }
    }
}

struct NativeDiscoveryProbe {
    lists: std::sync::atomic::AtomicUsize,
    describes: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for NativeDiscoveryProbe {
    async fn list(&self, _: &Value) -> Result<Value> {
        self.lists.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(
            json!({"items":[{"id":"native-report","name":"Report","inputSchema":{"type":"object","properties":{"period":{"type":"string"}}}}]}),
        )
    }
    async fn describe(&self, id: &str) -> Result<Capability> {
        self.describes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if id != "native-report" {
            bail!("Workflow is not available in this workspace");
        }
        Ok(Capability {
            id: id.into(),
            name: "Report".into(),
            description: "Native report".into(),
            parameters: json!({"type":"object"}),
        })
    }
}
#[tokio::test]
async fn native_discovery_is_lazy_and_unified_execution_resolves_a_workspace_authorized_id() {
    use std::sync::atomic::Ordering;
    let discovery = NativeDiscoveryProbe {
        lists: 0.into(),
        describes: 0.into(),
    };
    let execution = Content {
        role: "model".into(),
        parts: vec![Part::FunctionCall {
            name: "execute_workflow".into(),
            args: json!({"workflow_id":"native-report","input":{"period":"week"}}),
            id: Some("report-call".into()),
            thought_signature: None,
        }],
    };
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "Make a report", "I will prepare the report."),
        call("list_workflow", json!({"query":"Report"})),
        execution,
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::OpenAi,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("Make a report")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    assert_eq!(reply.call.unwrap().workflow_id, "native-report");
    assert_eq!(discovery.lists.load(Ordering::SeqCst), 1);
    assert_eq!(discovery.describes.load(Ordering::SeqCst), 1);
    let requests = model.requests.lock().unwrap();
    assert!(
        !serde_json::to_string(&requests[1].tools)
            .unwrap()
            .contains("native-report")
    );
    assert!(
        serde_json::to_string(&requests[2].contents)
            .unwrap()
            .contains("native-report")
    );
}
#[tokio::test]
async fn direct_conversation_does_not_fetch_workflow_catalog_or_prepare_execution() {
    use std::sync::atomic::Ordering;
    let discovery = NativeDiscoveryProbe {
        lists: 0.into(),
        describes: 0.into(),
    };
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "Discuss an idea"),
        text("Here is an approach."),
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::OpenAi,
            AssistantRequest {
                contents: vec![Content::new("user").with_text("Discuss this idea")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(discovery.lists.load(Ordering::SeqCst), 0);
    assert_eq!(discovery.describes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn public_progress_is_a_separate_event_and_not_final_answer_text() {
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "Help with planning"),
        call(
            "report_progress",
            json!({"summary":"I will compare the available approaches."}),
        ),
        text("Here is the proposed plan."),
    ]);
    let events = std::sync::Mutex::new(Vec::new());
    let reply = runtime()
        .run(
            &model,
            &ModelProvider::Gemini,
            request(vec![Content::new("user").with_text("Help plan this project")]),
            &|event| {
                events.lock().unwrap().push(event);
                Ok(())
            },
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert_eq!(reply.text, "Here is the proposed plan.");
    assert!(events.lock().unwrap().iter().any(|event| matches!(event,
        super::AssistantStreamEvent::Activity { summary } if summary == "I will compare the available approaches."
    )));
}

pub(super) fn live_gemini_model_from_env() -> adk_rust::model::GeminiModel {
    let directory = std::env::var_os("WORKRUN_ASSISTANT_LIVE_CONFIG_DIR")
        .expect("set WORKRUN_ASSISTANT_LIVE_CONFIG_DIR explicitly");
    let directory = std::path::PathBuf::from(directory);
    let source = std::fs::read_to_string(directory.join("workrun.yaml")).unwrap();
    let config: Value = serde_yaml_ng::from_str(&source).unwrap();
    let credential = config["provider_credentials"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["provider"] == "gemini")
        .expect("Gemini is not configured");
    let key = std::fs::read(directory.join(".encryption_key")).unwrap();
    let decrypted = crate::config::decrypt_data_with_key(credential["apiKey"].as_str().unwrap(), &key)
        .expect("cannot decrypt configured credential");
    let api_key: Option<String> = serde_json::from_str(&decrypted).unwrap();
    let model_name = std::env::var("WORKRUN_ASSISTANT_LIVE_MODEL").unwrap_or_else(|_| "gemini-3.5-flash-lite".into());
    adk_rust::model::GeminiModel::new(api_key.unwrap(), model_name).unwrap()
}
