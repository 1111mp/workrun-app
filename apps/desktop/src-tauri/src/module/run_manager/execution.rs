use super::events::{execute_app, finish_run, persist_events, publish_error, publish_value_event};
use super::workflow::workflow_session_from_runtime;
use super::*;
use futures::FutureExt as _;
use tracing::Instrument as _;

pub(super) async fn execute_claimed_run(run_id: &str) {
    let workspace = crate::utils::dirs::active_workspace_id();
    let mut schedule_span = None;
    let result = async {
        let record = RunHistoryStore::inspect(run_id).await?;
        // Only scheduled runs get this boundary; ordinary runs retain their existing tracing.
        schedule_span = scheduled_run_span(&record.runtime, &workspace, run_id);
        async {
            match record.summary.target_type.as_str() {
                "app" => execute_claimed_app(run_id, &record.summary.target_id).await,
                "workflow" => {
                    execute_claimed_workflow(run_id, &record.summary.target_id, record.runtime, &workspace).await
                },
                target_type => bail!("unsupported queued run target type: {target_type}"),
            }
        }
        .instrument(schedule_span.clone().unwrap_or_else(tracing::Span::current))
        .await
    }
    .await;
    if let Some(span) = &schedule_span {
        crate::module::schedule::telemetry::finish(
            span,
            if result.is_ok() { "completed" } else { "failed" },
            result.as_ref().err(),
        );
    }
    if let Err(error) = result {
        RunManager::global().workflow_sessions.lock().remove(run_id);
        let message = error.to_string();
        if publish_error(run_id, &error).await.is_err() {
            let _ = finish_run(run_id, RunStatus::Failed, Some(message)).await;
        }
    }
    if let Some(span) = &schedule_span {
        // Execution may return Ok after recording an interrupted, cancelled or failed run.
        if let Ok(pool) = crate::core::db::DBManager::global().pool()
            && let Ok((status, error)) = sqlx::query_as::<_, (String, Option<String>)>(
                "SELECT status,error FROM run_records WHERE id=? AND workspace_id=?",
            )
            .bind(run_id)
            .bind(&workspace)
            .fetch_one(&pool)
            .await
        {
            let error = error.filter(|_| status == "failed").map(anyhow::Error::msg);
            crate::module::schedule::telemetry::finish(span, &status, error.as_ref());
            if status == "failed" {
                span.record("langfuse.observation.level", "ERROR");
            }
        }
    }
}

fn scheduled_run_span(runtime: &Value, workspace: &str, run_id: &str) -> Option<tracing::Span> {
    let trigger = &runtime["trigger"];
    if trigger["type"] != "schedule" {
        return None;
    }
    let span = crate::module::schedule::telemetry::observation("定时任务执行", "chain", workspace, run_id);
    span.record("langfuse.observation.metadata.runId", run_id);
    for (field, value) in [
        ("langfuse.observation.metadata.scheduleId", &trigger["scheduleId"]),
        ("langfuse.observation.metadata.occurrenceId", &trigger["occurrenceId"]),
        ("langfuse.observation.metadata.scheduledFor", &trigger["scheduledFor"]),
    ] {
        span.record(field, value.as_str().unwrap_or_default());
    }
    crate::module::schedule::telemetry::restore_parent(&span, trigger["traceparent"].as_str());
    Some(span)
}

async fn execute_claimed_app(run_id: &str, target_id: &str) -> Result<()> {
    let handle = Arc::new(AppRunHandle::new());
    RunManager::global()
        .app_runs
        .lock()
        .insert(run_id.to_string(), Arc::clone(&handle));
    // Erase the deep HTTP/runtime future before adding supervisor and tracing layers.
    // Otherwise the no-default-features dev build exceeds Rust's Send proof depth.
    let result = execute_app(run_id, target_id, Arc::clone(&handle)).boxed().await;
    handle.is_finished.store(true, Ordering::Release);
    handle.finished_notify.notify_waiters();
    RunManager::global().app_runs.lock().remove(run_id);
    result
}

