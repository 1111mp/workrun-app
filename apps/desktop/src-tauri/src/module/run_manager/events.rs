use super::*;

pub(super) async fn publish_error(run_id: &str, message: &str) -> Result<()> {
    let sequence = RunHistoryStore::last_sequence(run_id).await? + 1;
    let event = StreamEvent::error(message, None);
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
    finish_run(run_id, RunStatus::Failed, Some(message.to_string())).await
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
