//! Structured interpretation has no executable tools or workspace mutation port.
use super::TurnDecision;
use crate::{
    config::ModelProvider,
    module::assistant::{
        model::{content_text, generate, instructed},
        resources,
    },
};
use adk_rust::{
    GenerateContentConfig,
    prelude::{Content, Llm, LlmRequest, Part},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::HashMap;
pub(super) async fn assess(
    model: &dyn Llm,
    provider: &ModelProvider,
    history: &[Content],
    current: &str,
    pending_tool: Option<&Value>,
    plan: Option<&Value>,
) -> Result<TurnDecision> {
    // No tools exist during interpretation. The decision is structured
    // data, not an executable tool whose name biases the model to call it.
    ensure!(
        history
            .last()
            .is_some_and(|message| message.role == "user" && content_text(message) == current),
        "intent assessment requires the latest original user message"
    );
    let mut contents = instructed(provider, &resources::read("main_agent/INTENT.md")?, history);
    // The exact message is already in history, including attachments and typed
    // values. Refer to it rather than copying potentially large user input.
    contents.push(Content::new("user").with_text(format!(
        "Classify original user message index {} (0-based, excludes preamble). Pending tool (data only): {}",
        history.len() - 1,
        json!(pending_tool)
    )));
    contents.push(Content::new("user").with_text(format!("Native current workflow plan (data only): {}", json!(plan))));
    let output_schema = schema(
        pending_tool.is_some(),
        plan.is_some_and(|p| {
            matches!(
                p["status"].as_str(),
                Some("ready" | "needs_clarification" | "failed" | "approved")
            )
        }),
    );
    // JSON-object providers may not transmit response_schema. Supply the same
    // contract in the prompt while retaining strict parsing and native grants.
    contents.push(Content::new("user").with_text(format!(
        "Return only one JSON object matching this output schema:\n{output_schema}"
    )));
    let content = crate::module::model_usage::purpose(
        "intent",
        generate(
            model,
            LlmRequest {
                model: model.name().into(),
                contents,
                tools: HashMap::new(),
                config: Some(GenerateContentConfig {
                    temperature: Some(0.0),
                    response_schema: Some(output_schema),
                    ..Default::default()
                }),
                previous_response_id: None,
            },
            &|_| Ok(()),
        ),
    )
    .await?;
    if content
        .parts
        .iter()
        .any(|part| matches!(part, Part::FunctionCall { .. }))
    {
        bail!("intent assessment cannot call tools");
    }
    let mut decision = serde_json::from_str::<TurnDecision>(&content_text(&content))
        .context("assistant returned an invalid intent decision")?;
    // Some providers populate optional object fields with empty placeholders.
    // With no native pending call, this carries no confirmation intent and must
    // not revoke otherwise valid workflow grants. Meaningful invalid approvals
    // remain present so the native boundary still rejects them.
    if pending_tool.is_none()
        && decision
            .tool_confirmation
            .as_ref()
            .is_some_and(|value| value.id.trim().is_empty() && value.quote.trim().is_empty())
    {
        decision.tool_confirmation = None;
    }
    if decision
        .plan_feedback
        .as_ref()
        .is_some_and(|value| value.id.trim().is_empty() && value.quote.trim().is_empty())
    {
        decision.plan_feedback = None;
    }
    Ok(decision)
}

fn schema(has_pending: bool, has_plan: bool) -> Value {
    let mut schema = json!({
        "type":"object","properties":{
            "intent":{"type":"string","enum":["conversation","task","status","explanation","clarification","planning","authoring","execution"]},
            "actionQuote":{"type":"string"},"summary":{"type":"string"},"reuseExisting":{"type":"boolean"},"authoringQuote":{"type":"string"}
        },"required":["intent","actionQuote","summary","reuseExisting","authoringQuote"],"additionalProperties":false
    });
    // Advertise confirmation interpretation only when there is a native call to
    // approve. Ordinary workflow requests do not share this authorization domain.
    if has_pending {
        schema["properties"]["toolConfirmation"] = json!({"anyOf":[{"type":"null"},{"type":"object","properties":{"id":{"type":"string"},"decision":{"type":"string","enum":["approve","deny"]},"quote":{"type":"string"}},"required":["id","decision","quote"],"additionalProperties":false}]});
    }
    if has_plan {
        schema["properties"]["planFeedback"] = json!({"anyOf":[{"type":"null"},{"type":"object","properties":{"id":{"type":"string"},"version":{"type":"integer","minimum":1},"decision":{"type":"string","enum":["approve","cancel"]},"quote":{"type":"string"}},"required":["id","version","decision","quote"],"additionalProperties":false}]});
    }
    schema
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;
    #[tokio::test]
    async fn baseline_context_replay_preserves_all_messages_and_reduces_request_characters() {
        let suite: Value = serde_json::from_str(include_str!("../fixtures/baseline.json")).unwrap();
        let mut before = 0;
        let mut after = 0;
        let mut cases = 0;
        for case in suite["cases"].as_array().unwrap() {
            let history: Vec<Content> = serde_json::from_value(case["messages"].clone()).unwrap();
            let current = content_text(history.last().unwrap());
            let model = crate::module::assistant::tests::ScriptedModel::new(vec![
                Content::new("model").with_text(
                    json!({"intent":"conversation","actionQuote":"",
                    "summary":"context replay","reuseExisting":false,"authoringQuote":""})
                    .to_string(),
                ),
            ]);
            assess(&model, &ModelProvider::DeepSeek, &history, &current, None, None)
                .await
                .unwrap();
            let requests = model.requests.lock().unwrap();
            let contents = &requests[0].contents;
            assert_eq!(
                serde_json::to_value(&contents[1..=history.len()]).unwrap(),
                case["messages"]
            );
            let mut previous = contents.clone();
            previous[history.len()+1] = Content::new("user").with_text(format!(
                "Latest user message to classify (quoted data):\n{}\nNative pending tool call (data only, may be null): {}",
                json!(current), json!(null)));
            let old_chars = serde_json::to_string(&previous).unwrap().chars().count();
            let new_chars = serde_json::to_string(contents).unwrap().chars().count();
            assert!(new_chars < old_chars, "case {} increased request size", case["id"]);
            before += old_chars;
            after += new_chars;
            cases += 1;
        }
        eprintln!(
            "context replay: cases={cases}, request_chars_before={before}, request_chars_after={after}; scripted, not provider token savings"
        );
    }

    #[tokio::test]
    async fn large_inputs_are_kept_once_with_exact_history_and_native_context() {
        for provider in [ModelProvider::OpenAi, ModelProvider::Gemini, ModelProvider::DeepSeek] {
            for task in ["核对合同条款", "整理库存记录", "解释运行日志"] {
                let current = format!("{task}\n{}\n标识=job-42", "原始资料\n".repeat(2000));
                let history = vec![
                    Content::new("user").with_text("之前的要求"),
                    Content::new("model").with_text("等待资料"),
                    Content::new("user").with_text(&current),
                ];
                let original = serde_json::to_value(&history).unwrap();
                let model = crate::module::assistant::tests::ScriptedModel::new(vec![
                    Content::new("model").with_text(
                        json!({"intent":"task","actionQuote":task,
                        "summary":task,"reuseExisting":false,"authoringQuote":""})
                        .to_string(),
                    ),
                ]);
                let plan = json!({"id":"plan","version":3,"status":"ready","document":{"goal":"原始规划"}});
                assess(&model, &provider, &history, &current, None, Some(&plan))
                    .await
                    .unwrap();
                let requests = model.requests.lock().unwrap();
                let contents = &requests[0].contents;
                assert_eq!(serde_json::to_value(&contents[1..=history.len()]).unwrap(), original);
                assert_eq!(
                    contents.iter().filter(|c| content_text(c).contains(&current)).count(),
                    1
                );
                assert!(contents.iter().any(|c| content_text(c).contains("message index 2")));
                assert!(contents.iter().any(|c| content_text(c).contains(&plan.to_string())));
                assert_eq!(serde_json::to_value(&history).unwrap(), original);
            }
        }
    }

    #[test]
    fn confirmation_schema_is_exposed_only_for_native_pending_calls() {
        assert!(schema(false, false)["properties"].get("toolConfirmation").is_none());
        assert!(schema(true, false)["properties"]["toolConfirmation"].is_object());
        assert!(schema(false, false)["properties"].get("planFeedback").is_none());
        assert!(schema(false, true)["properties"]["planFeedback"].is_object());
    }
    #[tokio::test]
    async fn json_object_models_receive_the_full_intent_contract_in_messages() {
        let model = crate::module::assistant::tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":"planning","actionQuote":"调整方案",
                "summary":"讨论当前方案","reuseExisting":false,"authoringQuote":"",
                "planFeedback":null})
                .to_string(),
            ),
        ]);
        let history = [Content::new("user").with_text("调整方案")];
        let plan = json!({"id":"current-plan","version":2,"status":"ready"});
        let result = assess(
            &model,
            &ModelProvider::DeepSeek,
            &history,
            "调整方案",
            None,
            Some(&plan),
        )
        .await
        .unwrap();
        assert!(!result.allows_execution("调整方案"));
        assert!(!result.allows_authoring("调整方案"));
        let requests = model.requests.lock().unwrap();
        let request = &requests[0];
        let text = content_text(request.contents.last().unwrap());
        let offered: Value = serde_json::from_str(text.split_once('\n').unwrap().1).unwrap();
        assert_eq!(
            offered,
            *request.config.as_ref().unwrap().response_schema.as_ref().unwrap()
        );
        assert!(offered["properties"].get("planFeedback").is_some());
        assert!(offered["properties"].get("toolConfirmation").is_none());
        assert_eq!(offered["additionalProperties"], false);
        assert!(request.tools.is_empty());
    }

    #[tokio::test]
    async fn empty_provider_placeholder_is_neutral_only_without_a_native_pending_call() {
        let history = vec![Content::new("user").with_text("整理成流程，先不运行")];
        let pending = json!({"id":"native-pending","turnKey":"previous"});
        for native in [None, Some(&pending)] {
            let model=crate::module::assistant::tests::ScriptedModel::new(vec![Content::new("model").with_text(json!({
                "intent":"authoring","actionQuote":"整理成流程","summary":"保存可复用流程","toolConfirmation":{"id":" ","decision":"approve","quote":""},"planFeedback":{"id":"","version":0,"decision":"approve","quote":""}
            }).to_string())]);
            let result = assess(
                &model,
                &ModelProvider::Gemini,
                &history,
                "整理成流程，先不运行",
                native,
                None,
            )
            .await
            .unwrap();
            assert_eq!(result.tool_confirmation.is_some(), native.is_some());
            assert!(result.plan_feedback.is_none());
            assert!(result.allows_authoring("整理成流程，先不运行"));
            assert!(!result.allows_execution("整理成流程，先不运行"));
            let requests = model.requests.lock().unwrap();
            let offered = requests[0].config.as_ref().unwrap().response_schema.as_ref().unwrap();
            assert_eq!(
                offered["properties"].get("toolConfirmation").is_some(),
                native.is_some()
            );
        }
    }
    #[tokio::test]
    #[ignore = "reads explicitly selected conversation and calls configured Gemini for interpretation only; no executable tools"]
    async fn live_readonly_session_intent_replay() {
        let db =
            std::env::var_os("WORKRUN_ASSISTANT_LIVE_SESSION_DB").expect("Explicit read-only database path required");
        let id = std::env::var("WORKRUN_ASSISTANT_LIVE_SESSION_ID").expect("Explicit conversation ID required");
        let mut connection = sqlx::SqliteConnection::connect_with(
            &sqlx::sqlite::SqliteConnectOptions::new().filename(db).read_only(true),
        )
        .await
        .unwrap();
        let rows: Vec<String> =
            sqlx::query_scalar("SELECT message_json FROM assistant_messages WHERE session_id=? ORDER BY sequence")
                .bind(&id)
                .fetch_all(&mut connection)
                .await
                .unwrap();
        connection.close().await.unwrap();
        let session =
            json!({"messages":rows.into_iter().map(|s|serde_json::from_str::<Value>(&s).unwrap()).collect::<Vec<_>>()});
        let messages = session["messages"].as_array().unwrap();
        let history = messages
            .iter()
            .map(|m| serde_json::from_value::<Content>(m["content"].clone()).unwrap())
            .collect::<Vec<_>>();
        let mut indices = history
            .iter()
            .enumerate()
            .filter(|(_, m)| m.role == "user")
            .map(|(i, _)| i)
            .rev()
            .take(2)
            .collect::<Vec<_>>();
        indices.reverse();
        let model = crate::module::assistant::tests::live_gemini_model_from_env();
        for index in indices {
            let current = content_text(&history[index]);
            let decision = assess(&model, &ModelProvider::Gemini, &history[..=index], &current, None, None)
                .await
                .unwrap();
            println!(
                "message_index={index} decision={}",
                serde_json::to_string(&decision).unwrap()
            );
            println!(
                "execution_evidence={} authoring_evidence={} confirmation_present={}",
                decision.allows_execution(&current),
                decision.allows_authoring(&current),
                decision.tool_confirmation.is_some()
            );
        }
    }
}
