use super::main_agent::tools::tool_name;
use super::*;
use adk_rust::prelude::LlmResponse;
use serde_json::Value;
use std::{collections::VecDeque, sync::Mutex};
use tools::Capability;

pub(super) struct ScriptedModel {
    responses: Mutex<VecDeque<Content>>,
    pub(super) requests: Mutex<Vec<LlmRequest>>,
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
        context: Default::default(),
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
pub(super) fn call(name: &str, args: Value) -> Content {
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
        assert!(instruction.contains("Interpret ONLY") || instruction.contains("Workrun main agent"));
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
                    context: Default::default(),
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
                        context: Default::default(),
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
            json!({"items":[{"id":"native-report","kind":"workflow","name":"Report","description":"Generate a sales report for the supplied reporting period.","version":null,"inputSchema":{"type":"object","properties":{"period":{"type":"string","enum":["this_week","last_week"]}},"required":["period"],"additionalProperties":false},"outputSchema":{"type":"object"},"constraints":{"executable":true}}],"nextCursor":null}),
        )
    }
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        let mut page = self.list(args).await?;
        page["items"].as_array_mut().unwrap().push(json!({"id":"app:review","kind":"app","name":"Review","description":"Review a supplied expense amount.","version":"1.0.0","inputSchema":{"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"],"additionalProperties":false},"outputSchema":{"type":"object","properties":{"review":{"type":"boolean"}}},"constraints":{"executable":true}}));
        Ok(page)
    }
    async fn describe(&self, id: &str) -> Result<Capability> {
        self.describes.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if id == "app:review" {
            return Ok(Capability {
                id: id.into(),
                name: "Review".into(),
                description: "Review an expense amount".into(),
                parameters: json!({"type":"object","properties":{"amount":{"type":"number"}},"required":["amount"],"additionalProperties":false}),
            });
        }
        if id != "native-report" {
            bail!("Workflow is not available in this workspace");
        }
        Ok(Capability {
            id: id.into(),
            name: "Report".into(),
            description: "Native report".into(),
            parameters: json!({"type":"object","properties":{"period":{"type":"string","enum":["this_week","last_week"]}},"required":["period"]}),
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
            name: "execute_capability".into(),
            args: json!({"capability_id":"native-report","bindings":[{"input":"period","source":"message","message":0,"quote":"week","value_json":"\"this_week\""}]}),
            id: Some("report-call".into()),
            thought_signature: None,
        }],
    };
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "Make a report", "I will prepare the report."),
        call("list_capabilities", json!({"query":"Report"})),
        execution,
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::OpenAi,
            AssistantRequest {
                context: Default::default(),
                contents: vec![Content::new("user").with_text("Make a report for this week")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    let call = reply.call.unwrap();
    assert_eq!(call.workflow_id, "native-report");
    assert_eq!(call.input_sources.unwrap()[0]["value_json"], "\"this_week\"");
    assert_eq!(discovery.lists.load(Ordering::SeqCst), 1);
    assert_eq!(discovery.describes.load(Ordering::SeqCst), 1);
    let requests = model.requests.lock().unwrap();
    assert!(requests[1].tools.contains_key("execute_capability"));
    assert!(!requests[1].tools.contains_key("execute_workflow"));
    assert!(!requests[1].tools.contains_key("list_workflow"));
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
async fn native_binding_rejection_collects_missing_inputs_without_dispatch() {
    let discovery = NativeDiscoveryProbe {
        lists: 0.into(),
        describes: 0.into(),
    };
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "Make a report", "Prepare a report"),
        Content {
            role: "model".into(),
            parts: vec![Part::FunctionCall {
                name: "execute_capability".into(),
                args: json!({"capability_id":"native-report","bindings":{}}),
                id: Some("missing-period".into()),
                thought_signature: None,
            }],
        },
        text("Which reporting period should I use?"),
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::OpenAi,
            AssistantRequest {
                context: Default::default(),
                contents: vec![Content::new("user").with_text("Make a report")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    let requests = model.requests.lock().unwrap();
    let contents = serde_json::to_value(&requests[2].contents).unwrap();
    let receipt = &contents.as_array().unwrap().last().unwrap()["parts"][0]["functionResponse"]["response"];
    assert_eq!(receipt["executed"], false);
    assert!(
        receipt["error"]
            .as_str()
            .unwrap()
            .contains("Required capability inputs")
    );
}

#[tokio::test]
async fn native_legacy_input_tool_cannot_bypass_bindings() {
    let discovery = NativeDiscoveryProbe {
        lists: 0.into(),
        describes: 0.into(),
    };
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "Make a report", "Prepare a report"),
        call("execute_workflow", json!({"period":"invented"})),
    ]);
    let result = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::OpenAi,
            AssistantRequest {
                context: Default::default(),
                contents: vec![Content::new("user").with_text("Make a report")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await;
    assert!(result.unwrap_err().to_string().contains("not permitted"));
    assert_eq!(discovery.describes.load(std::sync::atomic::Ordering::SeqCst), 0);
}

#[tokio::test]
#[ignore = "uses configured Gemini; unified discovery fixture only, no business execution"]
async fn live_unified_capability_bindings() {
    use super::evaluation::ProbeModel;
    let model = ProbeModel::new(
        std::sync::Arc::new(live_gemini_model_from_env()),
        Duration::from_secs(6),
    );
    let discovery = NativeDiscoveryProbe {
        lists: 0.into(),
        describes: 0.into(),
    };
    let mut previous = None;
    for (input, expected) in [
        ("Use the Report capability to make a report for this week", true),
        ("Make a report", false),
    ] {
        let reply = runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: Default::default(),
                    contents: vec![Content::new("user").with_text(input)],
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &discovery,
            )
            .await
            .unwrap();
        assert_eq!(
            reply.call.is_some(),
            expected,
            "Unexpected final answer: {}",
            reply.text
        );
        if let Some(call) = reply.call {
            assert_eq!(call.tool_name, "execute_capability");
            assert_eq!(call.workflow_id, "native-report");
            assert!(call.input["period"].as_str().is_some_and(|v| !v.trim().is_empty()));
            previous = Some((input.to_owned(), reply.content, call.call_id));
        } else {
            assert!(!reply.text.trim().is_empty());
        }
        println!("Unified capability case: execution proposal={expected}");
    }
    let (input, content, id) = previous.unwrap();
    // Keep the provider's actual signed call; substitute only the synthetic
    // native receipt. No workflow or App from the user's workspace is run.
    let receipt=serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{"name":"execute_capability","response":{"runId":"completed-report","status":"completed","output":{"amount":1500}}},"id":id}]})).unwrap();
    let reply=runtime().run_with_discovery(&model,&ModelProvider::Gemini,AssistantRequest{context:Default::default(),contents:vec![Content::new("user").with_text(input),content,receipt,text("The report completed."),Content::new("user").with_text("Use the Review App to review the amount from the completed report. Bind its amount input to the report output.")],capabilities:vec![]},&|_|Ok(()),&discovery).await.unwrap();
    let call = reply.call.expect("App result binding not proposed");
    assert_eq!(call.workflow_id, "app:review");
    assert_eq!(call.input, json!({"amount":1500}));
    let bindings = reply
        .content
        .parts
        .iter()
        .find_map(|part| match part {
            Part::FunctionCall { args, .. } => args.get("bindings"),
            _ => None,
        })
        .unwrap();
    let binding = bindings
        .as_array()
        .unwrap()
        .iter()
        .find(|binding| binding["input"] == "amount")
        .unwrap();
    assert_eq!(binding["source"], "result");
    assert_eq!(binding["run_id"], "completed-report");
    println!("Unified capability case: Workflow receipt -> App input binding passed");
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
                context: Default::default(),
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
    let mut progress = call(
        "report_progress",
        json!({"summary":"I will compare the available approaches."}),
    );
    progress.parts.insert(
        0,
        Part::Text {
            text: "I'll start by reading the attached data file.".into(),
        },
    );
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "Help with planning"),
        progress,
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
    let displayed = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|event| match event {
            super::AssistantStreamEvent::TextDelta { text } | super::AssistantStreamEvent::TextReplace { text } => {
                Some(text.clone())
            },
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(displayed, vec![reply.text.clone()]);
    assert!(events.lock().unwrap().iter().any(|event| matches!(event,
        super::AssistantStreamEvent::Activity { summary } if summary == "I'll start by reading the attached data file."
    )));
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

/// Read-only provider probe: verifies the same displayable thinking used by chat.
#[tokio::test]
#[ignore = "uses configured Gemini API credentials and network"]
async fn live_gemini_streams_displayable_reasoning() {
    let model = live_gemini_model_from_env().with_thinking_config(
        crate::module::workflow::agent::conversation_thinking_config("gemini-3.5-flash-lite"),
    );
    let events = Mutex::new(Vec::new());
    let content = generate(&model, LlmRequest {
        model: model.name().into(),
        contents: vec![Content::new("user").with_text("Find the smallest positive integer divisible by 7 whose decimal digits sum to 43. Give the integer and verify it. Do not use tools.")],
        tools: HashMap::new(), config: None, previous_response_id: None,
    }, &|event| { events.lock().unwrap().push(event); Ok(()) }).await.unwrap();
    let events = events.into_inner().unwrap();
    let thoughts = events
        .iter()
        .filter_map(|event| match event {
            AssistantStreamEvent::Reasoning { text, .. } => Some(text.len()),
            _ => None,
        })
        .collect::<Vec<_>>();
    println!(
        "reasoning events: {}; final reasoning bytes: {}; answer bytes: {}",
        thoughts.len(),
        thoughts.last().unwrap_or(&0),
        content_text(&content).len()
    );
    assert!(
        thoughts.last().is_some_and(|count| *count > 0),
        "provider returned no displayable reasoning"
    );
}

fn tool_batch(items: &[(&str, Value)]) -> Content {
    Content {
        role: "model".into(),
        parts: items
            .iter()
            .enumerate()
            .map(|(index, (name, args))| Part::FunctionCall {
                name: (*name).into(),
                args: args.clone(),
                id: Some(format!("batch-{index}")),
                thought_signature: Some(format!("signed-{index}")),
            })
            .collect(),
    }
}

// SDK emits one function event per call. Compare the ordered response group
// rather than depending on a particular number of Content envelopes.
fn last_tool_results(messages: &[Content]) -> Content {
    let start = messages.iter().rposition(|message| message.role == "model").unwrap() + 1;
    Content {
        role: "function".into(),
        parts: messages[start..]
            .iter()
            .filter(|message| message.role == "function")
            .flat_map(|message| message.parts.clone())
            .collect(),
    }
}

#[tokio::test]
async fn batched_general_skills_preserve_ids_and_signatures() {
    for provider in [ModelProvider::OpenAi, ModelProvider::Gemini, ModelProvider::DeepSeek] {
        let batch = tool_batch(&[
            ("read_skill", json!({"name":"conversation"})),
            ("read_skill", json!({"name":"task-planning"})),
            ("read_skill", json!({"name":"result-delivery"})),
        ]);
        let expected = serde_json::to_value(&batch).unwrap();
        let model = ScriptedModel::new(vec![
            decision(Intent::Authoring, "创建销售分析流程", "先读取相关节点"),
            batch,
            text("已经读取相关节点配置。"),
        ]);
        let reply = runtime()
            .run(
                &model,
                &provider,
                request(vec![Content::new("user").with_text("创建销售分析流程，暂时不要执行")]),
                &|_| Ok(()),
            )
            .await
            .unwrap();
        assert!(reply.call.is_none());
        let requests = model.requests.lock().unwrap();
        let messages = &requests.last().unwrap().contents;
        assert!(
            messages
                .iter()
                .any(|message| serde_json::to_value(message).unwrap() == expected)
        );
        let result = last_tool_results(messages);
        assert_eq!(result.role, "function");
        assert_eq!(result.parts.len(), 3);
        let wire = serde_json::to_value(&result).unwrap().to_string();
        for expected in [
            "conversation",
            "task-planning",
            "result-delivery",
            "batch-0",
            "batch-1",
            "batch-2",
        ] {
            assert!(wire.contains(expected), "missing {expected}");
        }
        for part in &result.parts {
            let Part::FunctionResponse { function_response, .. } = part else {
                panic!("expected tool response")
            };
            assert_eq!(function_response.response["alreadyInInstructions"], true);
            assert!(function_response.response.get("content").is_none());
        }
        let instructions = model::content_text(&messages[0]);
        for name in ["conversation", "task-planning", "result-delivery"] {
            assert!(instructions.contains(&runtime().skills.read(name).unwrap()));
        }
    }
}

#[tokio::test]
async fn mixed_execution_batch_is_repairable_without_dispatch_or_progress() {
    let model = ScriptedModel::new(vec![
        decision(Intent::Execution, "取消订单43", "提交取消"),
        tool_batch(&[
            ("execute_workflow", json!({"workflow_id":"cancel-order","input":{}})),
            ("report_progress", json!({"summary":"should not run"})),
        ]),
        call("execute_workflow", json!({})),
    ]);
    let activities = Mutex::new(vec![]);
    let reply = runtime()
        .run(
            &model,
            &ModelProvider::Gemini,
            request(vec![Content::new("user").with_text("取消订单43")]),
            &|event| {
                if let AssistantStreamEvent::Activity { summary } = event {
                    activities.lock().unwrap().push(summary);
                }
                Ok(())
            },
        )
        .await
        .unwrap();
    assert_eq!(reply.call.unwrap().workflow_id, "cancel-order");
    assert!(!activities.lock().unwrap().iter().any(|text| text == "should not run"));
    let requests = model.requests.lock().unwrap();
    let results = last_tool_results(&requests.last().unwrap().contents);
    assert_eq!(results.parts.len(), 2);
    let wire = serde_json::to_value(results).unwrap().to_string();
    assert_eq!(wire.matches("\"executed\":false").count(), 2);
}

#[tokio::test]
async fn batch_read_errors_do_not_discard_other_results_and_large_batches_can_retry() {
    let oversized = tool_batch(
        &(0..9)
            .map(|_| ("read_skill", json!({"name":"task-planning"})))
            .collect::<Vec<_>>(),
    );
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "读取节点目录"),
        oversized,
        tool_batch(&[
            ("read_skill", json!({"name":"nonexistent-skill"})),
            ("read_skill", json!({"name":"task-planning"})),
        ]),
        text("已读取目录。"),
    ]);
    let reply = runtime()
        .run(
            &model,
            &ModelProvider::OpenAi,
            request(vec![Content::new("user").with_text("有哪些节点可以用？")]),
            &|_| Ok(()),
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    let requests = model.requests.lock().unwrap();
    let result = last_tool_results(&requests.last().unwrap().contents);
    assert_eq!(result.parts.len(), 2);
    let wire = serde_json::to_value(&result).unwrap().to_string();
    assert!(wire.contains("not enabled"));
    assert!(wire.contains("task-planning"));
}

