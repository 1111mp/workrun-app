//! A local ledger at the real provider boundary, shared by all agent roles.
use adk_rust::{Llm, LlmRequest, LlmResponseStream, Part, UsageMetadata};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{Row, SqlitePool};
use std::{future::Future, time::Instant};

mod writer;
use writer::Writer;
pub use writer::flush;

#[derive(Clone, Default, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CallContext {
    pub workspace_id: String,
    pub session_kind: Option<String>,
    pub session_id: Option<String>,
    pub turn_id: Option<String>,
    pub phase_id: Option<String>,
    pub run_id: Option<String>,
    pub node_id: Option<String>,
    pub operation_id: Option<String>,
    pub purpose: String,
    pub provider: Option<String>,
    pub model_profile_id: Option<String>,
    pub recipe_hash: Option<String>,
    pub workflow_path: Vec<String>,
}

tokio::task_local! { static CONTEXT: CallContext; }

pub fn current() -> CallContext {
    CONTEXT.try_with(Clone::clone).unwrap_or_else(|_| CallContext {
        workspace_id: crate::utils::dirs::active_workspace_id(),
        purpose: "unclassified".into(),
        ..Default::default()
    })
}

pub async fn scope<T>(context: CallContext, future: impl Future<Output = T>) -> T {
    CONTEXT.scope(context, future).await
}

pub async fn purpose<T>(purpose: &str, future: impl Future<Output = T>) -> T {
    let mut context = current();
    context.purpose = purpose.into();
    scope(context, future).await
}

// ADK UsageMetadata normalizes provider usage to per-request cumulative snapshots.
// Replace the last snapshot: summing streamed snapshots would bill the same tokens twice.
fn usage(value: &UsageMetadata) -> Value {
    let input = i64::from(value.prompt_token_count.max(0));
    let output = i64::from(value.candidates_token_count.max(0));
    let total = i64::from(value.total_token_count.max(0));
    json!({
        "inputTokens": input, "outputTokens": output,
        "totalTokens": if total > 0 { total } else { input.saturating_add(output) },
        "totalTokensEstimated": total == 0 && input.saturating_add(output) > 0,
        "cacheReadTokens": value.cache_read_input_token_count.map(|n| n.max(0)),
        "cacheWriteTokens": value.cache_creation_input_token_count.map(|n| n.max(0)),
        "reasoningTokens": value.thinking_token_count.map(|n| n.max(0)),
        "audioInputTokens": value.audio_input_token_count.map(|n| n.max(0)),
        "audioOutputTokens": value.audio_output_token_count.map(|n| n.max(0)),
        "isByok": value.is_byok,
        "estimatedCostMicrousd": value.cost.filter(|n| n.is_finite() && *n >= 0.0).map(|n| (n * 1_000_000.0).round() as i64),
    })
}

struct Call {
    writer: Option<Writer>,
    record: Value,
    elapsed: Instant,
    finished: bool,
}

impl Call {
    fn enqueue(&mut self) {
        let revision = self.record["revision"].as_u64().unwrap_or(0) + 1;
        self.record["revision"] = json!(revision);
        if let Some(writer) = &self.writer {
            writer.record(self.record.clone());
        }
    }

    fn finish(&mut self, status: &str) {
        self.close(status);
        self.enqueue();
        self.finished = true;
    }

    fn close(&mut self, status: &str) {
        self.record["status"] = json!(status);
        self.record["endedAt"] = json!(chrono::Utc::now().to_rfc3339());
        self.record["durationMs"] = json!(self.elapsed.elapsed().as_millis().min(i64::MAX as u128) as i64);
    }
}

impl Drop for Call {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        // A dropped stream includes explicit cancellation and consumers ending
        // early. Never claim a successful request or zero usage in either case.
        self.close("interrupted");
        self.record["failureKind"] = json!("stream_dropped");
        self.enqueue();
    }
}

