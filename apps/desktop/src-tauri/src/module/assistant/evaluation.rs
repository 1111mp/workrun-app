//! Test-only, data-driven main-agent evaluation. Scripted runs test the grader;
//! only opt-in provider runs measure semantic intent and routing quality.
use super::*;
use adk_rust::LlmResponseStream;
use serde_json::Value;
use std::sync::{Arc, Mutex};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Baseline {
    version: u32,
    capabilities: Vec<tools::Capability>,
    cases: Vec<Case>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    id: String,
    category: String,
    messages: Vec<Content>,
    expected: Expected,
    receipt: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    intents: Vec<Intent>,
    routing: Routing,
    workflow_id: Option<String>,
    arguments: Option<Value>,
    answer_contains_any: Option<Vec<String>>,
}
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Routing {
    None,
    Required,
    Clarify,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checks {
    intent: Option<bool>,
    routing: Option<bool>,
    arguments: Option<bool>,
    delivery: Option<bool>,
}
impl Checks {
    fn passed(&self) -> bool {
        [self.intent, self.routing, self.arguments, self.delivery]
            .into_iter()
            .flatten()
            .all(|pass| pass)
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaseResult {
    id: String,
    category: String,
    checks: Checks,
    observed_intent: Option<Intent>,
    workflow_id: Option<String>,
    input: Option<Value>,
    answer: Option<String>,
    error: Option<String>,
    infrastructure_error: bool,
}

fn baseline() -> Baseline {
    serde_json::from_str(include_str!("fixtures/baseline.json")).expect("invalid main-agent baseline")
}
fn grade(case: &Case, intent: Option<Intent>, reply: &AssistantReply, capabilities: &[tools::Capability]) -> Checks {
    let workflow_id = reply.call.as_ref().map(|call| call.workflow_id.as_str());
    let routing = match case.expected.routing {
        Routing::None => reply.call.is_none(),
        Routing::Required => workflow_id == case.expected.workflow_id.as_deref() && reply.call.is_some(),
        Routing::Clarify => match &reply.call {
            None => !reply.text.trim().is_empty(),
            Some(call) => {
                workflow_id == case.expected.workflow_id.as_deref()
                    && capabilities
                        .iter()
                        .find(|cap| cap.id == call.workflow_id)
                        .is_some_and(|cap| {
                            cap.parameters["required"].as_array().is_some_and(|keys| {
                                keys.iter().any(|key| {
                                    call.input.get(key.as_str().unwrap_or_default()).is_none_or(|value| {
                                        value.is_null() || value == "" || value.as_array().is_some_and(Vec::is_empty)
                                    })
                                })
                            })
                        })
            },
        },
    };
    Checks {
        intent: Some(intent.is_some_and(|intent| case.expected.intents.contains(&intent))),
        routing: Some(routing),
        arguments: case.expected.arguments.as_ref().map(|expected| {
            reply.call.as_ref().is_some_and(|call| {
                expected
                    .as_object()
                    .unwrap()
                    .iter()
                    .all(|(key, value)| call.input.get(key) == Some(value))
            })
        }),
        delivery: None,
    }
}

pub(super) struct ProbeModel {
    inner: Arc<dyn Llm>,
    intents: Arc<Mutex<Vec<Intent>>>,
    tool_names: Arc<Mutex<Vec<String>>>,
    last_request: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    interval: Duration,
}
impl ProbeModel {
    pub(super) fn called_tools(&self) -> Vec<String> {
        self.tool_names.lock().unwrap().clone()
    }
    pub(super) fn last_intent(&self) -> Option<Intent> {
        self.intents.lock().unwrap().last().copied()
    }
    pub(super) fn new(inner: Arc<dyn Llm>, interval: Duration) -> Self {
        Self {
            inner,
            intents: Arc::new(Mutex::new(vec![])),
            tool_names: Arc::new(Mutex::new(vec![])),
            last_request: tokio::sync::Mutex::new(None),
            interval,
        }
    }
}
#[async_trait::async_trait]
impl Llm for ProbeModel {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn schema_adapter(&self) -> &dyn adk_rust::SchemaAdapter {
        self.inner.schema_adapter()
    }
    async fn generate_content(&self, request: LlmRequest, stream: bool) -> adk_rust::Result<LlmResponseStream> {
        let is_intent = request
            .config
            .as_ref()
            .is_some_and(|config| config.response_schema.is_some());
        // Pace actual provider requests, not just cases: discovery can make many
        // requests in one case and otherwise exhaust the per-minute quota.
        let mut previous = self.last_request.lock().await;
        if let Some(previous) = *previous {
            tokio::time::sleep_until(previous + self.interval).await;
        }
        *previous = Some(tokio::time::Instant::now());
        drop(previous);
        let mut source = self.inner.generate_content(request, stream).await?;
        let intents = self.intents.clone();
        let tool_names = self.tool_names.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut probe = ReplyStream::new();
            while let Some(response) = source.next().await {
                if let Ok(response)=&response && let Some(content)=&response.content {
                    for part in &content.parts {if let Part::FunctionCall{name,..}=part {tool_names.lock().unwrap().push(name.clone());}}
                }
                if is_intent && let Ok(response) = &response {
                    let _ = probe.push(response.clone());
                }
                yield response;
            }
            if is_intent && let Ok(reply) = probe.finish(&[])
                && let Ok(decision) = serde_json::from_str::<TurnDecision>(&reply.text) {
                intents.lock().unwrap().push(decision.intent);
            }
        }))
    }
}