async fn execute_claimed_workflow(run_id: &str, workflow_id: &str, runtime: Value, workspace: &str) -> Result<()> {
    let owner = runtime
        .get("teamModelOwner")
        .cloned()
        .map(serde_json::from_value)
        .transpose()?
        .flatten();
    crate::module::team_model::with_owner(owner, execute_owned_workflow(run_id, workflow_id, runtime, workspace)).await
}

async fn execute_owned_workflow(run_id: &str, workflow_id: &str, mut runtime: Value, workspace: &str) -> Result<()> {
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
    let tool_confirmation: Option<ToolConfirmationDecisionRequest> = runtime
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
    let name = runtime
        .pointer("/dsl/name")
        .and_then(Value::as_str)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or(workflow_id);
    let run_span = tracing::info_span!(
        "workrun.workflow.run",
        "otel.name"=name,"langfuse.trace.name"=name,"langfuse.observation.type"="chain",
        "langfuse.session.id"=tracing::field::Empty,
        "langfuse.observation.input"=tracing::field::Empty,
        "langfuse.observation.metadata.runId"=run_id,
        "langfuse.observation.metadata.turnId"=tracing::field::Empty,
        "langfuse.observation.metadata.workflowId"=workflow_id,
        "langfuse.observation.metadata.resumed"=resume,
        "langfuse.observation.metadata.toolApproval"=%json!(tool_confirmation.as_ref().map(|decision|json!({"approved":decision.approved,"requestedCallId":decision.function_call_id.split("__thought__").next()}))),
        "langfuse.observation.metadata.phaseStatus"=tracing::field::Empty,
        workrun.run.id = %run_id,
        workrun.workflow.id = %workflow_id,
        workrun.workflow.version = %workflow_version,
        workrun.thread.id = %session.thread_id,
    );
    if crate::core::telemetry::capture_content()
        && let Ok(dsl) = serde_json::from_value::<WorkflowDsl>(runtime["dsl"].clone())
    {
        let input = workflow_module::trace_input(&dsl, &runtime["initialState"]);
        run_span.record(
            "langfuse.observation.input",
            crate::core::telemetry_langfuse::encoded(&input),
        );
    }
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
    run_span.record(
        "langfuse.session.id",
        usage_context.session_id.as_deref().unwrap_or(run_id),
    );
    run_span.record(
        "langfuse.observation.metadata.turnId",
        usage_context.turn_id.as_deref().unwrap_or(""),
    );
    if let Ok(pool) = crate::core::db::DBManager::global().pool() {
        crate::core::telemetry::workflow_parent(&pool, run_id, &runtime, &run_span).await;
    }
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
    .instrument(run_span.clone())
    .await;
    if let Ok(pool) = crate::core::db::DBManager::global().pool()
        && let Ok(Some(status)) = sqlx::query_scalar::<_, String>("SELECT status FROM run_records WHERE id=?")
            .bind(run_id)
            .fetch_optional(&pool)
            .await
    {
        run_span.record("langfuse.observation.metadata.phaseStatus", status);
    }
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

#[cfg(test)]
mod stack_tests {
    use super::*;

    #[test]
    fn queued_run_dispatch_future_fits_worker_stack_budget() {
        // Merely construct the production future; no run or user storage is touched.
        // Nested context scopes must not copy the whole graph future into each parent.
        let future = execute_claimed_run("stack-budget-fixture");
        let bytes = std::mem::size_of_val(&future);
        assert!(
            bytes <= 32 * 1024,
            "queued dispatcher embeds {bytes} bytes of nested futures"
        );
    }
}

#[cfg(test)]
mod scheduling_trace_tests {
    use super::*;
    use crate::module::schedule::telemetry::{
        self,
        tests::{attribute, exporter},
    };
    use tracing::instrument::WithSubscriber;

    #[tokio::test]
    async fn scheduled_execution_and_workflow_restore_dispatch_trace_without_affecting_manual_runs() {
        let (subscriber, exporter, _provider) = exporter();
        async {
            assert!(scheduled_run_span(&json!({"kind":"workflow"}), "personal", "manual").is_none());
            let dispatch = telemetry::observation("dispatch fixture", "chain", "personal", "run-1");
            let runtime = json!({"trigger":{"type":"schedule","scheduleId":"task-1","occurrenceId":"occurrence-1","scheduledFor":"2026-11-15T09:00:00Z","traceparent":telemetry::traceparent(&dispatch)}});
            drop(dispatch);
            let execute = scheduled_run_span(&runtime, "personal", "run-1").unwrap();
            async {
                let node = telemetry::observation("workflow fixture", "chain", "personal", "run-1");
                telemetry::finish(&node, "completed", None);
            }.instrument(execute.clone()).await;
            telemetry::finish(&execute, "completed", None);
        }.with_subscriber(subscriber).await;
        let spans = exporter.get_finished_spans().unwrap();
        assert_eq!(spans.len(), 3);
        let dispatch = spans.iter().find(|s| s.name == "dispatch fixture").unwrap();
        let execute = spans.iter().find(|s| s.name == "定时任务执行").unwrap();
        let workflow = spans.iter().find(|s| s.name == "workflow fixture").unwrap();
        assert!(
            spans
                .iter()
                .all(|s| s.span_context.trace_id() == dispatch.span_context.trace_id())
        );
        assert_eq!(execute.parent_span_id, dispatch.span_context.span_id());
        assert_eq!(workflow.parent_span_id, execute.span_context.span_id());
        assert_eq!(
            attribute(execute, "langfuse.observation.metadata.scheduleId").as_deref(),
            Some("task-1")
        );
        assert_eq!(
            attribute(execute, "langfuse.observation.metadata.occurrenceId").as_deref(),
            Some("occurrence-1")
        );
    }

    #[tokio::test]
    #[ignore = "requires local Collector/Langfuse; real rule-only workflow in temporary checkpoint storage"]
    async fn export_scheduled_workflow_execution() {
        use crate::module::workflow::{TEST_CHECKPOINT_DB, compile};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("checkpoint.sqlite");
        std::fs::File::create(&path).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let task_id = format!("probe-{session_id}");
        let subscriber = crate::core::telemetry::subscriber("http://127.0.0.1:4317").unwrap();
        crate::core::telemetry::test_capture(true);
        println!("schedule_execution_probe={session_id}");
        async {
            let dispatch = telemetry::observation("定时任务触发验收", "chain", "personal", &session_id);
            dispatch.record("langfuse.observation.metadata.scheduleId", &task_id);
            dispatch.record("langfuse.observation.metadata.runId", &session_id);
            let runtime = json!({"trigger":{"type":"schedule","scheduleId":task_id,"occurrenceId":session_id,"scheduledFor":"2026-11-15T08:00:00Z","traceparent":telemetry::traceparent(&dispatch)}});
            telemetry::finish(&dispatch,"queued",None);
            drop(dispatch);
            let execute = scheduled_run_span(&runtime,"personal",&session_id).unwrap();
            let origin = crate::module::model_usage::CallContext {workspace_id:"personal".into(),run_id:Some(session_id.clone()),session_id:Some(session_id.clone()),purpose:"workflow".into(),..Default::default()};
            TEST_CHECKPOINT_DB.scope(format!("sqlite://{}",path.display()),crate::module::model_usage::scope(origin,async {
                let dsl = serde_json::from_value(json!({"id":"schedule-probe","name":"Scheduled rule fixture","nodes":[{"id":"start","type":"start"},{"id":"set","type":"switch","data":{"cases":[{"id":"adult","label":"Adult","condition":"age >= 18"}],"defaultCase":{"label":"Minor","condition":""}}},{"id":"end","type":"end"}],"edges":[{"source":"start","target":"set"},{"source":"set","target":"end","sourceHandle":"case:adult"},{"source":"set","target":"end","sourceHandle":"default"}]})).unwrap();
                let result = compile(dsl,&Default::default(),None).await.unwrap().run_stream(adk_rust::graph::State::from_iter([("age".into(),json!(20))]),"schedule-probe",false,None,|_|{}).await.unwrap();
                assert!(!result.interrupted);
            }).instrument(execute.clone())).await;
            telemetry::finish(&execute,"completed",None);
        }.with_subscriber(subscriber).await;
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        crate::core::telemetry::test_capture(false);
    }
}
