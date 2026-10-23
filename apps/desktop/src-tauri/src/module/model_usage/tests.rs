use super::*;
use adk_rust::{Content, LlmResponse};

struct Model(Vec<LlmResponse>);
#[async_trait::async_trait]
impl Llm for Model {
    fn name(&self) -> &str {
        "test"
    }
    async fn generate_content(&self, _: LlmRequest, _: bool) -> adk_rust::Result<LlmResponseStream> {
        Ok(Box::pin(futures::stream::iter(self.0.clone().into_iter().map(Ok))))
    }
}

async fn database() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("CREATE TABLE model_calls(id TEXT PRIMARY KEY,workspace_id TEXT,session_kind TEXT,session_id TEXT,run_id TEXT,started_at TEXT,status TEXT,record_json TEXT)").execute(&pool).await.unwrap();
    sqlx::query("CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,workspace_id TEXT,session_json TEXT)")
        .execute(&pool)
        .await
        .unwrap();
    pool
}
async fn snapshot(pool: &SqlitePool, writer: &Writer, workspace: &str, kind: &str, id: &str) -> anyhow::Result<Value> {
    assert!(writer.flush(std::time::Duration::from_secs(2)).await);
    session_usage(pool, workspace, kind, id).await
}
fn context() -> CallContext {
    CallContext {
        workspace_id: "personal".into(),
        session_kind: Some("assistant".into()),
        session_id: Some("session".into()),
        purpose: "conversation".into(),
        ..Default::default()
    }
}
fn chunk(input: i32, output: i32, partial: bool) -> LlmResponse {
    LlmResponse {
        partial,
        content: Some(Content::new("model").with_text("ok")),
        usage_metadata: Some(UsageMetadata {
            prompt_token_count: input,
            candidates_token_count: output,
            total_token_count: input + output,
            ..Default::default()
        }),
        ..Default::default()
    }
}
#[tokio::test]
async fn cumulative_snapshots_are_replaced_and_workspace_isolation_is_preserved() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![chunk(10, 2, true), chunk(10, 5, false)]);
    let (_, mut stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![]),
        true,
        context(),
        Some(writer.clone()),
    )
    .await
    .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["conversation"]["totalTokens"], 15);
    assert_eq!(result["byPurpose"][0]["purpose"], "conversation");
    assert_eq!(result["byPurpose"][0]["totalTokens"], 15);
    assert_eq!(result["conversation"]["calls"], 1);
    assert_eq!(result["conversation"]["missingUsageCalls"], 0);
    assert!(
        snapshot(&pool, &writer, "other", "assistant", "session").await.unwrap()["calls"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
#[tokio::test]
async fn usage_only_tail_is_observed_and_execution_is_counted_once() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![
        LlmResponse {
            content: Some(Content::new("model").with_text("ok")),
            partial: true,
            ..Default::default()
        },
        LlmResponse {
            content: None,
            ..chunk(20, 3, false)
        },
    ]);
    let mut c = context();
    c.run_id = Some("run".into());
    let (_, mut stream) = observe_with_writer(&model, LlmRequest::new("test", vec![]), true, c, Some(writer.clone()))
        .await
        .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["execution"]["totalTokens"], 23);
    assert_eq!(result["conversation"]["totalTokens"], 0);
}
#[tokio::test]
async fn dropped_stream_retains_unknown_usage_and_closes_the_durable_call() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![chunk(10, 1, true), chunk(10, 8, false)]);
    let (_, stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![]),
        true,
        context(),
        Some(writer.clone()),
    )
    .await
    .unwrap();
    drop(stream);
    for _ in 0..30 {
        let result = snapshot(&pool, &writer, "personal", "assistant", "session")
            .await
            .unwrap();
        if result["calls"][0]["status"] == "interrupted" {
            assert!(result["calls"][0]["usage"].is_null());
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("dropped call was not persisted");
}
#[tokio::test]
async fn concurrent_roles_do_not_leak_context() {
    let make = |name: &str| {
        let mut c = context();
        c.purpose = name.into();
        c
    };
    let (a, b) = tokio::join!(
        scope(make("planning"), async {
            tokio::task::yield_now().await;
            current()
        }),
        scope(make("intent"), async {
            tokio::task::yield_now().await;
            current()
        })
    );
    assert_eq!(a.purpose, "planning");
    assert_eq!(b.purpose, "intent");
}

#[tokio::test]
async fn terminal_tool_call_is_enqueued_before_consumer_stops_polling() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![chunk(10, 3, false)]);
    let (_, mut stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![]),
        true,
        context(),
        Some(writer.clone()),
    )
    .await
    .unwrap();
    stream.next().await.unwrap().unwrap();
    drop(stream);
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["calls"][0]["status"], "completed");
    assert_eq!(result["conversation"]["totalTokens"], 13);
}

