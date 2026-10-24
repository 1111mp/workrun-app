use super::events::{execute_app, finish_run, persist_events, publish_error, publish_value_event};
use super::workflow::workflow_session_from_runtime;
use super::*;
use tracing::Instrument as _;

pub(super) async fn execute_claimed_run(run_id: &str) {
    let workspace = crate::utils::dirs::active_workspace_id();
    let result = async {
        let record = RunHistoryStore::inspect(run_id).await?;
        match record.summary.target_type.as_str() {
            "app" => execute_claimed_app(run_id, &record.summary.target_id).await,
            "workflow" => execute_claimed_workflow(run_id, &record.summary.target_id, record.runtime, &workspace).await,
            target_type => bail!("unsupported queued run target type: {target_type}"),
        }
    }
    .await;
    if let Err(error) = result {
        RunManager::global().workflow_sessions.lock().remove(run_id);
        let message = error.to_string();
        if publish_error(run_id, &error).await.is_err() {
            let _ = finish_run(run_id, RunStatus::Failed, Some(message)).await;
        }
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

async fn execute_claimed_workflow(run_id: &str, workflow_id: &str, mut runtime: Value, workspace: &str) -> Result<()> {
    if runtime.get("restoredQueue").and_then(Value::as_bool) == Some(true) {
        if let Err(error) = super::workflow::validate_restored_queue(run_id, &runtime).await {
            // Validation is not a failed execution and must not trigger cleanup
            // or turn a saved authorization into a fresh run.
            finish_run(run_id, RunStatus::Interrupted, Some(error.to_string())).await?;
            return Ok(());
        }
        let pool = crate::core::db::DBManager::global().pool()?;
        sqlx::query("UPDATE run_records SET runtime_json = json_remove(runtime_json, '$.restoredQueue') WHERE id = ?")
            .bind(run_id)
            .execute(&pool)
            .await?;
    }
    if runtime.get("pendingCheckpointUpdate").is_some()
        && let Err(error) = apply_pending_checkpoint_update(run_id, &mut runtime).await
    {
        // An accepted decision stays durable and retryable. A preparation
        // failure must never execute business nodes or trigger compensation.
        finish_run(run_id, RunStatus::Interrupted, Some(error.to_string())).await?;
        return Ok(());
    }
    publish_value_event(
        run_id,
        json!({"type":"custom", "node":"", "event_type":"workflow.attempt_started", "data":{}}),
    )
    .await?;
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
    let evaluation_profile = runtime
        .get("evaluationProfile")
        .filter(|value| !value.is_null())
        .cloned()
        .map(serde_json::from_value)
        .transpose()
        .context("workflow evaluation profile is invalid")?;
    let chat_session_id = runtime.get("chatSessionId").and_then(Value::as_str).map(str::to_owned);
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
    // Attribution is diagnostic: malformed/stale origin data must not stop a run.
    let mut usage_context = runtime
        .get("usageOrigin")
        .cloned()
        .and_then(|value| serde_json::from_value::<crate::module::model_usage::CallContext>(value).ok())
        .filter(|origin| origin.workspace_id == workspace)
        .unwrap_or(crate::module::model_usage::CallContext {
            workspace_id: workspace.into(),
            session_kind: chat_session_id.as_ref().map(|_| "workflow_chat".into()),
            session_id: chat_session_id.clone(),
            purpose: "workflow".into(),
            ..Default::default()
        });
    usage_context.run_id = Some(run_id.into());
    usage_context.purpose = "workflow".into();
    usage_context.workflow_path = vec![workflow_id.into()];
    {
        use sha2::{Digest, Sha256};
        usage_context.recipe_hash = Some(hex::encode(Sha256::digest(runtime["dsl"].to_string().as_bytes())));
    }
    let result = crate::module::model_usage::scope(
        usage_context,
        execute_workflow(
            run_id,
            session,
            resume,
            tool_confirmation,
            evaluation_profile,
            chat_session_id,
            cancellation,
        ),
    )
    .instrument(run_span)
    .await;
    RunManager::global().workflow_cancellations.lock().remove(run_id);
    result
}

async fn apply_pending_checkpoint_update(run_id: &str, runtime: &mut Value) -> Result<()> {
    let Some(update) = super::workflow::pending_checkpoint_update(runtime)? else {
        return Ok(());
    };
    let session = workflow_session_from_runtime(runtime)?;
    workflow_module::apply_action_checkpoint_updates(
        session.dsl,
        session.thread_id,
        update.workflow_context,
        update.updates,
    )
    .await?;
    // These are assignments, so a crash before this marker is cleared can
    // safely reapply the same decision. Clear it before any business node runs.
    let pool = crate::core::db::DBManager::global().pool()?;
    let result = sqlx::query("UPDATE run_records SET runtime_json = json_remove(runtime_json, '$.pendingCheckpointUpdate') WHERE id = ? AND status = 'running'")
        .bind(run_id).execute(&pool).await?;
    if result.rows_affected() != 1 {
        bail!("Workflow is no longer running; cannot finish applying its interaction decision");
    }
    runtime
        .as_object_mut()
        .context("workflow runtime metadata is invalid")?
        .remove("pendingCheckpointUpdate");
    Ok(())
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
    evaluation_profile: Option<workflow_module::EvaluationExecutionProfile>,
    chat_session_id: Option<String>,
    cancellation: CancellationToken,
) -> Result<()> {
    let dsl: WorkflowDsl = serde_json::from_value(session.dsl)?;
    let session_state_fields = dsl.session_state_fields.clone();
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
        let compiled = match evaluation_profile {
            Some(profile) => workflow_module::compile_for_evaluation(dsl, &config, Some(node_events), profile).await?,
            None => workflow_module::compile(dsl, &config, Some(node_events)).await?,
        };
        let event_sender = events.clone();
        let run = compiled.run_stream_tracked(
            initial_state,
            &session.thread_id,
            resume,
            tool_confirmation,
            Some(run_id),
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
            result = run => Some(result),
            _ = cancellation.cancelled() => None,
        }
        // `compiled` owns the node event Channel. Its sender must be dropped
        // before waiting for the writer, otherwise receiver.recv never ends.
    };
    let result = match result {
        Some(Ok(result)) => Some(result),
        Some(Err(error)) => {
            // Drain the previous attempt before recording failure or permitting
            // same-task recovery, so writers cannot reuse an event sequence.
            drop(events);
            writer.await??;
            return Err(error);
        },
        None => None,
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
        let finished = finish_run(run_id, RunStatus::Cancelled, Some("Cancelled by user".to_string())).await;
        return finished;
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
    if !result.interrupted
        && let Some(session_id) = chat_session_id.as_deref()
    {
        let global = result.state.get("global").and_then(Value::as_object);
        let updates = global
            .map(|global| {
                session_state_fields
                    .iter()
                    .filter_map(|key| global.get(key).cloned().map(|value| (key.clone(), value)))
                    .collect()
            })
            .unwrap_or_default();
        crate::module::chat_session::ChatSessionStore::merge_state(session_id, &updates).await?;
    }
    drop(events);
    let has_pending_action = writer.await??;
    if result.interrupted && has_pending_action {
        crate::module::run_history::recovery::complete_attempt(&crate::core::db::DBManager::global().pool()?, run_id)
            .await?;
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