async fn persist(pool: &SqlitePool, record: &Value) -> anyhow::Result<()> {
    let c = &record["context"];
    sqlx::query("INSERT INTO model_calls (id,workspace_id,session_kind,session_id,run_id,started_at,status,record_json) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json WHERE COALESCE(json_extract(excluded.record_json, '$.revision'), 0) >= COALESCE(json_extract(model_calls.record_json, '$.revision'), 0)")
        .bind(record["id"].as_str()).bind(c["workspaceId"].as_str())
        .bind(c["sessionKind"].as_str()).bind(c["sessionId"].as_str())
        .bind(c["runId"].as_str()).bind(record["startedAt"].as_str())
        .bind(record["status"].as_str()).bind(record.to_string()).execute(pool).await?;
    Ok(())
}

pub async fn observe(
    model: &dyn Llm,
    request: LlmRequest,
    stream: bool,
    context: CallContext,
) -> adk_rust::Result<(String, LlmResponseStream)> {
    observe_with_writer(model, request, stream, context, writer::shared()).await
}

async fn observe_with_writer(
    model: &dyn Llm,
    request: LlmRequest,
    stream: bool,
    context: CallContext,
    writer: Option<Writer>,
) -> adk_rust::Result<(String, LlmResponseStream)> {
    let id = uuid::Uuid::new_v4().to_string();
    let contents_chars = serde_json::to_string(&request.contents)
        .map(|s| s.chars().count())
        .unwrap_or_default();
    let tools_chars = serde_json::to_string(&request.tools)
        .map(|s| s.chars().count())
        .unwrap_or_default();
    let chars_for = |role: &str| {
        request
            .contents
            .iter()
            .filter(|c| c.role == role)
            .filter_map(|c| serde_json::to_string(c).ok())
            .map(|s| s.chars().count())
            .sum::<usize>()
    };
    let instruction = request
        .contents
        .iter()
        .filter(|c| c.role == "system")
        .collect::<Vec<_>>();
    let config_hash = hex::encode(Sha256::digest(
        serde_json::to_vec(&json!({"instruction":instruction,"config":request.config,"tools":request.tools}))
            .unwrap_or_default(),
    ));
    // Hash only the SDK request and transport mode, excluding diagnostic origin.
    // This detects content/config changes without retaining prompts or file data;
    // it is not a fingerprint of adapter-generated HTTP headers or parameters.
    let mut fingerprint = json!({"request": &request, "tools": &request.tools, "streaming": stream});
    fingerprint.sort_all_objects();
    let request_hash = hex::encode(Sha256::digest(serde_json::to_vec(&fingerprint).unwrap_or_default()));
    // Attribute repeated context to tools without retaining arguments or bodies.
    let mut tool_results = std::collections::BTreeMap::<String, (usize, usize)>::new();
    for part in request.contents.iter().flat_map(|c| &c.parts) {
        if let Part::FunctionResponse { function_response, .. } = part {
            let entry = tool_results.entry(function_response.name.clone()).or_default();
            entry.0 += 1;
            entry.1 += serde_json::to_string(&function_response.response)
                .map(|text| text.chars().count())
                .unwrap_or_default();
        }
    }
    let mut tool_results = tool_results.into_iter().collect::<Vec<_>>();
    tool_results.sort_by(|a, b| b.1.1.cmp(&a.1.1).then(a.0.cmp(&b.0)));
    let largest_tool_results = tool_results.iter().take(20).map(|(name, (count, chars))| {
        json!({"name":name.chars().take(128).collect::<String>(),"responses":count,"chars":chars})
    }).collect::<Vec<_>>();
    let mut call = Call {
        writer,
        record: json!({
            "id": id, "context": context, "model": model.name(), "source": "provider",
            "startedAt": chrono::Utc::now().to_rfc3339(), "status": "running", "usage": null,
            "streaming": stream,
            "requestSize": {"contentsChars": contents_chars, "toolsChars": tools_chars, "messages": request.contents.len(), "systemChars": chars_for("system"), "toolResponseChars": chars_for("function") + chars_for("tool"),
                "largestToolResults":largest_tool_results,"toolResultKinds":tool_results.len()},
            "configHash": config_hash, "requestHash": request_hash,
        }),
        elapsed: Instant::now(),
        finished: false,
    };
    // Enqueue synchronously, but never await the database on the model path.
    call.enqueue();
    let source = match model.generate_content(request, stream).await {
        Ok(source) => {
            // Adapter readiness is not time to first token; non-streaming
            // adapters may have already waited for the complete response here.
            call.record["dispatchDurationMs"] = json!(call.elapsed.elapsed().as_millis().min(i64::MAX as u128) as i64);
            source
        },
        Err(error) => {
            call.record["failureKind"] = json!("dispatch");
            call.finish("failed");
            return Err(error);
        },
    };
    Ok((
        id,
        Box::pin(async_stream::stream! {
            let mut source = source;
            let mut terminal = false;
            let mut failed = false;
            while let Some(response) = source.next().await {
                match &response {
                    Ok(response) => {
                        if call.record.get("firstResponseMs").is_none() && response.content.as_ref().is_some_and(|c| !c.parts.is_empty()) {
                            call.record["firstResponseMs"] = json!(call.elapsed.elapsed().as_millis().min(i64::MAX as u128) as i64);
                        }
                        if let Some(value) = &response.usage_metadata { call.record["usage"] = usage(value); }
                        if let Some(reason) = &response.finish_reason {
                            call.record["finishReason"] = json!(reason);
                        }
                        if let Some(content) = &response.content {
                            let tools = content.parts.iter().filter_map(|part| match part {
                                Part::FunctionCall { name, .. } => Some(name.chars().take(128).collect::<String>()),
                                _ => None,
                            }).collect::<Vec<_>>();
                            // Usage-only tails must not overwrite the action that
                            // ended generation. This is model output, not task success.
                            if !tools.is_empty() {
                                call.record["responseKind"] = json!("tool_call");
                                call.record["requestedTools"] = json!(tools.into_iter().take(20).collect::<Vec<_>>());
                            } else if !content.parts.is_empty() && call.record["responseKind"] != "tool_call" {
                                call.record["responseKind"] = json!("content");
                            }
                        }
                        terminal |= !response.partial;
                        failed |= response.error_code.is_some() || response.error_message.is_some();
                        if response.interrupted { failed = true; }
                    },
                    Err(_) => failed = true,
                }
                if failed {
                    let interrupted = response.as_ref().is_ok_and(|r| r.interrupted);
                    call.record["failureKind"] = json!(if interrupted { "interrupted_response" } else { "provider_response" });
                    call.finish(if interrupted { "interrupted" } else { "failed" });
                    yield response;
                    return;
                }
                // Agents may stop polling immediately after a terminal tool call.
                // Enqueue before yielding; a later usage-only tail may refine the
                // same row without waiting for database IO here.
                if terminal { call.finish("completed"); }
                yield response;
            }
            call.finish(if terminal { "completed" } else { "interrupted" });
        }),
    ))
}

