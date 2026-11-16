//! Small, read-only routing. The selected handler always receives original inputs.
use super::{
    model::{content_text, generate, instructed},
    resources,
};
use crate::config::ModelProvider;
use adk_rust::{Content, GenerateContentConfig, Llm, LlmRequest};
use anyhow::Result;
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(super) enum Route {
    Conversation,
    Task,
    Workflow,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    route: Route,
}

fn preview(text: String, limit: usize) -> Value {
    json!({"text":text.chars().take(limit).collect::<String>(),"truncated":text.chars().count() > limit})
}

pub(super) async fn choose(
    model: &dyn Llm,
    provider: &ModelProvider,
    history: &[Content],
    has_artifacts: bool,
    plan: Option<&Value>,
) -> Result<Route> {
    // Routing needs conversational references, not tool payloads or full files.
    // Bounded previews never replace the durable messages sent to the handler.
    let latest = history.last().map(content_text).unwrap_or_default();
    let recent = history[..history.len().saturating_sub(1)]
        .iter()
        .rev()
        .filter(|c| matches!(c.role.as_str(), "user" | "model" | "assistant"))
        .take(4)
        .map(|c| json!({"role":c.role,"content":preview(content_text(c), 600)}))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>();
    let input = Content::new("user").with_text(json!({
        "latest":preview(latest, 2400),"recent":recent,"hasSessionFiles":has_artifacts,
        "hasMedia":history.last().is_some_and(|c|c.parts.iter().any(|p|!matches!(p, adk_rust::Part::Text{..}))),
        "workflowState":plan.map(|p|json!({"status":p["status"],"goal":preview(p["document"]["goal"].as_str().unwrap_or_default().into(), 400)})),
    }).to_string());
    let content = crate::module::model_usage::purpose("routing", generate(model, LlmRequest {
        model:model.name().into(),
        contents:instructed(provider, &resources::read("router/AGENT.md")?, &[input]),
        tools:Default::default(),
        config:Some(GenerateContentConfig { temperature:Some(0.0), response_schema:Some(json!({
            "type":"object","properties":{"route":{"type":"string","enum":["conversation","task","workflow"]}},
            "required":["route"],"additionalProperties":false,
        })),..Default::default() }), previous_response_id:None,
    }, &|_| Ok(()))).await?;
    // Invalid routing output cannot grant authority or strand a user request.
    Ok(serde_json::from_str::<Decision>(&content_text(&content))
        .map(|d| d.route)
        .unwrap_or(Route::Task))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::assistant::{
        protocol::{AssistantContext, AssistantRequest},
        tests::{ScriptedModel, call, runtime},
        tools::{Capability, WorkflowDiscovery},
    };

    fn text(value: &str) -> Content {
        Content::new("model").with_text(value)
    }
    fn request(input: &str) -> AssistantRequest {
        AssistantRequest {
            contents: vec![Content::new("user").with_text(input)],
            context: AssistantContext {
                session_id: Some("routing-test".into()),
                ..Default::default()
            },
            capabilities: vec![],
        }
    }
    fn is_router(request: &LlmRequest) -> bool {
        request
            .config
            .as_ref()
            .and_then(|c| c.response_schema.as_ref())
            .is_some_and(|s| s["properties"]["route"].is_object())
    }

    #[tokio::test]
    async fn router_is_tool_free_bounded_and_invalid_output_falls_back_to_task() {
        let history = vec![
            Content::new("user").with_text("原始资料".repeat(4000)),
            serde_json::from_value(json!({"role":"function","parts":[{"functionResponse":{
                "name":"read_artifact","response":{"private":"tool-payload-not-for-router"}},"id":"read"}]}))
            .unwrap(),
            Content::new("user").with_text("请依据前面的资料处理"),
        ];
        for provider in [ModelProvider::OpenAi, ModelProvider::Gemini, ModelProvider::DeepSeek] {
            let model = ScriptedModel::new(vec![text(r#"{"route":"unknown"}"#)]);
            assert_eq!(
                choose(&model, &provider, &history, true, None).await.unwrap(),
                Route::Task
            );
            let requests = model.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert!(requests[0].tools.is_empty());
            let input = content_text(&requests[0].contents[1]);
            assert!(input.chars().count() < 1600);
            assert!(input.contains("truncated"));
            assert!(!input.contains("tool-payload-not-for-router"));
        }
    }

    #[tokio::test]
    async fn conversation_uses_two_small_calls_without_task_schemas_or_skills() {
        for input in [
            "你好",
            "把这段说明改写得简洁一点",
            "Explain merge sort",
            "帮我讨论一个资料整理方案",
        ] {
            let model = ScriptedModel::new(vec![text(r#"{"route":"conversation"}"#), text("直接回答")]);
            let reply = runtime()
                .run(&model, &ModelProvider::OpenAi, request(input), &|_| Ok(()))
                .await
                .unwrap();
            assert_eq!(reply.text, "直接回答");
            let requests = model.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            assert!(is_router(&requests[0]));
            assert!(requests[0].tools.is_empty());
            assert_eq!(requests[1].tools.len(), 1);
            assert!(requests[1].tools.contains_key("handoff_to_task"));
            let overhead = requests
                .iter()
                .map(|r| {
                    content_text(&r.contents[0]).chars().count()
                        + serde_json::to_string(&r.tools).unwrap().chars().count()
                        + serde_json::to_string(&r.config).unwrap().chars().count()
                })
                .sum::<usize>();
            assert!(
                overhead < 3500,
                "routing and conversation grew to {overhead} characters"
            );
            assert_eq!(content_text(&requests[1].contents[1]), input);
        }
    }

    #[tokio::test]
    async fn conversation_can_handoff_once_without_replacing_original_inputs() {
        let model = ScriptedModel::new(vec![
            text(r#"{"route":"conversation"}"#),
            call("handoff_to_task", json!({})),
            call("report_progress", json!({"summary":"核对所需资料"})),
            text("任务处理结果"),
        ]);
        let reply = runtime()
            .run(&model, &ModelProvider::OpenAi, request("核对这份资料"), &|_| {
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(reply.text, "任务处理结果");
        let requests = model.requests.lock().unwrap();
        assert_eq!(requests.iter().filter(|r| is_router(r)).count(), 1);
        assert!(requests[2].tools.contains_key("list_capabilities"));
        assert_eq!(content_text(&requests[2].contents[1]), "核对这份资料");
        assert!(
            !serde_json::to_string(&requests[2].contents)
                .unwrap()
                .contains("handoff_to_task")
        );
    }

    struct Discovery;
    #[async_trait::async_trait]
    impl WorkflowDiscovery for Discovery {
        async fn list(&self, _: &Value) -> Result<Value> {
            Ok(json!({"items":[]}))
        }
        async fn describe(&self, _: &str) -> Result<Capability> {
            anyhow::bail!("No workflow")
        }
    }

    #[tokio::test]
    async fn workflow_route_enters_planner_without_an_initial_task_model_request() {
        let model = ScriptedModel::new(vec![
            text(r#"{"route":"workflow"}"#),
            text(r#"{"status":"needs_clarification","summary":"需要输入口径","questions":["输入来自哪里？"]}"#),
            text("输入来自哪里？"),
        ]);
        let reply = runtime()
            .run_with_discovery(
                &model,
                &ModelProvider::OpenAi,
                request("创建一个流程"),
                &|_| Ok(()),
                &Discovery,
            )
            .await
            .unwrap();
        assert!(reply.call.is_none());
        assert_eq!(reply.text, "输入来自哪里？");
        let requests = model.requests.lock().unwrap();
        assert!(is_router(&requests[0]));
        assert!(requests[1].tools.contains_key("save_workflow_plan"));
        assert!(!requests[1].tools.contains_key("execute_capability"));
        assert!(requests.iter().all(|request| {
            !request
                .config
                .as_ref()
                .and_then(|config| config.response_schema.as_ref())
                .is_some_and(|schema| schema["properties"]["intent"].is_object())
        }));
    }

    #[tokio::test]
    async fn workflow_routing_permits_proposals_but_never_definition_writes_or_execution() {
        for name in ["save_workflow_draft", "execute_capability", "call_workspace_tool"] {
            let model = ScriptedModel::new(vec![
                text(r#"{"route":"workflow"}"#),
                call(name, json!({})),
                text("该操作未获允许，未创建或执行。"),
            ]);
            let reply = runtime()
                .run_with_discovery(
                    &model,
                    &ModelProvider::OpenAi,
                    request("先给工作流方案，不要创建或执行"),
                    &|_| Ok(()),
                    &Discovery,
                )
                .await
                .unwrap();
            assert!(reply.call.is_none());
            let requests = model.requests.lock().unwrap();
            assert!(
                serde_json::to_string(&requests.last().unwrap().contents)
                    .unwrap()
                    .contains("not permitted")
            );
        }
    }

    #[tokio::test]
    #[ignore = "uses configured Gemini credentials; routing only, no tools or business effects"]
    async fn live_router_role_evaluation() {
        let model = crate::module::assistant::evaluation::ProbeModel::new(
            std::sync::Arc::new(crate::module::assistant::tests::live_gemini_model_from_env()),
            std::time::Duration::from_secs(6),
        );
        let mut cases = vec![];
        for (input, files, expected) in [
            ("解释一下归并排序的工作原理", false, Route::Conversation),
            ("请分析上传文件中的数据并生成可下载的汇总文件", true, Route::Task),
            (
                "创建并保存一个可复用的每周报表 Workflow，先规划，不运行",
                false,
                Route::Workflow,
            ),
            ("使用已有的销售报表 Workflow 生成本周报表", false, Route::Task),
            ("我想把报表自动化，有什么建议？先讨论思路", false, Route::Conversation),
        ] {
            let actual = choose(
                &model,
                &ModelProvider::Gemini,
                &[Content::new("user").with_text(input)],
                files,
                None,
            )
            .await
            .unwrap();
            cases.push(
                json!({"expected":format!("{expected:?}"),"actual":format!("{actual:?}"),"passed":actual==expected}),
            );
        }
        let report = json!({"cases":cases,"cost":model.costs_since(0),"businessEffects":false});
        let path = std::env::temp_dir().join("workrun-router-role-evaluation.json");
        std::fs::write(&path, serde_json::to_string_pretty(&report).unwrap()).unwrap();
        println!("Router role evaluation: {}", path.display());
        assert!(
            report["cases"].as_array().unwrap().iter().all(|c| c["passed"] == true),
            "{report}"
        );
    }
}
