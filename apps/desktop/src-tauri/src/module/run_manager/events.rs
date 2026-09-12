use super::*;

pub(super) async fn publish_error(run_id: &str, error: &anyhow::Error) -> Result<()> {
    let message = error.to_string();
    let failed_node = failed_node(error);
    let sequence = RunHistoryStore::last_sequence(run_id).await? + 1;
    // The error event is durable history, so retain the ADK node identity here
    // instead of trying to reconstruct it later from a human-readable message.
    let event = StreamEvent::error(&message, failed_node.as_deref());
    RunHistoryStore::append_events(
        run_id,
        AppendRunEvents {
            events: vec![NewRunEvent {
                sequence,
                event: serde_json::to_value(&event)?,
                created_at: chrono::Utc::now().to_rfc3339(),
            }],
        },
    )
    .await?;

    emit_on_main_thread(
        "run-event",
        RunEventEnvelope {
            run_id: run_id.to_string(),
            sequence,
            event: serde_json::to_value(event)?,
        },
    )?;
    finish_run(run_id, RunStatus::Failed, Some(message)).await
}

fn failed_node(error: &anyhow::Error) -> Option<String> {
    error
        .chain()
        .find_map(|cause| match cause.downcast_ref::<adk_rust::graph::GraphError>() {
            Some(adk_rust::graph::GraphError::NodeExecutionFailed { node, .. })
            | Some(adk_rust::graph::GraphError::NodeTimedOut { node, .. }) => Some(node.clone()),
            _ => None,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_the_failed_node_from_an_adk_error_chain() {
        let error = anyhow::Error::new(adk_rust::graph::GraphError::NodeExecutionFailed {
            node: "send-report".to_string(),
            message: "network unavailable".to_string(),
        });
        let failed_node = failed_node(&error);

        assert_eq!(failed_node.as_deref(), Some("send-report"));
    }
}

pub(super) async fn persist_events(run_id: String, mut receiver: mpsc::UnboundedReceiver<Value>) -> Result<bool> {
    let mut sequence = RunHistoryStore::last_sequence(&run_id).await? + 1;
    let mut has_pending_action = false;
    while let Some(mut event) = receiver.recv().await {
        if let Some((kind, payload)) = pending_action(&event) {
            let action_id = uuid::Uuid::new_v4().to_string();
            RunHistoryStore::create_pending_action(CreatePendingAction {
                id: action_id.clone(),
                run_id: run_id.clone(),
                kind,
                payload,
                created_at: chrono::Utc::now().to_rfc3339(),
            })
            .await?;
            // Claiming belongs to the shell-level coordinator. Notify it only
            // after the action is durable, so it can claim immediately.
            emit_on_main_thread(
                "pending-action-created",
                PendingActionCreated {
                    action_id: action_id.clone(),
                    run_id: run_id.clone(),
                },
            )?;
            // The UI needs the durable action ID to resolve this exact prompt;
            // keep it on the emitted copy without changing node-defined data.
            if let Some(object) = event.get_mut("data").and_then(Value::as_object_mut) {
                object.insert("runActionId".to_string(), Value::String(action_id));
            }
            has_pending_action = true;
        }
        RunHistoryStore::append_events(
            &run_id,
            AppendRunEvents {
                events: vec![NewRunEvent {
                    sequence,
                    event: event.clone(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                }],
            },
        )
        .await?;
        if let Err(error) = project_telemetry_span(&run_id, &event).await {
            // Telemetry is a derived projection. A damaged projection must not
            // turn an otherwise durable workflow event into a failed run.
            log::warn!("failed to project workflow telemetry for run {run_id}: {error:#}");
        }
        emit_on_main_thread(
            "run-event",
            RunEventEnvelope {
                run_id: run_id.clone(),
                sequence,
                event,
            },
        )?;
        sequence += 1;
    }
    Ok(has_pending_action)
}

async fn project_telemetry_span(run_id: &str, event: &Value) -> Result<()> {
    let Some(event_type) = event.get("type").and_then(Value::as_str) else {
        return Ok(());
    };
    let Some(node_id) = event.get("node").and_then(Value::as_str) else {
        return Ok(());
    };
    if matches!(event_type, "agent.tool_call" | "agent.tool_result" | "agent.tool_error") {
        return project_tool_span(run_id, node_id, event_type, event.get("data")).await;
    }
    if event_type == "agent.model_call" {
        return project_model_span(run_id, node_id, event.get("data")).await;
    }
    let step = event.get("step").and_then(Value::as_i64).unwrap_or_default();
    let span_id = format!("{run_id}:workflow-node:{node_id}:{step}");
    let attributes = json!({ "step": step });
    match event_type {
        "node_start" => {
            RunHistoryStore::create_span(CreateRunSpan {
                id: span_id,
                run_id: run_id.to_string(),
                parent_span_id: None,
                kind: TelemetrySpanKind::WorkflowNode,
                status: TelemetrySpanStatus::Running,
                node_id: Some(node_id.to_string()),
                node_name: None,
                provider: None,
                model: None,
                tool_name: None,
                started_at: chrono::Utc::now().to_rfc3339(),
                attributes,
            })
            .await
        },
        "node_end" => {
            let duration_ms = event.get("duration_ms").and_then(Value::as_i64).unwrap_or_default();
            RunHistoryStore::finish_span(
                &span_id,
                FinishRunSpan {
                    status: TelemetrySpanStatus::Completed,
                    ended_at: chrono::Utc::now().to_rfc3339(),
                    duration_ms: Some(duration_ms),
                    input_tokens: None,
                    output_tokens: None,
                    total_tokens: None,
                    total_tokens_estimated: false,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    reasoning_tokens: None,
                    audio_input_tokens: None,
                    audio_output_tokens: None,
                    estimated_cost_microusd: None,
                    is_byok: None,
                    error_code: None,
                    error_message: None,
                    attributes,
                },
            )
            .await
        },
        _ => Ok(()),
    }
}

async fn project_model_span(run_id: &str, node_id: &str, data: Option<&Value>) -> Result<()> {
    let Some(data) = data.and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(call_id) = data
        .get("modelCallId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    else {
        return Ok(());
    };
    let Some(model) = data
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
    else {
        return Ok(());
    };
    let occurred_at = data
        .get("occurredAt")
        .and_then(Value::as_str)
        .filter(|timestamp| !timestamp.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
    let span_id = format!("{run_id}:model:{call_id}");
    let attributes = json!({ "modelCallId": call_id });
    RunHistoryStore::create_span(CreateRunSpan {
        id: span_id.clone(),
        run_id: run_id.to_string(),
        parent_span_id: None,
        kind: TelemetrySpanKind::ModelCall,
        status: TelemetrySpanStatus::Running,
        node_id: Some(node_id.to_string()),
        node_name: None,
        provider: None,
        model: Some(model.to_string()),
        tool_name: None,
        started_at: occurred_at.clone(),
        attributes: attributes.clone(),
    })
    .await?;
    RunHistoryStore::finish_span(
        &span_id,
        FinishRunSpan {
            status: TelemetrySpanStatus::Completed,
            ended_at: occurred_at,
            // Event timestamps identify completion, not request start. Preserve
            // the unknown latency as NULL instead of inventing a zero duration.
            duration_ms: None,
            input_tokens: data.get("inputTokens").and_then(Value::as_i64),
            output_tokens: data.get("outputTokens").and_then(Value::as_i64),
            total_tokens: data.get("totalTokens").and_then(Value::as_i64),
            total_tokens_estimated: data
                .get("totalTokensEstimated")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            cache_read_tokens: data.get("cacheReadTokens").and_then(Value::as_i64),
            cache_write_tokens: data.get("cacheWriteTokens").and_then(Value::as_i64),
            reasoning_tokens: data.get("reasoningTokens").and_then(Value::as_i64),
            audio_input_tokens: data.get("audioInputTokens").and_then(Value::as_i64),
            audio_output_tokens: data.get("audioOutputTokens").and_then(Value::as_i64),
            estimated_cost_microusd: data.get("estimatedCostMicrousd").and_then(Value::as_i64),
            is_byok: data.get("isByok").and_then(Value::as_bool),
            error_code: None,
            error_message: None,
            attributes,
        },
    )
    .await
}

async fn project_tool_span(run_id: &str, node_id: &str, event_type: &str, data: Option<&Value>) -> Result<()> {
    let Some(data) = data.and_then(Value::as_object) else {
        return Ok(());
    };
    let Some(call_id) = data.get("callId").and_then(Value::as_str).filter(|id| !id.is_empty()) else {
        return Ok(());
    };
    let Some(tool_name) = data.get("tool").and_then(Value::as_str).filter(|name| !name.is_empty()) else {
        return Ok(());
    };
    let span_id = format!("{run_id}:tool:{call_id}");
    // Inputs and outputs remain in the redacted event journal. The span stores
    // only identity fields needed for duration and reliability aggregation.
    let attributes = json!({ "callId": call_id });
    match event_type {
        "agent.tool_call" => {
            RunHistoryStore::create_span(CreateRunSpan {
                id: span_id,
                run_id: run_id.to_string(),
                parent_span_id: None,
                kind: TelemetrySpanKind::ToolCall,
                status: TelemetrySpanStatus::Running,
                node_id: Some(node_id.to_string()),
                node_name: data.get("name").and_then(Value::as_str).map(str::to_string),
                provider: None,
                model: None,
                tool_name: Some(tool_name.to_string()),
                started_at: chrono::Utc::now().to_rfc3339(),
                attributes,
            })
            .await
        },
        "agent.tool_result" | "agent.tool_error" => {
            let duration_ms = data.get("durationMs").and_then(Value::as_i64).unwrap_or_default();
            RunHistoryStore::finish_span(
                &span_id,
                FinishRunSpan {
                    status: if event_type == "agent.tool_result" {
                        TelemetrySpanStatus::Completed
                    } else {
                        TelemetrySpanStatus::Failed
                    },
                    ended_at: chrono::Utc::now().to_rfc3339(),
                    duration_ms: Some(duration_ms),
                    input_tokens: None,
                    output_tokens: None,
                    total_tokens: None,
                    total_tokens_estimated: false,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    reasoning_tokens: None,
                    audio_input_tokens: None,
                    audio_output_tokens: None,
                    estimated_cost_microusd: None,
                    is_byok: None,
                    error_code: None,
                    error_message: None,
                    attributes,
                },
            )
            .await
        },
        _ => Ok(()),
    }
}

pub(super) async fn execute_app(run_id: &str, target_id: &str, handle: Arc<AppRunHandle>) -> Result<()> {
    if handle.cancelled.load(Ordering::Acquire) {
        return complete_app_cancellation(run_id).await;
    }
    let (output, receiver) = mpsc::unbounded_channel::<PythonOutputChunk>();
    let writer = tauri::async_runtime::spawn(persist_app_output(run_id.to_string(), receiver));
    let output_sender = output.clone();
    let started_handle = Arc::clone(&handle);
    let result = crate::feat::run_process_node_with_output(
        target_id,
        std::sync::Arc::new(move |chunk| {
            let _ = output_sender.send(chunk);
        }),
        Some(Arc::new(move |pid| started_handle.register_pid(pid))),
    )
    .await;
    drop(output);
    writer.await??;
    if handle.cancelled.load(Ordering::Acquire) {
        return complete_app_cancellation(run_id).await;
    }
    let result = result?;
    let succeeded = result.execution.exit_code == Some(0);
    publish_value_event(
        run_id,
        json!({
            "type": "app_done",
            "execution": {
                "scriptPath": result.execution.script_path,
                "exitCode": result.execution.exit_code,
            },
        }),
    )
    .await?;
    finish_run(
        run_id,
        if succeeded {
            RunStatus::Completed
        } else {
            RunStatus::Failed
        },
        result.execution.exit_code.map_or_else(
            || Some("Process ended without an exit code".to_string()),
            |code| (code != 0).then(|| format!("Process exited with code {code}")),
        ),
    )
    .await
}

pub(super) async fn complete_app_cancellation(run_id: &str) -> Result<()> {
    publish_value_event(run_id, json!({ "type": "app_cancelled" })).await?;
    finish_run(run_id, RunStatus::Cancelled, Some("Cancelled by user".to_string())).await
}

pub(super) async fn finish_run(run_id: &str, status: RunStatus, error: Option<String>) -> Result<()> {
    RunHistoryStore::finish_execution(run_id, status, error).await?;
    // Output events precede the durable status update. Publish a separate
    // notification afterwards so shell-level active-run queries cannot retain
    // the stale "running" result from that earlier event.
    publish_run_status(run_id, status)?;
    Ok(())
}

pub(super) fn publish_run_status(run_id: &str, status: RunStatus) -> Result<()> {
    emit_on_main_thread(
        "run-status-changed",
        RunStatusChange {
            run_id: run_id.to_string(),
            status,
        },
    )
}

#[cfg(unix)]
pub(super) fn terminate_process_tree(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // Python is made its own process-group leader in `python_runtime`; a
    // negative PID addresses that complete group rather than only Python.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(windows)]
pub(super) fn terminate_process_tree(pid: u32, _force: bool) {
    crate::module::python_runtime::PythonRuntime::terminate_process_tree(pid);
}

pub(super) async fn publish_value_event(run_id: &str, event: Value) -> Result<()> {
    let sequence = RunHistoryStore::last_sequence(run_id).await? + 1;
    RunHistoryStore::append_events(
        run_id,
        AppendRunEvents {
            events: vec![NewRunEvent {
                sequence,
                event: event.clone(),
                created_at: chrono::Utc::now().to_rfc3339(),
            }],
        },
    )
    .await?;

    emit_on_main_thread(
        "run-event",
        RunEventEnvelope {
            run_id: run_id.to_string(),
            sequence,
            event,
        },
    )?;

    Ok(())
}

async fn persist_app_output(run_id: String, mut receiver: mpsc::UnboundedReceiver<PythonOutputChunk>) -> Result<()> {
    let mut sequence = RunHistoryStore::last_sequence(&run_id).await? + 1;
    while let Some(chunk) = receiver.recv().await {
        let event = json!({ "type": "output", "stream": chunk.stream, "data": chunk.data });
        RunHistoryStore::append_events(
            &run_id,
            AppendRunEvents {
                events: vec![NewRunEvent {
                    sequence,
                    event: event.clone(),
                    created_at: chrono::Utc::now().to_rfc3339(),
                }],
            },
        )
        .await?;

        emit_on_main_thread(
            "run-event",
            RunEventEnvelope {
                run_id: run_id.clone(),
                sequence,
                event,
            },
        )?;
        sequence += 1;
    }
    Ok(())
}

fn emit_on_main_thread<S>(event_name: &'static str, payload: S) -> Result<()>
where
    S: Serialize + Clone + Send + 'static,
{
    let app = handle::Handle::app_handle();
    let emit_app = app.clone();
    // Wry synchronously evaluates listeners for an emit from a background
    // worker. Queue it on the main loop so a concurrent WebView IPC request
    // cannot invert the WebView lock and freeze the renderer.
    app.run_on_main_thread(move || {
        if let Err(error) = emit_app.emit(event_name, payload) {
            log::warn!("failed to emit {event_name}: {error}");
        }
    })?;
    Ok(())
}

fn pending_action(event: &Value) -> Option<(crate::module::run_history::PendingActionKind, Value)> {
    let object = event.as_object()?;
    if object.get("type")?.as_str()? != "custom" {
        return None;
    }
    let kind = match object.get("event_type")?.as_str()? {
        "agent.tool_approval_required" => crate::module::run_history::PendingActionKind::ToolApproval,
        "workflow.human_review_required" => crate::module::run_history::PendingActionKind::HumanReview,
        "workflow.ask_user_question_required" => crate::module::run_history::PendingActionKind::AskUserQuestion,
        _ => return None,
    };
    Some((kind, object.get("data")?.clone()))
}