struct FailingModel;
#[async_trait::async_trait]
impl Llm for FailingModel {
    fn name(&self) -> &str {
        "failed"
    }
    async fn generate_content(&self, _: LlmRequest, _: bool) -> adk_rust::Result<LlmResponseStream> {
        Err(adk_rust::AdkError::agent("connection failed"))
    }
}
#[tokio::test]
async fn dispatch_failure_is_a_call_with_unknown_usage_and_each_retry_is_independent() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    for _ in 0..2 {
        assert!(
            observe_with_writer(
                &FailingModel,
                LlmRequest::new("test", vec![]),
                false,
                context(),
                Some(writer.clone())
            )
            .await
            .is_err()
        );
    }
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["conversation"]["calls"], 2);
    assert_eq!(result["conversation"]["missingUsageCalls"], 2);
    assert!(
        result["calls"]
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["status"] == "failed" && r["usage"].is_null())
    );
}

#[tokio::test]
async fn native_receipts_link_historical_execution_without_double_counting() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    sqlx::query("INSERT INTO assistant_sessions VALUES ('session','personal',?)")
        .bind(json!({"messages":[{"runId":"run"},{"runId":"run"}],"activeCall":{"runId":"run"}}).to_string())
        .execute(&pool)
        .await
        .unwrap();
    let model = Model(vec![chunk(10, 2, false)]);
    let mut c = context();
    c.run_id = Some("run".into());
    let (_, mut stream) = observe_with_writer(&model, LlmRequest::new("test", vec![]), false, c, Some(writer.clone()))
        .await
        .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["execution"]["calls"], 1);
    assert_eq!(result["execution"]["totalTokens"], 12);
    // Simulate an imported run that predates origin metadata.
    sqlx::query("UPDATE model_calls SET session_kind=NULL,session_id=NULL")
        .execute(&pool)
        .await
        .unwrap();
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["execution"]["totalTokens"], 12);
    assert!(
        snapshot(&pool, &writer, "team:other", "assistant", "session")
            .await
            .unwrap()["calls"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn request_diagnostics_never_persist_prompt_or_tool_bodies() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![chunk(1, 1, false)]);
    let request = LlmRequest::new(
        "test",
        vec![Content::new("system").with_text("private-prompt-do-not-store")],
    );
    let (_, mut stream) = observe_with_writer(&model, request, false, context(), Some(writer.clone()))
        .await
        .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert!(!result.to_string().contains("private-prompt-do-not-store"));
    assert!(result["calls"][0]["requestSize"]["systemChars"].as_u64().unwrap() > 0);
    assert_eq!(result["calls"][0]["configHash"].as_str().unwrap().len(), 64);
}

#[tokio::test]
async fn unavailable_database_never_changes_model_success_or_provider_errors() {
    let pool = database().await;
    sqlx::query("DROP TABLE model_calls").execute(&pool).await.unwrap();
    let writer = Writer::new(pool);
    let model = Model(vec![chunk(10, 3, false)]);
    let (_, mut stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![]),
        true,
        context(),
        Some(writer.clone()),
    )
    .await
    .expect("recording must not gate dispatch");
    let response = stream.next().await.unwrap().unwrap();
    assert_eq!(response.usage_metadata.unwrap().total_token_count, 13);
    assert!(stream.next().await.is_none());
    let error = observe_with_writer(
        &FailingModel,
        LlmRequest::new("test", vec![]),
        false,
        context(),
        Some(writer.clone()),
    )
    .await
    .err()
    .unwrap();
    assert!(error.to_string().contains("connection failed"));
    assert!(writer.flush(std::time::Duration::from_secs(2)).await);
    assert!(writer.degraded());
}