#[tokio::test]
async fn retry_grants_execution_without_authorizing_new_drafts() {
    let store = RetryDiscovery;
    let model = ScriptedModel::new(vec![
        text(&json!({"intent":"execution","actionQuote":"重新执行一下","summary":"复用已保存的流程","reuseExisting":true}).to_string()),
        call("execute_capability", json!({"capability_id":"cancel-order","bindings":[]})),
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            request(vec![Content::new("user").with_text("重新执行一下")]),
            &|_| Ok(()),
            &store,
        )
        .await
        .unwrap();
    assert!(reply.call.is_some());
    let requests = model.requests.lock().unwrap();
    let tools = &requests.last().unwrap().tools;
    assert!(tools.contains_key("execute_capability"));
    assert!(!tools.contains_key("save_workflow_draft"));
}

struct RetryDiscovery;
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for RetryDiscovery {
    async fn list(&self, _: &Value) -> Result<Value> {
        Ok(json!({"items":[]}))
    }
    async fn describe(&self, _: &str) -> Result<Capability> {
        Ok(Capability {
            id: "cancel-order".into(),
            name: "Saved workflow".into(),
            description: String::new(),
            parameters: json!({"type":"object","properties":{}}),
        })
    }
}

#[tokio::test]
async fn failed_receipt_denies_draft_repair_but_can_deliver_the_original_failure() {
    let model = ScriptedModel::new(vec![
        call("save_workflow_draft", json!({"document_json":"{}"})),
        text("CodeAct failed after reaching its iteration limit. The workflow was not modified."),
    ]);
    let reply = runtime()
        .run(
            &model,
            &ModelProvider::Gemini,
            request(vec![
                Content::new("user").with_text("重新执行一下"),
                call("execute_workflow", json!({})),
                receipt(),
            ]),
            &|_| Ok(()),
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    assert!(reply.text.contains("iteration limit"));
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let denial = serde_json::to_value(requests.last().unwrap().contents.last().unwrap())
        .unwrap()
        .to_string();
    assert!(denial.contains("permissionDenied"));
    assert!(denial.contains("not authorized"));
    assert!(!requests.last().unwrap().tools.contains_key("save_workflow_draft"));
}

#[tokio::test]
async fn long_user_sources_reach_main_once_with_original_binding_indices() {
    let source = format!("{} tail-evidence-1700", "long-user-context ".repeat(1000));
    let model = ScriptedModel::new(vec![
        decision(Intent::Conversation, "", "Discuss the supplied material"),
        text("Noted."),
    ]);
    let history = vec![
        Content::new("user").with_text(&source),
        text("Prior reply"),
        Content::new("user").with_text("Explain further"),
    ];
    let original = serde_json::to_value(&history).unwrap();
    runtime()
        .run(&model, &ModelProvider::DeepSeek, request(history.clone()), &|_| Ok(()))
        .await
        .unwrap();
    let requests = model.requests.lock().unwrap();
    let main = requests.last().unwrap();
    let sent = serde_json::to_string(&main.contents).unwrap();
    assert_eq!(sent.matches("tail-evidence-1700").count(), 1);
    assert!(sent.contains("userOrdinal"));
    assert!(sent.contains("previewTruncated"));
    assert!(main.contents.iter().any(|c| content_text(c) == source));
    assert_eq!(serde_json::to_value(history).unwrap(), original);
}

#[tokio::test]
async fn ordinary_tasks_reuse_discovered_workflows_across_domains_without_authoring() {
    for (purpose, input_key, value) in [
        ("Summarize documents", "text", "meeting notes"),
        ("Check inventory", "sku", "A-17"),
        ("Transform records", "format", "JSON"),
    ] {
        let id = uuid::Uuid::new_v4().to_string();
        let message = format!("{purpose}: {value}");
        let model = ScriptedModel::new(vec![
            decision(Intent::Task, purpose, purpose),
            call("list_capabilities", json!({"query":purpose,"limit":5})),
            call("list_capabilities", json!({"capability_id":id})),
            call(
                "execute_capability",
                json!({"capability_id":id,"bindings":[{"input":input_key,"source":"message","message":0,"quote":value,"value_json":json!(value).to_string()}]}),
            ),
        ]);
        let reply = runtime().run(&model, &ModelProvider::Gemini, AssistantRequest {
            context: Default::default(),
            contents: vec![Content::new("user").with_text(&message)],
            capabilities: vec![Capability { id:id.clone(),name:purpose.into(),description:purpose.into(),parameters:json!({"type":"object","properties":{input_key:{"type":"string"}},"required":[input_key]}) }],
        }, &|_| Ok(())).await.unwrap();
        let call = reply.call.unwrap();
        assert_eq!(call.workflow_id, id);
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.len(), 4); // intent + search + contract + dispatch
        for request in requests.iter().skip(1) {
            assert!(!request.tools.contains_key("save_workflow_draft"));
            assert!(!request.tools.contains_key("transfer_to_agent"));
        }
    }
}

#[test]
fn task_execution_still_requires_current_action_evidence_and_never_grants_edits() {
    let decision = TurnDecision {
        intent: Intent::Task,
        action_quote: "Check inventory".into(),
        summary: "Check inventory".into(),
        reuse_existing: false,
        authoring_quote: String::new(),
        plan_feedback: None,
        tool_confirmation: None,
    };
    assert!(decision.allows_execution("Check inventory for A-17"));
    assert!(!decision.allows_execution("Explain the previous result"));
    assert!(!decision.allows_authoring("Check inventory for A-17"));
    for intent in [
        Intent::Conversation,
        Intent::Status,
        Intent::Explanation,
        Intent::Planning,
        Intent::Authoring,
    ] {
        assert!(
            !TurnDecision {
                intent,
                action_quote: decision.action_quote.clone(),
                summary: decision.summary.clone(),
                reuse_existing: false,
                authoring_quote: String::new(),
                plan_feedback: None,
                tool_confirmation: None
            }
            .allows_execution("Check inventory")
        );
    }
}

#[tokio::test]
async fn delivery_receives_complete_authorized_source_without_replaying_discovery() {
    struct EvidenceDiscovery(Value);
    #[async_trait::async_trait]
    impl tools::WorkflowDiscovery for EvidenceDiscovery {
        async fn list(&self, _: &Value) -> Result<Value> {
            bail!("No rediscovery needed")
        }
        async fn describe(&self, _: &str) -> Result<Capability> {
            bail!("No execution needed")
        }
        async fn inspect_operations(&self, session: &str) -> Result<Value> {
            assert_eq!(session, "delivery-session");
            Ok(self.0.clone())
        }
    }
    let artifact: crate::module::artifact::ArtifactRef = serde_json::from_value(
        json!({"$type":"artifact","id":"source","version":1,"name":"records.csv","mimeType":"text/plain","size":8}),
    )
    .unwrap();
    let discovery = EvidenceDiscovery(
        json!({"items":[{"kind":"direct_tool","name":"read_artifact","status":"completed","result":{"artifact":artifact,"text":"x,y\n1,2\n","offset":0,"total_characters":8,"truncated":false}}]}),
    );
    let receipt: Content = serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{"name":"execute_capability","response":{"runId":"run","status":"completed","output":{"report":"Completed report"},"result":"{}"}},"id":"call-43"}]})).unwrap();
    let history = vec![
        Content::new("user").with_text("Analyze the attached file"),
        call("execute_capability", json!({"capability_id":"known","bindings":[]})),
        receipt,
    ];
    let original = serde_json::to_value(&history).unwrap();
    let model = ScriptedModel::new(vec![text("Completed report")]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: protocol::AssistantContext {
                    session_id: Some("delivery-session".into()),
                    artifacts: vec![artifact],
                    ..Default::default()
                },
                contents: history.clone(),
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    assert!(reply.call.is_none());
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].contents.iter().any(
            |c| content_text(c).contains("Previously read complete input files") && content_text(c).contains("1,2")
        )
    );
    assert_eq!(serde_json::to_value(history).unwrap(), original);
}

