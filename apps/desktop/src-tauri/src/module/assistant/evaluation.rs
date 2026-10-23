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
    cost: Value,
}

fn baseline() -> Baseline {
    serde_json::from_str(include_str!("fixtures/baseline.json")).expect("invalid main-agent baseline")
}

// Use the production discovery boundary with an isolated catalog. The adapter
// exposes contracts only; it cannot run workflows or touch the user's workspace.
struct Catalog<'a>(&'a [tools::Capability]);
#[async_trait::async_trait]
impl tools::WorkflowDiscovery for Catalog<'_> {
    async fn list(&self, args: &Value) -> Result<Value> {
        tools::list_page(self.0, args)
    }
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        main_agent::tools::ToolRegistry {
            capabilities: self.0,
            skills: &SkillCatalog::builtin(),
            history: &[],
            execution_allowed: false,
            authoring_allowed: false,
            planning_allowed: false,
            workflows_enabled: true,
            workspace_tools_allowed: false,
        }
        .read("list_capabilities", args)
    }
    async fn describe(&self, id: &str) -> Result<tools::Capability> {
        self.0
            .iter()
            .find(|cap| cap.id == id)
            .cloned()
            .context("Unknown evaluation capability")
    }
}

#[tokio::test]
async fn case_costs_preserve_calls_and_unknown_usage_without_claiming_execution() {
    let suite = baseline();
    let case = suite.cases.iter().find(|case| case.id == "greeting").unwrap();
    let model = ProbeModel::new(
        Arc::new(tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":"conversation","actionQuote":"",
            "summary":"问候","reuseExisting":false,"authoringQuote":""})
                .to_string(),
            ),
            Content::new("model").with_text("你好"),
        ])),
        Duration::ZERO,
    );
    let result = evaluate_case(&tests::runtime(), &model, case, &suite.capabilities).await;
    assert!(result.checks.passed());
    assert_eq!(result.cost["calls"].as_array().unwrap().len(), 2);
    assert_eq!(result.cost["calls"][0]["phase"], "intent");
    assert_eq!(result.cost["calls"][1]["phase"], "conversation");
    for call in result.cost["calls"].as_array().unwrap() {
        assert!(call["contentsChars"].as_u64().unwrap() > 0);
        assert!(call["usage"].is_null());
        assert!(!call.to_string().contains("问候"));
    }
    assert_eq!(result.cost["executionIncluded"], false);
    assert!(report(&[result], 1, "test")["cases"][0]["cost"].is_object());
}

struct CostFixture(bool);
#[async_trait::async_trait]
impl Llm for CostFixture {
    fn name(&self) -> &str {
        "cost-fixture"
    }
    async fn generate_content(&self, _: LlmRequest, _: bool) -> adk_rust::Result<LlmResponseStream> {
        if self.0 {
            return Err(adk_rust::AdkError::agent("connection failed"));
        }
        let chunks = [3, 5].map(|output| {
            Ok(adk_rust::LlmResponse {
                usage_metadata: Some(adk_rust::UsageMetadata {
                    prompt_token_count: 7,
                    candidates_token_count: output,
                    total_token_count: 7 + output,
                    ..Default::default()
                }),
                ..Default::default()
            })
        });
        Ok(Box::pin(futures::stream::iter(chunks)))
    }
}

