use super::events::{execute_app, finish_run, persist_events, publish_error, publish_value_event};
use super::workflow::workflow_session_from_runtime;
use super::*;
use tracing::Instrument as _;

pub(super) async fn execute_claimed_run(run_id: &str) {
    let result = async {
        let record = RunHistoryStore::inspect(run_id).await?;
        match record.summary.target_type.as_str() {
            "app" => execute_claimed_app(run_id, &record.summary.target_id).await,
            "workflow" => execute_claimed_workflow(run_id, &record.summary.target_id, record.runtime).await,
            target_type => bail!("unsupported queued run target type: {target_type}"),
        }
    }
    .await;
    if let Err(error) = result {
        let message = error.to_string();
        if publish_error(run_id, &error).await.is_err() {
            let _ = finish_run(run_id, RunStatus::Failed, Some(message)).await;
        }
        RunManager::global().workflow_sessions.lock().remove(run_id);
    }
}

async fn execute_claimed_app(run_id: &str, target_id: &str) -> Result<()> {
    let handle = Arc::new(AppRunHandle::new());
    RunManager::global()
        .app_runs
        .lock()
        .insert(run_id.to_string(), Arc::clone(&handle));
    let result = execute_app(run_id, target_id, Arc::clone(&handle)).await;
    handle.is_finished.store(true, Ordering::Release);
    handle.finished_notify.notify_waiters();
    RunManager::global().app_runs.lock().remove(run_id);
    result
}

async fn execute_claimed_workflow(run_id: &str, workflow_id: &str, runtime: Value) -> Result<()> {
    let session = workflow_session_from_runtime(&runtime)?;
    let workflow_version = runtime.get("releaseVersion").and_then(Value::as_str).unwrap_or("draft");
    let resume = runtime.get("resume").and_then(Value::as_bool).unwrap_or(false);
    let tool_confirmation = runtime
        .get("toolConfirmation")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("workflow resume confirmation is invalid")?;
    RunManager::global()
        .workflow_sessions
        .lock()
        .insert(run_id.to_string(), session.clone());
    let cancellation = CancellationToken::new();
    RunManager::global()
        .workflow_cancellations
        .lock()
        .insert(run_id.to_string(), cancellation.clone());
    // Keep the root span attached across await points so ADK's model and tool
    // spans become children of the durable Workrun run they belong to.
    let run_span = tracing::info_span!(
        "workrun.workflow.run",
        workrun.run.id = %run_id,
        workrun.workflow.id = %workflow_id,
        workrun.workflow.version = %workflow_version,
        workrun.thread.id = %session.thread_id,
    );
    let result = execute_workflow(run_id, session, resume, tool_confirmation, cancellation)
        .instrument(run_span)
        .await;
    RunManager::global().workflow_cancellations.lock().remove(run_id);
    result
}

pub(super) fn workflow_resume_runtime(
    mut runtime: Value,
    tool_confirmation: Option<ToolConfirmationDecisionRequest>,
) -> Result<Value> {
    let object = runtime
        .as_object_mut()
        .context("workflow runtime metadata is invalid")?;
    object.insert("resume".to_string(), Value::Bool(true));
    object.insert(
        "toolConfirmation".to_string(),
        tool_confirmation
            .map(serde_json::to_value)
            .transpose()?
            .unwrap_or(Value::Null),
    );
    Ok(runtime)
}

async fn execute_workflow(
    run_id: &str,
    session: WorkflowSession,
    resume: bool,
    tool_confirmation: Option<ToolConfirmationDecisionRequest>,
    cancellation: CancellationToken,
) -> Result<()> {
    let dsl: WorkflowDsl = serde_json::from_value(session.dsl)?;
    let initial_state: State = serde_json::from_value(session.initial_state)?;
    let config = BaseConfig::workrun().await.latest_arc();
    let (events, receiver) = mpsc::unbounded_channel();
    let writer = tauri::async_runtime::spawn(persist_events(run_id.to_string(), receiver));
    let terminal_steps = Arc::new(Mutex::new(None));
    let callback_terminal_steps = Arc::clone(&terminal_steps);
    let result = {
        let node_event_sender = events.clone();
        let node_events = Channel::new(move |payload| {
            if let InvokeResponseBody::Json(payload) = payload
                && let Ok(event) = serde_json::from_str::<Value>(&payload)
            {
                let _ = node_event_sender.send(event);
            }
            Ok(())
        });
        // Node-level events contain structured Process results and control-node
        // decisions; route them through the same durable writer as graph events.
        let compiled = workflow_module::compile(dsl, &config, Some(node_events)).await?;
        let event_sender = events.clone();
        let run = compiled.run_stream(
            initial_state,
            &session.thread_id,
            resume,
            tool_confirmation,
            move |event| {
                if let StreamEvent::Done { total_steps: steps, .. } = event {
                    // `run_stream` emits ADK's internal graph state here. Hold
                    // the terminal event until its observer-safe state is built
                    // below, so the Output panel receives global/node namespaces.
                    *callback_terminal_steps.lock() = Some(steps);
                    return;
                }
                // The graph callback cannot await SQLite. A single writer keeps
                // event order durable while the graph remains free to stream.
                if let Ok(event) = serde_json::to_value(workflow_module::redact_event_for_transport(event)) {
                    let _ = event_sender.send(event);
                }
            },
        );
        tokio::select! {
            result = run => Some(result?),
            _ = cancellation.cancelled() => None,
        }
        // `compiled` owns the node event Channel. Its sender must be dropped
        // before waiting for the writer, otherwise receiver.recv never ends.
    };
    let Some(result) = result else {
        drop(events);
        writer.await??;
        RunManager::global().workflow_sessions.lock().remove(run_id);
        publish_value_event(
            run_id,
            json!({
                "type": "custom",
                "node": "",
                "event_type": "workflow.run_cancelled",
                "data": {},
            }),
        )
        .await?;
        return finish_run(run_id, RunStatus::Cancelled, Some("Cancelled by user".to_string())).await;
    };
    if let Some(total_steps) = terminal_steps.lock().take() {
        let event = StreamEvent::Done {
            state: workflow_module::redact_state_for_transport(&result.state),
            total_steps,
        };
        events
            .send(serde_json::to_value(event)?)
            .map_err(|_| anyhow::anyhow!("workflow event writer stopped"))?;
    }
    drop(events);
    let has_pending_action = writer.await??;
    if result.interrupted && has_pending_action {
        return Ok(());
    }
    finish_run(
        run_id,
        if result.interrupted {
            RunStatus::Interrupted
        } else {
            RunStatus::Completed
        },
        None,
    )
    .await?;
    if !result.interrupted {
        RunManager::global().workflow_sessions.lock().remove(run_id);
    }
    Ok(())
}