pub(super) fn error_label(error: &anyhow::Error) -> String {
    // Keep HTTP status but never serialize a transport URL or credentials.
    let text = error.to_string().to_lowercase();
    if text.contains("429") || text.contains("rate_limit") {
        return "rate_limited".into();
    }
    if text.contains("timed out") || text.contains("timeout") {
        return "timeout".into();
    }
    if text.contains("model.") || text.contains("connection") || text.contains("network") {
        for (pattern, label) in [
            ("no responses received", "empty_stream"),
            ("error sending request", "transport"),
            ("error decoding", "decode"),
            ("malformed", "malformed_response"),
        ] {
            if text.contains(pattern) {
                return format!("provider_error_{label}");
            }
        }
        for code in [400, 401, 403, 404, 500, 502, 503, 504] {
            if text.contains(&format!("code {code}"))
                || text.contains(&format!("\"code\": {code}"))
                || text.contains(&format!("{code} "))
            {
                return format!("provider_error_http_{code}");
            }
        }
        return "provider_error".into();
    }
    // Allowlisted labels retain diagnostic value without serializing model text,
    // tool arguments, or transport details into the report.
    for (pattern, label) in [
        ("one tool at a time", "parallel_tools"),
        ("not permitted for this turn", "unavailable_tool"),
        ("tool-step limit reached", "step_limit"),
        ("invalid intent decision", "invalid_intent"),
    ] {
        if text.contains(pattern) {
            return format!("runtime_rejection_{label}");
        }
    }
    "runtime_rejection".into()
}

async fn evaluate_case(
    runtime: &AssistantRuntime,
    model: &ProbeModel,
    case: &Case,
    capabilities: &[tools::Capability],
) -> CaseResult {
    let first_intent = model.intents.lock().unwrap().len();
    let reply = runtime
        .run(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: case.messages.clone(),
                capabilities: capabilities.to_vec(),
            },
            &|_| Ok(()),
        )
        .await;
    let intent = model.intents.lock().unwrap().get(first_intent).copied();
    let mut result = CaseResult {
        id: case.id.clone(),
        category: case.category.clone(),
        checks: Checks::default(),
        observed_intent: intent,
        workflow_id: None,
        input: None,
        answer: None,
        error: None,
        infrastructure_error: false,
    };
    match reply {
        Err(error) => {
            let kind = error_label(&error);
            result.infrastructure_error = !kind.starts_with("runtime_rejection");
            if !result.infrastructure_error {
                result.checks.intent = Some(intent.is_some_and(|intent| case.expected.intents.contains(&intent)));
                result.checks.routing = Some(false);
                result.checks.arguments = case.expected.arguments.as_ref().map(|_| false);
            }
            result.error = Some(kind);
        },
        Ok(reply) => {
            result.checks = grade(case, intent, &reply, capabilities);
            result.workflow_id = reply.call.as_ref().map(|call| call.workflow_id.clone());
            result.input = reply.call.as_ref().map(|call| call.input.clone());
            result.answer = Some(reply.text.clone());
            if let Some(receipt) = &case.receipt {
                if let Some(call) = &reply.call {
                    let mut contents = case.messages.clone();
                    contents.push(reply.content);
                    contents.push(
                        serde_json::from_value(json!({"role":"function","parts":[{
                            "functionResponse":{"name":call.tool_name,"response":receipt},"id":call.call_id
                        }]}))
                        .unwrap(),
                    );
                    match runtime
                        .run(
                            model,
                            &ModelProvider::Gemini,
                            AssistantRequest {
                                context: Default::default(),
                                contents,
                                capabilities: capabilities.to_vec(),
                            },
                            &|_| Ok(()),
                        )
                        .await
                    {
                        Ok(summary) => {
                            result.checks.delivery = Some(
                                summary.call.is_none()
                                    && !summary.text.trim().is_empty()
                                    && case.expected.answer_contains_any.as_ref().is_none_or(|terms| {
                                        terms
                                            .iter()
                                            .any(|term| summary.text.to_lowercase().contains(&term.to_lowercase()))
                                    }),
                            );
                            result.answer = Some(summary.text);
                        },
                        Err(error) => {
                            let kind = error_label(&error);
                            result.infrastructure_error = !kind.starts_with("runtime_rejection");
                            result.checks.delivery = Some(false);
                            result.error = Some(kind);
                        },
                    }
                } else {
                    result.checks.delivery = Some(false);
                }
            }
        },
    }
    result
}