/// All numbers are known subtotals. Completeness is separate from request success.
pub async fn session_usage(pool: &SqlitePool, workspace: &str, kind: &str, id: &str) -> anyhow::Result<Value> {
    anyhow::ensure!(matches!(kind, "assistant" | "workflow_chat"), "Unknown session kind");
    // Native run receipts also link imported history. OR keeps a call unique
    // when both the new origin metadata and an old receipt identify the run.
    let rows = sqlx::query("SELECT record_json FROM model_calls WHERE workspace_id=? AND ((session_kind=? AND session_id=?) OR (?='assistant' AND run_id IN (SELECT json_extract(m.value, '$.runId') FROM assistant_sessions s, json_each(s.session_json, '$.messages') m WHERE s.workspace_id=? AND s.id=? UNION SELECT json_extract(session_json, '$.activeCall.runId') FROM assistant_sessions WHERE workspace_id=? AND id=?))) ORDER BY started_at,id")
        .bind(workspace).bind(kind).bind(id).bind(kind).bind(workspace).bind(id).bind(workspace).bind(id)
        .fetch_all(pool).await?;
    let calls = rows
        .into_iter()
        .map(|row| serde_json::from_str::<Value>(&row.get::<String, _>("record_json")))
        .collect::<Result<Vec<_>, _>>()?;
    let summarize = |execution: bool| {
        let selected = calls
            .iter()
            .filter(|r| r["context"]["runId"].is_string() == execution)
            .collect::<Vec<_>>();
        let missing = selected
            .iter()
            .filter(|r| r["usage"]["totalTokens"].as_i64().is_none())
            .count();
        let estimated = selected
            .iter()
            .filter(|r| r["usage"]["totalTokensEstimated"] == true)
            .count();
        let incomplete = selected.iter().filter(|r| r["status"] != "completed").count();
        let sum = |key: &str| {
            selected
                .iter()
                .filter_map(|r| r["usage"][key].as_i64())
                .fold(0i64, i64::saturating_add)
        };
        json!({"calls":selected.len(),"missingUsageCalls":missing,"unfinishedCalls":incomplete,"estimatedCalls":estimated,
            "inputTokens":sum("inputTokens"),"outputTokens":sum("outputTokens"),"totalTokens":sum("totalTokens"),
            "cacheReadTokens":sum("cacheReadTokens"),"reasoningTokens":sum("reasoningTokens")})
    };
    let purposes = calls
        .iter()
        .filter_map(|r| r["context"]["purpose"].as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let by_purpose = purposes.into_iter().map(|purpose| {
        let selected = calls.iter().filter(|r| r["context"]["purpose"] == purpose).collect::<Vec<_>>();
        json!({"purpose":purpose,"calls":selected.len(),
            "totalTokens":selected.iter().filter_map(|r|r["usage"]["totalTokens"].as_i64()).fold(0i64,i64::saturating_add),
            "missingUsageCalls":selected.iter().filter(|r|r["usage"]["totalTokens"].is_null()).count()})
    }).collect::<Vec<_>>();
    // Use the existing native turn identity; do not infer multi-turn tasks from
    // message text or present model completion as user-task success.
    let mut turns = std::collections::BTreeMap::<Option<&str>, Vec<&Value>>::new();
    for call in &calls {
        turns.entry(call["context"]["turnId"].as_str()).or_default().push(call);
    }
    let mut by_turn = turns
        .into_iter()
        .map(|(turn, selected)| {
            let tokens = |execution: bool| {
                selected
                    .iter()
                    .filter(|r| r["context"]["runId"].is_string() == execution)
                    .filter_map(|r| r["usage"]["totalTokens"].as_i64())
                    .fold(0i64, i64::saturating_add)
            };
            json!({"turnId":turn,"calls":selected.len(),
            "startedAt":selected.first().map(|r| &r["startedAt"]),
            "endedAt":selected.iter().filter_map(|r|r["endedAt"].as_str()).max(),
            "conversationTokens":tokens(false),"executionTokens":tokens(true),
            "modelDurationMs":selected.iter().filter_map(|r|r["durationMs"].as_i64()).fold(0i64,i64::saturating_add),
            "missingUsageCalls":selected.iter().filter(|r|r["usage"]["totalTokens"].is_null()).count(),
            "unfinishedCalls":selected.iter().filter(|r|r["status"]!="completed").count()})
        })
        .collect::<Vec<_>>();
    by_turn.sort_by(|a, b| a["startedAt"].as_str().cmp(&b["startedAt"].as_str()));
    Ok(
        json!({"conversation":summarize(false),"execution":summarize(true),"byPurpose":by_purpose,"byTurn":by_turn,"calls":calls,
        "recordingDegraded":writer::degraded(),
        "historicalCoverage":"Recorded calls only; asynchronous writes or missing history may leave gaps"}),
    )
}

#[cfg(test)]
mod tests;