#[tokio::test]
async fn cost_probe_keeps_failed_calls_and_replaces_cumulative_snapshots_before_yield() {
    let model = ProbeModel::new(Arc::new(CostFixture(false)), Duration::ZERO);
    let mut stream = model
        .generate_content(LlmRequest::new("test", vec![]), true)
        .await
        .unwrap();
    stream.next().await.unwrap().unwrap();
    assert_eq!(model.calls.lock().unwrap()[0]["usage"]["totalTokens"], 10);
    stream.next().await.unwrap().unwrap();
    assert_eq!(model.calls.lock().unwrap()[0]["usage"]["totalTokens"], 12);
    drop(stream);
    assert_eq!(model.calls.lock().unwrap().len(), 1);
    assert_eq!(model.calls.lock().unwrap()[0]["status"], "started");

    let failed = ProbeModel::new(Arc::new(CostFixture(true)), Duration::ZERO);
    assert!(
        failed
            .generate_content(LlmRequest::new("test", vec![]), true)
            .await
            .is_err()
    );
    let calls = failed.calls.lock().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0]["status"], "dispatch_failed");
    assert!(calls[0]["usage"].is_null());
}
fn grade(case: &Case, intent: Option<Intent>, reply: &AssistantReply) -> Checks {
    let workflow_id = reply.call.as_ref().map(|call| call.workflow_id.as_str());
    let routing = match case.expected.routing {
        Routing::None => reply.call.is_none(),
        Routing::Required => workflow_id == case.expected.workflow_id.as_deref() && reply.call.is_some(),
        // Missing business input must produce a user-facing clarification,
        // not an executable proposal carrying missing or empty placeholders.
        Routing::Clarify => reply.call.is_none() && !reply.text.trim().is_empty(),
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
    usage: Arc<Mutex<Vec<Value>>>,
    intents: Arc<Mutex<Vec<Intent>>>,
    tool_names: Arc<Mutex<Vec<String>>>,
    last_request: tokio::sync::Mutex<Option<tokio::time::Instant>>,
    interval: Duration,
    calls: Arc<Mutex<Vec<Value>>>,
    delivery: std::sync::atomic::AtomicBool,
}
impl ProbeModel {
    pub(super) fn costs_since(&self, first: usize) -> Value {
        let calls = self.calls.lock().unwrap()[first..].to_vec();
        let mut phases = serde_json::Map::new();
        for phase in [
            "intent",
            "conversation",
            "planning",
            "authoring",
            "delivery",
            "unclassified",
        ] {
            let selected = calls.iter().filter(|call| call["phase"] == phase).collect::<Vec<_>>();
            if selected.is_empty() {
                continue;
            }
            let missing = selected.iter().filter(|call| call["usage"].is_null()).count();
            let mut totals = json!({});
            for key in ["inputTokens", "outputTokens", "totalTokens"] {
                totals[key] = json!(
                    selected
                        .iter()
                        .filter_map(|call| call["usage"][key].as_u64())
                        .sum::<u64>()
                );
            }
            phases.insert(
                phase.into(),
                json!({"callCount":selected.len(),
                "missingUsageCalls":missing,"usageComplete":missing == 0,"knownTokens":totals}),
            );
        }
        json!({"callCount":calls.len(),
            "missingUsageCalls":calls.iter().filter(|call|call["usage"].is_null()).count(),
            "phases":phases,"calls":calls,"executionIncluded":false})
    }
    pub(super) fn set_delivery(&self, delivery: bool) {
        self.delivery.store(delivery, std::sync::atomic::Ordering::Relaxed);
    }
    pub(super) fn usage(&self) -> Vec<Value> {
        self.usage.lock().unwrap().clone()
    }
    pub(super) fn called_tools(&self) -> Vec<String> {
        self.tool_names.lock().unwrap().clone()
    }
    pub(super) fn last_intent(&self) -> Option<Intent> {
        self.intents.lock().unwrap().last().copied()
    }
    pub(super) fn new(inner: Arc<dyn Llm>, interval: Duration) -> Self {
        Self {
            inner,
            usage: Arc::new(Mutex::new(vec![])),
            intents: Arc::new(Mutex::new(vec![])),
            tool_names: Arc::new(Mutex::new(vec![])),
            last_request: tokio::sync::Mutex::new(None),
            interval,
            calls: Arc::new(Mutex::new(vec![])),
            delivery: false.into(),
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
        let purpose = crate::module::model_usage::current().purpose;
        let phase = if is_intent {
            "intent"
        } else if matches!(purpose.as_str(), "planning" | "authoring") {
            purpose.as_str()
        } else if self.delivery.load(std::sync::atomic::Ordering::Relaxed) {
            "delivery"
        } else if purpose == "conversation" {
            "conversation"
        } else {
            "unclassified"
        };
        let call_index = {
            let mut calls = self.calls.lock().unwrap();
            let index = calls.len();
            calls.push(json!({"phase":phase,
                "contentsChars":serde_json::to_string(&request.contents).unwrap().chars().count(),
                "toolsChars":serde_json::to_string(&request.tools).unwrap().chars().count(),
                "configHash":tool_execution::digest(&request.config).unwrap(),
                "status":"started","usage":null}));
            index
        };
        let mut source = match self.inner.generate_content(request, stream).await {
            Ok(source) => source,
            Err(error) => {
                self.calls.lock().unwrap()[call_index]["status"] = json!("dispatch_failed");
                return Err(error);
            },
        };
        let calls = self.calls.clone();
        let usage = self.usage.clone();
        let intents = self.intents.clone();
        let tool_names = self.tool_names.clone();
        Ok(Box::pin(async_stream::stream! {
            let mut probe = ReplyStream::new();
            let mut last_usage = None;
            while let Some(response) = source.next().await {
                if let Ok(response) = &response && let Some(value) = &response.usage_metadata {
                    // Streamed usage is cumulative; count only the final snapshot per request.
                    last_usage = Some(json!({"inputTokens":value.prompt_token_count,"outputTokens":value.candidates_token_count,"totalTokens":value.total_token_count}));
                    // Store before yielding: a caller can stop at a tool call.
                    calls.lock().unwrap()[call_index]["usage"] = last_usage.clone().unwrap();
                }
                if response.is_err() { calls.lock().unwrap()[call_index]["status"] = json!("stream_error"); }
                if let Ok(response)=&response && let Some(content)=&response.content {
                    for part in &content.parts {if let Part::FunctionCall{name,..}=part {tool_names.lock().unwrap().push(name.clone());}}
                }
                if is_intent && let Ok(response) = &response {
                    let _ = probe.push(response.clone());
                }
                yield response;
            }
            if let Some(value) = last_usage { usage.lock().unwrap().push(value); }
            let mut records = calls.lock().unwrap();
            if records[call_index]["status"] == "started" { records[call_index]["status"] = json!("finished"); }
            drop(records);
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
    model.set_delivery(false);
    let discovery = Catalog(capabilities);
    let first_call = model.calls.lock().unwrap().len();
    let started = std::time::Instant::now();
    let first_intent = model.intents.lock().unwrap().len();
    let reply = runtime
        .run_with_discovery(
            model,
            &ModelProvider::Gemini,
            AssistantRequest {
                context: Default::default(),
                contents: case.messages.clone(),
                capabilities: vec![],
            },
            &|_| Ok(()),
            &discovery,
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
        cost: Value::Null,
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
            result.checks = grade(case, intent, &reply);
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
                    model.set_delivery(true);
                    match runtime
                        .run_with_discovery(
                            model,
                            &ModelProvider::Gemini,
                            AssistantRequest {
                                context: Default::default(),
                                contents,
                                capabilities: vec![],
                            },
                            &|_| Ok(()),
                            &discovery,
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
    result.cost = model.costs_since(first_call);
    result.cost["wallTimeMs"] = json!(started.elapsed().as_millis());
    model.set_delivery(false);
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
    json!({"version":2,"runtimePath":"native_discovery","executionIncluded":false,"createdAt":chrono::Utc::now().to_rfc3339(),"model":model,"selected":selected,"attempted":results.len(),"completed":results.iter().filter(|result|!result.infrastructure_error).count(),"passed":passed,"providerErrors":results.iter().filter(|result| result.infrastructure_error).count(),"status":if !complete {"incomplete"} else if passed == selected {"passed"} else {"failed"},"complete":complete,"metrics":metrics,"cases":results})
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
    let correct = grade(case, Some(Intent::Task), &reply("sales-report", "this_week"));
    assert!(correct.passed());
    let incorrect = grade(case, Some(Intent::Conversation), &reply("invoice-summary", "last_week"));
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
fn grader_requires_clarification_instead_of_dispatching_missing_or_invented_inputs() {
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
    let mut clarified = reply(json!({}));
    clarified.call = None;
    clarified.text = "请提供报表周期。".into();
    assert!(grade(case, Some(Intent::Task), &clarified).passed());
    let files = suite.cases.iter().find(|c| c.id == "missing-files").unwrap();
    let mut empty_files = reply(json!({"files":[]}));
    empty_files.call.as_mut().unwrap().workflow_id = "invoice-summary".into();
    assert_eq!(grade(files, Some(Intent::Task), &empty_files).routing, Some(false));
    assert_eq!(grade(case, Some(Intent::Task), &reply(json!({}))).routing, Some(false));
    assert_eq!(
        grade(case, Some(Intent::Task), &reply(json!({"period":"this_week"}))).routing,
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
        cost: Value::Null,
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

#[tokio::test]
async fn native_evaluation_discovers_exact_contract_and_delivers_success_and_failure_without_rerun() {
    let suite = baseline();
    for id in ["receipt-delivery", "failed-receipt"] {
        let case = suite.cases.iter().find(|case| case.id == id).unwrap();
        let (input, quote, value) = if id == "receipt-delivery" {
            ("amount", "1500", "1500")
        } else {
            ("period", "本周", "\"this_week\"")
        };
        let target = case.expected.workflow_id.as_ref().unwrap();
        let scripted = Arc::new(tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":"task",
                "actionQuote":content_text(case.messages.last().unwrap()),
                "summary":"完成当前任务","reuseExisting":false,"authoringQuote":""})
                .to_string(),
            ),
            tests::call("list_capabilities", json!({"query":"unmatched literal query"})),
            tests::call("list_capabilities", json!({"capability_id":target})),
            tests::call(
                "execute_capability",
                json!({"capability_id":target,
                "bindings":[{"input":input,"source":"message","message":0,"quote":quote,"value_json":value}]}),
            ),
            Content::new("model").with_text(if id == "receipt-delivery" {
                "需要人工审核。"
            } else {
                "执行失败：销售数据不可用。"
            }),
        ]));
        let model = ProbeModel::new(scripted.clone(), Duration::ZERO);
        let result = evaluate_case(&tests::runtime(), &model, case, &suite.capabilities).await;
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(
            result.checks.passed(),
            "{}",
            serde_json::to_string(&result.checks).unwrap()
        );
        assert_eq!(result.cost["phases"]["intent"]["callCount"], 1);
        assert_eq!(result.cost["phases"]["conversation"]["callCount"], 3);
        assert_eq!(result.cost["phases"]["delivery"]["callCount"], 1);
        assert_eq!(
            model
                .called_tools()
                .iter()
                .filter(|name| *name == "execute_capability")
                .count(),
            1
        );
        let requests = scripted.requests.lock().unwrap();
        // These tools were removed by the old no-discovery evaluator entry.
        assert!(requests[1].tools.contains_key("inspect_operations"));
        assert!(
            requests[2]
                .contents
                .iter()
                .any(|c| content_text(c).contains("searchFallback")
                    || serde_json::to_string(c).unwrap().contains("searchFallback"))
        );
        assert!(
            requests[3]
                .contents
                .iter()
                .any(|c| serde_json::to_string(c).unwrap().contains("inputSchema"))
        );
    }
}

#[tokio::test]
async fn phase_costs_keep_known_usage_and_failed_unknown_calls_separate() {
    let model = ProbeModel::new(Arc::new(CostFixture(false)), Duration::ZERO);
    for phase in ["planning", "authoring", "conversation"] {
        crate::module::model_usage::purpose(phase, async {
            let mut stream = model
                .generate_content(LlmRequest::new("test", vec![]), true)
                .await
                .unwrap();
            while stream.next().await.is_some() {}
        })
        .await;
    }
    model.set_delivery(true);
    let mut stream = model
        .generate_content(LlmRequest::new("test", vec![]), true)
        .await
        .unwrap();
    while stream.next().await.is_some() {}
    for phase in ["planning", "authoring", "conversation", "delivery"] {
        let cost = model.costs_since(0);
        assert_eq!(cost["phases"][phase]["knownTokens"]["totalTokens"], 12);
        assert_eq!(cost["phases"][phase]["usageComplete"], true);
    }
    let failed = ProbeModel::new(Arc::new(CostFixture(true)), Duration::ZERO);
    assert!(
        failed
            .generate_content(LlmRequest::new("test", vec![]), true)
            .await
            .is_err()
    );
    let cost = failed.costs_since(0);
    assert_eq!(cost["phases"]["unclassified"]["usageComplete"], false);
    assert_eq!(cost["missingUsageCalls"], 1);
    assert_eq!(cost["calls"][0]["status"], "dispatch_failed");
    assert_eq!(cost["executionIncluded"], false);
    assert_eq!(model.costs_since(3)["callCount"], 1);
}

/// Controlled prompt-text comparison only: historical runtime behavior and
/// provider tokenization cannot be reconstructed from instruction snapshots.
#[tokio::test]
#[ignore = "requires explicit earlier prompt resources; local only, no provider calls"]
async fn local_cross_task_prompt_comparison() {
    let root = std::path::PathBuf::from(
        std::env::var_os("WORKRUN_ASSISTANT_BASELINE_DIR").expect("Explicit baseline required"),
    );
    let paths = [
        "main_agent/INTENT.md",
        "main_agent/AGENT.md",
        "main_agent/skills/capability-orchestration.md",
    ];
    let replacements = paths
        .iter()
        .map(|path| {
            (
                resources::read(path).unwrap(),
                std::fs::read_to_string(root.join(path)).expect("Incomplete prompt baseline"),
            )
        })
        .collect::<Vec<_>>();
    let suite = baseline();
    let mut cases = vec![];
    for case in &suite.cases {
        let intent = case.expected.intents[0];
        let quote = content_text(case.messages.last().unwrap());
        let scripted = tests::ScriptedModel::new(vec![
            Content::new("model").with_text(
                json!({"intent":intent,
                "actionQuote":if matches!(intent, Intent::Task | Intent::Execution) { &quote } else { "" },
                "summary":"本地请求体积检查","reuseExisting":intent == Intent::Execution,
                "authoringQuote":""})
                .to_string(),
            ),
            Content::new("model").with_text("Local probe complete."),
        ]);
        tests::runtime()
            .run_with_discovery(
                &scripted,
                &ModelProvider::Gemini,
                AssistantRequest {
                    context: Default::default(),
                    contents: case.messages.clone(),
                    capabilities: vec![],
                },
                &|_| Ok(()),
                &Catalog(&suite.capabilities),
            )
            .await
            .unwrap();
        let requests = scripted.requests.lock().unwrap();
        assert_eq!(requests.len(), 2, "{}", case.id);
        let mut phases = vec![];
        for (index, request) in requests.iter().enumerate() {
            let after = json!({"contents":request.contents,"tools":request.tools,"config":request.config});
            let mut before = after.clone();
            let mut replaced = 0;
            // Replace only the instruction preamble, never a matching phrase in
            // user messages, signed calls or receipts. All other inputs stay fixed.
            for part in before["contents"][0]["parts"].as_array_mut().unwrap() {
                if let Some(text) = part["text"].as_str() {
                    let mut text = text.to_owned();
                    for (current, prior) in &replacements {
                        if text.contains(current) {
                            replaced += 1;
                            text = text.replace(current, prior);
                        }
                    }
                    part["text"] = json!(text);
                }
            }
            assert!(replaced > 0, "No instructions replaced for {} request {index}", case.id);
            assert_eq!(before["tools"], after["tools"]);
            assert_eq!(before["config"], after["config"]);
            assert_eq!(
                &before["contents"].as_array().unwrap()[1..],
                &after["contents"].as_array().unwrap()[1..]
            );
            phases.push(json!({"phase":if index == 0 {"intent"} else {"conversation"},
                "replacedResources":replaced,"beforeChars":before.to_string().chars().count(),
                "afterChars":after.to_string().chars().count()}));
        }
        cases.push(json!({"id":case.id,"category":case.category,"requests":phases}));
    }
    let fingerprints = paths
        .iter()
        .zip(&replacements)
        .map(|(path, (current, prior))| {
            json!({"path":path,"beforeHash":tool_execution::digest(prior).unwrap(),
            "afterHash":tool_execution::digest(current).unwrap()})
        })
        .collect::<Vec<_>>();
    let report = json!({"scope":"prompt_text_only","provider":"gemini","resources":fingerprints,
        "baselineDirectory":root,"caseCount":cases.len(),"cases":cases,
        "providerCalls":0,"tokenSavingsMeasured":false,"runtimeBehaviorCompared":false,
        "unchangedResourcesNotCompared":true});
    let path = std::env::var_os("WORKRUN_ASSISTANT_BUDGET_OUTPUT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("workrun-cross-task-prompt-comparison.json"));
    std::fs::write(&path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    eprintln!("Local prompt comparison: {}", path.display());
}