#[tokio::test]
async fn busy_database_does_not_delay_dispatch_or_stream_delivery() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let connection = pool.acquire().await.unwrap();
    let model = Model(vec![chunk(10, 3, false)]);
    tokio::time::timeout(std::time::Duration::from_millis(100), async {
        let (_, mut stream) = observe_with_writer(
            &model,
            LlmRequest::new("test", vec![]),
            true,
            context(),
            Some(writer.clone()),
        )
        .await
        .unwrap();
        assert_eq!(
            stream
                .next()
                .await
                .unwrap()
                .unwrap()
                .usage_metadata
                .unwrap()
                .total_token_count,
            13
        );
        assert!(stream.next().await.is_none());
    })
    .await
    .expect("model response must not wait for a database connection");
    drop(connection);
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["calls"][0]["status"], "completed");
    assert_eq!(result["conversation"]["totalTokens"], 13);
    assert!(!writer.degraded());
}

#[tokio::test]
async fn delayed_older_snapshot_cannot_overwrite_a_final_record() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let final_record = json!({"id":"call", "context":context(), "startedAt":"now", "revision":3,
        "status":"completed", "usage":{"totalTokens":15}});
    let mut old_record = final_record.clone();
    old_record["revision"] = json!(1);
    old_record["status"] = json!("running");
    old_record["usage"] = Value::Null;
    writer.record(final_record);
    writer.record(old_record);
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    assert_eq!(result["calls"][0]["status"], "completed");
    assert_eq!(result["conversation"]["totalTokens"], 15);
}

#[tokio::test]
async fn diagnostics_preserve_tool_action_through_usage_tail_without_storing_bodies() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let tool: Content = serde_json::from_value(json!({"role":"model","parts":[
        {"name":"lookup","args":{"secret":"do not store"},"id":"call-1","thought_signature":"signed"}
    ]}))
    .unwrap();
    let reply: Content = serde_json::from_value(json!({"role":"function","parts":[
        {"functionResponse":{"name":"lookup","response":{"secret":"private result"}},"id":"prior"}
    ]}))
    .unwrap();
    let model = Model(vec![
        LlmResponse {
            content: Some(tool),
            partial: false,
            ..Default::default()
        },
        LlmResponse {
            content: None,
            ..chunk(20, 3, false)
        },
    ]);
    let mut ctx = context();
    ctx.turn_id = Some("turn-1".into());
    let (_, mut stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![reply]),
        true,
        ctx,
        Some(writer.clone()),
    )
    .await
    .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    let call = &result["calls"][0];
    assert_eq!(call["responseKind"], "tool_call");
    assert_eq!(call["requestedTools"], json!(["lookup"]));
    assert_eq!(call["requestSize"]["largestToolResults"][0]["name"], "lookup");
    assert_eq!(call["requestSize"]["largestToolResults"][0]["responses"], 1);
    assert!(!result.to_string().contains("private result"));
    assert!(!result.to_string().contains("do not store"));
    assert!(!result.to_string().contains("signed"));
    assert_eq!(result["byTurn"][0]["turnId"], "turn-1");
    assert_eq!(result["byTurn"][0]["conversationTokens"], 23);
}

#[tokio::test]
async fn turn_totals_separate_execution_and_keep_unattributed_and_failed_calls() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    for (turn, run, purpose, failed) in [
        (Some("a"), None, "conversation", false),
        (Some("a"), Some("run"), "workflow", false),
        (Some("b"), None, "planning", true),
        (None, None, "summary", false),
    ] {
        let mut ctx = context();
        ctx.turn_id = turn.map(str::to_owned);
        ctx.run_id = run.map(str::to_owned);
        ctx.purpose = purpose.into();
        let response = if failed {
            LlmResponse {
                error_code: Some("test".into()),
                ..chunk(10, 2, false)
            }
        } else {
            chunk(10, 2, false)
        };
        let (_, mut stream) = observe_with_writer(
            &Model(vec![response]),
            LlmRequest::new("test", vec![]),
            true,
            ctx,
            Some(writer.clone()),
        )
        .await
        .unwrap();
        while stream.next().await.is_some() {}
    }
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    let turns = result["byTurn"].as_array().unwrap();
    let a = turns.iter().find(|t| t["turnId"] == "a").unwrap();
    assert_eq!(a["calls"], 2);
    assert_eq!(a["conversationTokens"], 12);
    assert_eq!(a["executionTokens"], 12);
    assert_eq!(turns.iter().find(|t| t["turnId"] == "b").unwrap()["unfinishedCalls"], 1);
    assert_eq!(
        turns.iter().find(|t| t["turnId"].is_null()).unwrap()["conversationTokens"],
        12
    );
    assert_eq!(
        turns
            .iter()
            .map(|t| t["conversationTokens"].as_i64().unwrap() + t["executionTokens"].as_i64().unwrap())
            .sum::<i64>(),
        48
    );
}