fn report(results: &[CaseResult], selected: usize, model: &str) -> Value {
    let metrics = ["intent", "routing", "arguments", "delivery"]
        .into_iter()
        .map(|name| {
            let values = results
                .iter()
                .filter(|result| !result.infrastructure_error)
                .filter_map(|result| match name {
                    "intent" => result.checks.intent,
                    "routing" => result.checks.routing,
                    "arguments" => result.checks.arguments,
                    _ => result.checks.delivery,
                })
                .collect::<Vec<_>>();
            let total = values.len();
            let passed = values.into_iter().filter(|pass| *pass).count();
            (
                name.to_string(),
                json!({"passed":passed,"scored":total,"rate":(total > 0).then(||passed as f64 / total as f64)}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    let complete = results.len() == selected && results.iter().all(|result| !result.infrastructure_error);
    let passed = results
        .iter()
        .filter(|result| result.error.is_none() && result.checks.passed())
        .count();
    json!({"version":1,"createdAt":chrono::Utc::now().to_rfc3339(),"model":model,"selected":selected,"attempted":results.len(),"completed":results.iter().filter(|result|!result.infrastructure_error).count(),"passed":passed,"providerErrors":results.iter().filter(|result| result.infrastructure_error).count(),"status":if !complete {"incomplete"} else if passed == selected {"passed"} else {"failed"},"complete":complete,"metrics":metrics,"cases":results})
}

#[test]
fn evaluation_dataset_has_unique_ids_and_valid_expectations() {
    let suite = baseline();
    assert_eq!(suite.version, 1);
    assert!(suite.cases.len() >= 24);
    let mut ids = std::collections::HashSet::new();
    for case in &suite.cases {
        assert!(ids.insert(&case.id));
        assert!(!case.expected.intents.is_empty());
        assert_eq!(case.messages.last().unwrap().role, "user");
        if let Some(id) = &case.expected.workflow_id {
            let cap = suite
                .capabilities
                .iter()
                .find(|cap| &cap.id == id)
                .expect("unknown expected workflow");
            if let Some(args) = &case.expected.arguments {
                assert!(
                    jsonschema::validator_for(&cap.parameters).unwrap().is_valid(args),
                    "invalid expected arguments for {}",
                    case.id
                );
            }
        }
    }
}

#[test]
fn grader_separates_intent_routing_arguments_and_incomplete_runs() {
    let suite = baseline();
    let case = suite.cases.iter().find(|case| case.id == "sales-this-week").unwrap();
    let reply = |id: &str, period: &str| AssistantReply {
        pause: None,
        artifacts: vec![],
        content: Content::new("model"),
        text: String::new(),
        call: Some(protocol::WorkflowCall {
            workflow_id: id.into(),
            input: json!({"period":period}),
            tool_name: "execute_workflow".into(),
            call_id: None,
            input_sources: None,
        }),
    };
    let correct = grade(
        case,
        Some(Intent::Execution),
        &reply("sales-report", "this_week"),
        &suite.capabilities,
    );
    assert!(correct.passed());
    let incorrect = grade(
        case,
        Some(Intent::Conversation),
        &reply("invoice-summary", "last_week"),
        &suite.capabilities,
    );
    assert_eq!(
        (incorrect.intent, incorrect.routing, incorrect.arguments),
        (Some(false), Some(false), Some(false))
    );
    let incomplete = report(&[], 3, "test");
    assert_eq!(incomplete["complete"], false);
    assert!(incomplete["metrics"]["intent"]["rate"].is_null());
}

#[tokio::test]
#[ignore = "uses configured Gemini credentials; produces no business side effects"]
async fn live_assistant_evaluation_baseline() {
    let suite = baseline();
    let filter = std::env::var("WORKRUN_ASSISTANT_EVAL_CASES").ok();
    let selected = suite
        .cases
        .iter()
        .filter(|case| {
            filter
                .as_ref()
                .is_none_or(|filter| filter.split(',').any(|id| id.trim() == case.id))
        })
        .collect::<Vec<_>>();
    assert!(!selected.is_empty(), "no evaluation cases selected");
    let model = ProbeModel::new(
        Arc::new(super::tests::live_gemini_model_from_env()),
        Duration::from_secs(6),
    );
    let runtime = super::tests::runtime();
    let mut results = vec![];
    for case in &selected {
        let result = evaluate_case(&runtime, &model, case, &suite.capabilities).await;
        println!(
            "{}: {}",
            case.id,
            if result.infrastructure_error {
                result.error.as_deref().unwrap_or("provider error")
            } else if result.checks.passed() {
                "passed"
            } else {
                "failed"
            }
        );
        let failed_request = result.infrastructure_error;
        results.push(result);
        if failed_request {
            break;
        }
    }
    let mut output = report(&results, selected.len(), model.name());
    output["suiteSize"] = json!(suite.cases.len());
    output["selectedIds"] = json!(selected.iter().map(|case| &case.id).collect::<Vec<_>>());
    let path = std::env::var_os("WORKRUN_ASSISTANT_EVAL_REPORT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("workrun-assistant-evaluation.json"));
    std::fs::write(&path, serde_json::to_string_pretty(&output).unwrap()).unwrap();
    println!("Evaluation report: {}", path.display());
    assert!(
        output["complete"] == true,
        "evaluation incomplete; inspect report for provider errors"
    );
    assert!(
        results
            .iter()
            .all(|result| result.error.is_none() && result.checks.passed()),
        "semantic evaluation failed; inspect per-dimension report"
    );
}

#[test]
fn evaluation_probe_preserves_provider_schema_adaptation() {
    let model = adk_rust::model::GeminiModel::new("test-key", "gemini-test").unwrap();
    let probe = ProbeModel::new(Arc::new(model), Duration::ZERO);
    let schema = probe.schema_adapter().normalize_schema(
        json!({"type":"object","properties":{"amount":{"type":"number"}},"additionalProperties":false}),
    );
    assert!(schema.get("additionalProperties").is_none());
}

#[test]
fn grader_distinguishes_missing_inputs_from_invented_values() {
    let suite = baseline();
    let case = suite.cases.iter().find(|case| case.id == "missing-period").unwrap();
    let reply = |input| AssistantReply {
        pause: None,
        artifacts: vec![],
        content: Content::new("model"),
        text: String::new(),
        call: Some(protocol::WorkflowCall {
            workflow_id: "sales-report".into(),
            input,
            tool_name: "execute_workflow".into(),
            call_id: None,
            input_sources: None,
        }),
    };
    assert_eq!(
        grade(case, Some(Intent::Execution), &reply(json!({})), &suite.capabilities).routing,
        Some(true)
    );
    assert_eq!(
        grade(
            case,
            Some(Intent::Execution),
            &reply(json!({"period":"this_week"})),
            &suite.capabilities
        )
        .routing,
        Some(false)
    );
}

#[test]
fn reports_keep_provider_errors_out_of_semantic_scores_and_redact_urls() {
    let error = CaseResult {
        id: "greeting".into(),
        category: "conversation".into(),
        checks: Checks::default(),
        observed_intent: None,
        workflow_id: None,
        input: None,
        answer: None,
        error: Some("rate_limited".into()),
        infrastructure_error: true,
    };
    let result = report(&[error], 2, "test");
    assert_eq!(result["status"], "incomplete");
    assert_eq!(result["completed"], 0);
    assert_eq!(result["providerErrors"], 1);
    assert!(result["metrics"]["routing"]["rate"].is_null());
    let label = error_label(&anyhow::anyhow!(
        "model.network: https://example.invalid?key=synthetic-secret"
    ));
    assert!(!label.contains("synthetic-secret"));
    assert_eq!(
        error_label(&anyhow::anyhow!("assistant must call one tool at a time")),
        "runtime_rejection_parallel_tools"
    );
    assert_eq!(
        error_label(&anyhow::anyhow!(
            "tool `synthetic-secret` is not permitted for this turn"
        )),
        "runtime_rejection_unavailable_tool"
    );
}