struct InputDiscovery {
    field: Mutex<Value>,
    records: Mutex<Vec<Value>>,
    lists: std::sync::atomic::AtomicUsize,
}
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for InputDiscovery {
    async fn list(&self, _: &Value) -> Result<Value> {
        self.lists.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(json!({"items":[{"id":"processor","kind":"workflow","name":"Input processor"}],"nextCursor":null}))
    }
    async fn describe(&self, id: &str) -> Result<Capability> {
        anyhow::ensure!(matches!(id, "processor" | "other"), "Unexpected selected capability");
        anyhow::ensure!(
            id != "processor" || !self.field.lock().unwrap().is_null(),
            "Capability deleted"
        );
        let field = if id == "other" {
            json!({"type":"number"})
        } else {
            self.field.lock().unwrap().clone()
        };
        Ok(Capability {
            id: id.into(),
            name: "Input processor".into(),
            description: "Process a supplied input".into(),
            parameters: json!({"type":"object","properties":{"input":field},"required":["input"]}),
        })
    }
    async fn record_operation(&self, record: &Value) -> Result<()> {
        let mut records = self.records.lock().unwrap();
        records.retain(|r| r["id"] != record["id"]);
        records.insert(0, record.clone());
        Ok(())
    }
    async fn inspect_operations(&self, session: &str) -> Result<Value> {
        Ok(
            json!({"items":self.records.lock().unwrap().iter().filter(|r|r["sessionId"] == session).cloned().collect::<Vec<_>>()}),
        )
    }
}
impl InputDiscovery {
    fn new(field: Value) -> Self {
        Self {
            field: Mutex::new(field),
            records: Mutex::new(vec![]),
            lists: 0.into(),
        }
    }
}
fn input_context() -> protocol::AssistantContext {
    protocol::AssistantContext {
        session_id: Some("input-session".into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn missing_input_proposals_are_denied_and_completed_inputs_reuse_the_selected_contract() {
    for (field, empty, supplied) in [
        (
            json!({"type":"array","items":{"type":"string"}}),
            json!([]),
            json!(["uploaded-reference"]),
        ),
        (json!({"type":"string"}), json!(""), json!("document text")),
        (json!({"type":["number","null"]}), Value::Null, json!(0)),
        (
            json!({"type":"object","required":["start","end"]}),
            json!({}),
            json!({"start":"2026-10-01","end":"2026-10-31"}),
        ),
    ] {
        let discovery = InputDiscovery::new(field);
        let model = ScriptedModel::new(vec![
            decision(Intent::Task, "Process input", "Process input"),
            call("list_capabilities", json!({})),
            call(
                "execute_capability",
                json!({"capability_id":"processor","bindings":[
                    {"input":"input","source":"message","message":0,"quote":"Process input","value_json":empty.to_string()}
                ]}),
            ),
            text("Please provide input for the selected processor workflow."),
        ]);
        let history = vec![Content::new("user").with_text("Process input")];
        let reply = runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: input_context(),
                    contents: history.clone(),
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &discovery,
            )
            .await
            .unwrap();
        assert!(reply.call.is_none());
        assert!(!reply.text.is_empty());
        assert_eq!(model.requests.lock().unwrap().len(), 4);
        let error_history = serde_json::to_string(&model.requests.lock().unwrap().last().unwrap().contents).unwrap();
        assert!(error_history.contains("empty without explicit empty-value evidence"));
        assert!(
            !model
                .requests
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .tools
                .contains_key("list_capabilities")
        );
        assert_eq!(
            discovery.records.lock().unwrap()[0]["result"]["fields"],
            json!(["input"])
        );
        let quote = supplied.to_string();
        let followup = ScriptedModel::new(vec![
            decision(Intent::Task, &quote, "Use supplied input"),
            call(
                "execute_capability",
                json!({"capability_id":"processor","bindings":[
                    {"input":"input","source":"message","message":2,"quote":quote,"value_json":supplied.to_string()}
                ]}),
            ),
        ]);
        let mut history = history;
        history.push(reply.content);
        history.push(Content::new("user").with_text(&quote));
        let completed = runtime()
            .run_with_discovery(
                &followup,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: input_context(),
                    contents: history,
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &discovery,
            )
            .await
            .unwrap();
        let call = completed.call.unwrap();
        assert_eq!(call.workflow_id, "processor");
        assert_eq!(call.input, json!({"input":supplied}));
        assert_eq!(discovery.lists.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(followup.requests.lock().unwrap().len(), 2);
        let followup_context = content_text(&followup.requests.lock().unwrap()[1].contents[0]);
        assert!(followup_context.contains("Previous input clarification"));
        assert!(followup_context.contains("processor"));
    }
}

#[tokio::test]
async fn clarification_hints_refresh_contracts_allow_new_targets_and_expire() {
    for scenario in ["updated", "changed", "deleted", "stale", "status"] {
        let discovery = InputDiscovery::new(if scenario == "deleted" {
            Value::Null
        } else {
            json!({"type":"number"})
        });
        discovery
            .records
            .lock()
            .unwrap()
            .push(json!({"id":uuid::Uuid::new_v4().to_string(),
            "sessionId":"input-session","kind":"input_clarification","status":"awaiting_input",
            "result":{"capabilityId":"processor","fields":["oldField"],"goal":"Earlier goal",
                "userMessageCount":if scenario == "stale" {0} else {1}}}));
        let target = if scenario == "updated" { "processor" } else { "other" };
        let message = if scenario == "updated" {
            "Use 7"
        } else {
            "Switch to other for 7"
        };
        let mut responses = vec![decision(
            if scenario == "status" {
                Intent::Status
            } else {
                Intent::Task
            },
            if scenario == "status" { "" } else { message },
            "Current request",
        )];
        if scenario == "status" {
            responses.push(text("Waiting for input."));
        } else {
            if target == "other" {
                responses.push(call("list_capabilities", json!({})));
            }
            responses.push(call(
                "execute_capability",
                json!({"capability_id":target,"bindings":[
                {"input":"input","source":"message","message":2,"quote":"7","value_json":"7"}]}),
            ));
        }
        let model = ScriptedModel::new(responses);
        let reply = runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: input_context(),
                    contents: vec![
                        Content::new("user").with_text("Earlier goal"),
                        text("Please supply input."),
                        Content::new("user").with_text(message),
                    ],
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &discovery,
            )
            .await
            .unwrap();
        if scenario == "status" {
            assert!(reply.call.is_none());
        } else {
            assert_eq!(reply.call.unwrap().workflow_id, target);
        }
        let requests = model.requests.lock().unwrap();
        let instruction = content_text(&requests[1].contents[0]);
        assert_eq!(
            instruction.contains("Previous input clarification"),
            matches!(scenario, "updated" | "changed")
        );
        assert!(requests[1].tools.contains_key("list_capabilities"));
        if scenario == "updated" {
            assert!(instruction.contains("\"inputSchema\""));
            assert!(instruction.contains("\"number\""));
        }
    }
}

#[tokio::test]
async fn corrected_binding_in_the_same_turn_resolves_the_clarification_record() {
    let discovery = InputDiscovery::new(json!({"type":["number","null"]}));
    let model = ScriptedModel::new(vec![
        decision(Intent::Task, "Process input 0", "Process input"),
        call(
            "execute_capability",
            json!({"capability_id":"processor","bindings":[
            {"input":"input","source":"message","message":0,"quote":"Process input","value_json":"null"}]}),
        ),
        call(
            "execute_capability",
            json!({"capability_id":"processor","bindings":[
            {"input":"input","source":"message","message":0,"quote":"0","value_json":"0"}]}),
        ),
    ]);
    let reply = runtime()
        .run_with_discovery(
            &model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: input_context(),
                contents: vec![Content::new("user").with_text("Process input 0")],
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
        )
        .await
        .unwrap();
    assert_eq!(reply.call.unwrap().input, json!({"input":0}));
    assert_eq!(discovery.records.lock().unwrap().len(), 1);
    assert_eq!(discovery.records.lock().unwrap()[0]["status"], "resolved");
    let requests = model.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(!requests[2].tools.contains_key("list_capabilities"));
    assert!(requests[2].tools.contains_key("execute_capability"));
}