#[tokio::test]
async fn response_timings_reuse_the_original_call_and_usage() {
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let model = Model(vec![chunk(10, 2, true), chunk(10, 5, false)]);
    let (_, mut stream) = observe_with_writer(
        &model,
        LlmRequest::new("test", vec![]),
        true,
        context(),
        Some(writer.clone()),
    )
    .await
    .unwrap();
    while stream.next().await.is_some() {}
    let result = snapshot(&pool, &writer, "personal", "assistant", "session")
        .await
        .unwrap();
    let calls = result["calls"].as_array().unwrap();
    assert_eq!(calls.len(), 1);
    assert_eq!(result["conversation"]["totalTokens"], 15);
    let call = &calls[0];
    assert_eq!(call["streaming"], true);
    let dispatch = call["dispatchDurationMs"].as_i64().unwrap();
    let first = call["firstResponseMs"].as_i64().unwrap();
    let total = call["durationMs"].as_i64().unwrap();
    assert!(dispatch <= first && first <= total);
}

#[tokio::test]
async fn fingerprints_compare_origins_and_detect_request_changes_without_changing_requests() {
    use std::sync::{Arc, Mutex};
    struct Capture(Arc<Mutex<Vec<(Value, bool)>>>);
    #[async_trait::async_trait]
    impl Llm for Capture {
        fn name(&self) -> &str {
            "test"
        }
        async fn generate_content(&self, request: LlmRequest, streaming: bool) -> adk_rust::Result<LlmResponseStream> {
            let value = json!({"request": request, "tools": request.tools});
            self.0.lock().unwrap().push((value, streaming));
            Ok(Box::pin(futures::stream::iter([Ok(chunk(10, 5, false))])))
        }
    }
    let pool = database().await;
    let writer = Writer::new(pool.clone());
    let captured = Arc::new(Mutex::new(Vec::new()));
    let model = Capture(captured.clone());
    let base = LlmRequest::new("test", vec![Content::new("user").with_text("private-input-AB")]);
    let mut inputs = vec![base.clone(), base.clone(), base.clone(), base.clone(), base.clone()];
    inputs.push(base.clone());
    inputs[5].config = Some(adk_rust::GenerateContentConfig {
        temperature: Some(0.2),
        ..Default::default()
    });
    inputs[2].contents = vec![Content::new("user").with_text("private-input-CD")];
    inputs[4]
        .tools
        .insert("lookup".into(), json!({"name":"lookup","parameters":{"type":"object"}}));
    let mut hashes = Vec::new();
    for (index, request) in inputs.into_iter().enumerate() {
        let expected = json!({"request": &request, "tools": &request.tools});
        let mut origin = context();
        if index == 1 {
            origin.session_kind = None;
            origin.session_id = None;
        }
        let streaming = index == 3;
        let (id, mut responses) = observe_with_writer(&model, request, streaming, origin, Some(writer.clone()))
            .await
            .unwrap();
        while responses.next().await.is_some() {}
        assert!(writer.flush(std::time::Duration::from_secs(2)).await);
        assert_eq!(captured.lock().unwrap()[index], (expected, streaming));
        let text: String = sqlx::query_scalar("SELECT record_json FROM model_calls WHERE id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!text.contains("private-input"));
        let record: Value = serde_json::from_str(&text).unwrap();
        hashes.push(record["requestHash"].as_str().unwrap().to_string());
    }
    assert_eq!(
        hashes[0], hashes[1],
        "diagnostic conversation origin does not change provider requests"
    );
    for index in 2..6 {
        assert_ne!(hashes[0], hashes[index]);
    }
    assert_eq!(
        captured.lock().unwrap().len(),
        6,
        "exactly one provider call per invocation"
    );
}
