//! Native ownership of long-running workflow sessions.

use crate::{
    config::Config,
    core::handle,
    module::{
        process_node::ProcessNodeRegistry,
        python_runtime::PythonOutputChunk,
        run_history::{AppendRunEvents, CreatePendingAction, NewRunEvent, RunHistoryStore, RunStatus},
        workflow::{self, ToolConfirmationDecisionRequest, WorkflowDsl},
    },
    process::AsyncHandler,
};
use adk_rust::graph::{State, StreamEvent};
use anyhow::{Context, Result, bail};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    time::Duration,
};
use tauri::{
    Emitter,
    ipc::{Channel, InvokeResponseBody},
};
use tokio::sync::{Notify, mpsc};

static WORKFLOW_SESSIONS: Lazy<Mutex<HashMap<String, WorkflowSession>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static APP_RUNS: Lazy<Mutex<HashMap<String, Arc<AppRunHandle>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
struct WorkflowSession {
    dsl: Value,
    thread_id: String,
    initial_state: Value,
}

/// Native state retained for an App even when its source webview has gone away.
/// The PID is the Unix process-group leader, so signalling it can stop children
/// spawned by the Python entrypoint as well as the entrypoint itself.
struct AppRunHandle {
    pid: AtomicU32,
    cancelled: AtomicBool,
    is_finished: AtomicBool,
    finished_notify: Notify,
}

impl AppRunHandle {
    fn new() -> Self {
        Self {
            pid: AtomicU32::new(0),
            cancelled: AtomicBool::new(false),
            is_finished: AtomicBool::new(false),
            finished_notify: Notify::new(),
        }
    }

    fn register_pid(&self, pid: u32) {
        self.pid.store(pid, Ordering::Release);
        if self.cancelled.load(Ordering::Acquire) {
            terminate_process_tree(pid, false);
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartWorkflowRun {
    pub run_id: String,
    pub target_id: String,
    pub target_name: String,
    pub input: Value,
    pub output_view: Value,
    pub target_snapshot: Value,
    pub dsl: Value,
    pub initial_state: Value,
    pub thread_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeWorkflowRun {
    pub run_id: String,
    pub tool_confirmation: Option<ToolConfirmationDecisionRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWorkflowAction {
    pub id: String,
    pub claimant_id: String,
    pub resolution: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAppRun {
    pub run_id: String,
    pub target_id: String,
    pub target_name: String,
    pub output_view: Value,
    pub target_snapshot: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventEnvelope {
    pub run_id: String,
    pub sequence: i64,
    pub event: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingActionCreated {
    action_id: String,
    run_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunStatusChange {
    run_id: String,
    status: RunStatus,
}

pub async fn start_app(request: StartAppRun) -> Result<()> {
    if request.run_id.trim().is_empty() || request.target_id.trim().is_empty() {
        bail!("run id and target id are required");
    }
    RunHistoryStore::create(crate::module::run_history::CreateRunRecord {
        id: request.run_id.clone(),
        target_type: crate::module::run_history::RunTargetType::App,
        target_id: request.target_id.clone(),
        target_name: request.target_name,
        status: RunStatus::Running,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: None,
        output_view: request.output_view,
        target_snapshot: request.target_snapshot,
        runtime: json!({ "kind": "app" }),
    })
    .await?;
    publish_run_status(&request.run_id, RunStatus::Running)?;
    let run_id = request.run_id.clone();
    let target_id = request.target_id.clone();
    let handle = Arc::new(AppRunHandle::new());
    APP_RUNS.lock().insert(run_id.clone(), Arc::clone(&handle));

    let task = AsyncHandler::spawn(move || async move {
        if let Err(error) = execute_app(&run_id, &target_id, Arc::clone(&handle)).await {
            if handle.cancelled.load(Ordering::Acquire) {
                let _ = complete_app_cancellation(&run_id).await;
            } else {
                let _ = publish_error(&run_id, &error.to_string()).await;
            }
        }
        handle.is_finished.store(true, Ordering::Release);
        handle.finished_notify.notify_waiters();
        APP_RUNS.lock().remove(&run_id);
    });

    drop(task);

    Ok(())
}

/// Stop an App and its descendants, then let pipe readers drain before the
/// cancellation becomes durable. That preserves output emitted just before the
/// operating system delivered the termination signal.
pub async fn cancel_running_app(run_id: &str) -> Result<()> {
    let active_handle = { APP_RUNS.lock().get(run_id).cloned() };
    let handle = match active_handle {
        Some(handle) => handle,
        None => return reconcile_inactive_app_run(run_id).await,
    };
    handle.cancelled.store(true, Ordering::Release);
    let pid = handle.pid.load(Ordering::Acquire);
    if pid != 0 {
        terminate_process_tree(pid, false);
    }

    // Give cooperative shutdown a brief chance before forcing the whole tree.
    if tokio::time::timeout(Duration::from_secs(2), wait_for_app_finish(&handle))
        .await
        .is_err()
        && pid != 0
    {
        terminate_process_tree(pid, true);
    }
    wait_for_app_finish(&handle).await;
    // `execute_app` records the terminal event after the stream readers finish.
    // Re-read the record so a cancellation racing natural completion never
    // overwrites a completed result.
    let status = RunHistoryStore::inspect(run_id).await?.summary.status;
    if status == "running" {
        complete_app_cancellation(&run_id).await?;
    }
    Ok(())
}

async fn reconcile_inactive_app_run(run_id: &str) -> Result<()> {
    let run = RunHistoryStore::inspect(run_id).await?;
    if run.summary.target_type != "app" || run.summary.status != "running" {
        bail!("App run is no longer active: {run_id}");
    }
    let exit_code = run.events.iter().rev().find_map(|stored| {
        let event = stored.event.as_object()?;
        (event.get("type")?.as_str()? == "app_done")
            .then(|| event.get("execution")?.get("exitCode")?.as_i64())
            .flatten()
    });
    let (status, error) = match exit_code {
        Some(0) => (RunStatus::Completed, None),
        Some(code) => (RunStatus::Failed, Some(format!("Process exited with code {code}"))),
        None => (
            RunStatus::Interrupted,
            Some("App process stopped before its final status was recorded.".to_string()),
        ),
    };
    // This only applies to records left behind by an earlier failed finalizer.
    // Once the in-memory handle is gone, there is no process left to cancel.
    finish_run(run_id, status, error).await
}

async fn wait_for_app_finish(handle: &AppRunHandle) {
    if handle.is_finished.load(Ordering::Acquire) {
        return;
    }
    let notified = handle.finished_notify.notified();
    if !handle.is_finished.load(Ordering::Acquire) {
        notified.await;
    }
}

/// Start a workflow independently from the webview that asked for it.
pub async fn start_workflow(request: StartWorkflowRun) -> Result<()> {
    if request.run_id.trim().is_empty() || request.thread_id.trim().is_empty() {
        bail!("run id and thread id are required");
    }
    let runtime = json!({
        "kind": "workflow",
        "dsl": request.dsl,
        "threadId": request.thread_id,
        "initialState": request.initial_state,
    });
    RunHistoryStore::create(crate::module::run_history::CreateRunRecord {
        id: request.run_id.clone(),
        target_type: crate::module::run_history::RunTargetType::Workflow,
        target_id: request.target_id,
        target_name: request.target_name,
        status: RunStatus::Running,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: Some(request.input),
        output_view: request.output_view,
        target_snapshot: request.target_snapshot,
        runtime,
    })
    .await?;
    publish_run_status(&request.run_id, RunStatus::Running)?;
    let session = WorkflowSession {
        dsl: request.dsl,
        thread_id: request.thread_id,
        initial_state: request.initial_state,
    };
    WORKFLOW_SESSIONS.lock().insert(request.run_id.clone(), session.clone());
    spawn_workflow(request.run_id, session, false, None);
    Ok(())
}

/// Resume a checkpointed workflow without asking the original React component
/// to keep its DSL or event channel alive.
pub async fn resume_workflow(request: ResumeWorkflowRun) -> Result<()> {
    let record = RunHistoryStore::inspect(&request.run_id).await?;
    if record.summary.target_type != "workflow" || record.summary.status != "waiting_for_input" {
        bail!("only a workflow waiting for input can be resumed");
    }
    let session = if let Some(session) = WORKFLOW_SESSIONS.lock().get(&request.run_id).cloned() {
        session
    } else {
        // A paused graph checkpoint is durable. Rehydrate only the execution
        // recipe after restart; active processes are intentionally not resumed.
        let session = workflow_session_from_runtime(&record.runtime)?;
        WORKFLOW_SESSIONS.lock().insert(request.run_id.clone(), session.clone());
        session
    };
    RunHistoryStore::mark_running(&request.run_id).await?;
    publish_run_status(&request.run_id, RunStatus::Running)?;
    spawn_workflow(request.run_id, session, true, request.tool_confirmation);
    Ok(())
}

/// Complete a globally claimed action from durable data. The browser never
/// supplies a DSL or checkpoint identity here; both are taken from the run
/// record that originally paused, preventing a stale page from resuming a
/// different workflow.
pub async fn resolve_workflow_action(request: ResolveWorkflowAction) -> Result<()> {
    if request.id.trim().is_empty() || request.claimant_id.trim().is_empty() {
        bail!("pending action id and claimant are required");
    }
    let action = RunHistoryStore::inspect_pending_action(&request.id, &request.claimant_id).await?;
    let record = RunHistoryStore::inspect(&action.run_id).await?;
    if record.summary.target_type != "workflow" || record.summary.status != "waiting_for_input" {
        bail!("only a workflow waiting for input can be resumed");
    }
    let session = if let Some(session) = WORKFLOW_SESSIONS.lock().get(&action.run_id).cloned() {
        session
    } else {
        let session = workflow_session_from_runtime(&record.runtime)?;
        WORKFLOW_SESSIONS.lock().insert(action.run_id.clone(), session.clone());
        session
    };
    let tool_confirmation = apply_pending_action_checkpoint(&session, &action, &request.resolution).await?;
    RunHistoryStore::resolve_claimed_action_and_mark_running(&action.id, &request.claimant_id, request.resolution)
        .await?;
    publish_run_status(&action.run_id, RunStatus::Running)?;
    spawn_workflow(action.run_id, session, true, tool_confirmation);
    Ok(())
}

async fn apply_pending_action_checkpoint(
    session: &WorkflowSession,
    action: &crate::module::run_history::PendingAction,
    resolution: &Value,
) -> Result<Option<ToolConfirmationDecisionRequest>> {
    let payload = action
        .payload
        .as_object()
        .context("pending action payload is invalid")?;
    let decision = resolution.as_object().context("pending action resolution is invalid")?;
    match action.kind.as_str() {
        "tool_approval" => {
            let function_call_id = required_string(payload, "functionCallId")?;
            let fingerprint = required_string(payload, "fingerprint")?;
            let approved = required_bool(decision, "approved")?;
            Ok(Some(ToolConfirmationDecisionRequest {
                function_call_id,
                fingerprint,
                approved,
            }))
        },
        "human_review" => {
            let node_id = required_string(payload, "nodeId")?;
            let approved = required_bool(decision, "approved")?;
            let edits = decision.get("edits").cloned().unwrap_or_else(|| json!({}));
            let edits = serde_json::from_value(edits).context("review edits are invalid")?;
            let workflow_context = payload
                .get("workflowContext")
                .filter(|value| !value.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("review workflow context is invalid")?;
            workflow::resolve_human_review_checkpoint(
                session.dsl.clone(),
                session.thread_id.clone(),
                node_id,
                approved,
                edits,
                workflow_context,
            )
            .await?;
            Ok(None)
        },
        "ask_user_question" => {
            let node_id = required_string(payload, "nodeId")?;
            let option_id = required_string(decision, "optionId")?;
            let workflow_context = payload
                .get("workflowContext")
                .filter(|value| !value.is_null())
                .cloned()
                .map(serde_json::from_value)
                .transpose()
                .context("question workflow context is invalid")?;
            workflow::resolve_ask_user_question_checkpoint(
                session.dsl.clone(),
                session.thread_id.clone(),
                node_id,
                option_id,
                workflow_context,
            )
            .await?;
            Ok(None)
        },
        kind => bail!("unsupported pending action kind: {kind}"),
    }
}

fn required_string(object: &serde_json::Map<String, Value>, key: &str) -> Result<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .with_context(|| format!("pending action is missing {key}"))
}

fn required_bool(object: &serde_json::Map<String, Value>, key: &str) -> Result<bool> {
    object
        .get(key)
        .and_then(Value::as_bool)
        .with_context(|| format!("pending action is missing {key}"))
}

/// Cancel a workflow only while it is parked on a durable user action. Active
/// process execution deliberately has no cancel command until its child
/// process lifecycle can be terminated reliably.
pub async fn cancel_waiting_workflow(run_id: &str) -> Result<()> {
    let run = RunHistoryStore::inspect(run_id).await?;
    if run.summary.target_type != "workflow" || run.summary.status != "waiting_for_input" {
        bail!("only a workflow waiting for input can be cancelled");
    }
    WORKFLOW_SESSIONS.lock().remove(run_id);
    RunHistoryStore::cancel_pending_actions(run_id).await?;
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
    finish_run(run_id, RunStatus::Cancelled, Some("Cancelled by user".to_string())).await
}

fn workflow_session_from_runtime(runtime: &Value) -> Result<WorkflowSession> {
    let runtime = runtime.as_object().context("workflow runtime metadata is invalid")?;
    if runtime.get("kind").and_then(Value::as_str) != Some("workflow") {
        bail!("run is not resumable workflow metadata");
    }
    let dsl = runtime
        .get("dsl")
        .cloned()
        .context("workflow runtime is missing its DSL")?;
    let thread_id = runtime
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .context("workflow runtime is missing its thread ID")?
        .to_string();
    let initial_state = runtime
        .get("initialState")
        .cloned()
        .context("workflow runtime is missing its initial state")?;
    Ok(WorkflowSession {
        dsl,
        thread_id,
        initial_state,
    })
}

fn spawn_workflow(
    run_id: String,
    session: WorkflowSession,
    resume: bool,
    tool_confirmation: Option<ToolConfirmationDecisionRequest>,
) {
    AsyncHandler::spawn(move || async move {
        if let Err(error) = execute_workflow(&run_id, session, resume, tool_confirmation).await {
            let message = error.to_string();
            // Persisting the diagnostic event can itself fail (for example due
            // to a SQLite lock). The terminal state must still be attempted so
            // an action created before that failure cannot survive as pending.
            if publish_error(&run_id, &message).await.is_err() {
                let _ = finish_run(&run_id, RunStatus::Failed, Some(message)).await;
            }
            WORKFLOW_SESSIONS.lock().remove(&run_id);
        }
    });
}

async fn execute_workflow(
    run_id: &str,
    session: WorkflowSession,
    resume: bool,
    tool_confirmation: Option<ToolConfirmationDecisionRequest>,
) -> Result<()> {
    let dsl: WorkflowDsl = serde_json::from_value(session.dsl)?;
    let initial_state: State = serde_json::from_value(session.initial_state)?;
    let config = Config::workrun().await.latest_arc();
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
        let compiled = workflow::compile(dsl, &config, Some(node_events)).await?;
        let event_sender = events.clone();
        compiled
            .run_stream(
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
                    if let Ok(event) = serde_json::to_value(workflow::redact_event_for_transport(event)) {
                        let _ = event_sender.send(event);
                    }
                },
            )
            .await?
        // `compiled` owns the node event Channel. Its sender must be dropped
        // before waiting for the writer, otherwise receiver.recv never ends.
    };
    if let Some(total_steps) = terminal_steps.lock().take() {
        let event = StreamEvent::Done {
            state: workflow::redact_state_for_transport(&result.state),
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
        WORKFLOW_SESSIONS.lock().remove(run_id);
    }
    Ok(())
}

async fn publish_error(run_id: &str, message: &str) -> Result<()> {
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

    let app = handle::Handle::app_handle();
    app.emit(
        "run-event",
        RunEventEnvelope {
            run_id: run_id.to_string(),
            sequence,
            event: serde_json::to_value(event)?,
        },
    )?;
    finish_run(run_id, RunStatus::Failed, Some(message.to_string())).await
}

async fn persist_events(run_id: String, mut receiver: mpsc::UnboundedReceiver<Value>) -> Result<bool> {
    let mut sequence = RunHistoryStore::last_sequence(&run_id).await? + 1;
    let mut has_pending_action = false;
    let app = handle::Handle::app_handle();
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
            app.emit(
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
        app.emit(
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

async fn execute_app(run_id: &str, target_id: &str, handle: Arc<AppRunHandle>) -> Result<()> {
    if handle.cancelled.load(Ordering::Acquire) {
        return complete_app_cancellation(run_id).await;
    }
    let (output, receiver) = mpsc::unbounded_channel::<PythonOutputChunk>();
    let writer = tauri::async_runtime::spawn(persist_app_output(run_id.to_string(), receiver));
    let output_sender = output.clone();
    let started_handle = Arc::clone(&handle);
    let result = ProcessNodeRegistry::run_with_output(
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

async fn complete_app_cancellation(run_id: &str) -> Result<()> {
    publish_value_event(run_id, json!({ "type": "app_cancelled" })).await?;
    finish_run(run_id, RunStatus::Cancelled, Some("Cancelled by user".to_string())).await
}

async fn finish_run(run_id: &str, status: RunStatus, error: Option<String>) -> Result<()> {
    RunHistoryStore::finish_execution(run_id, status, error).await?;
    // Output events precede the durable status update. Publish a separate
    // notification afterwards so shell-level active-run queries cannot retain
    // the stale "running" result from that earlier event.
    publish_run_status(run_id, status)?;
    Ok(())
}

fn publish_run_status(run_id: &str, status: RunStatus) -> Result<()> {
    let app = handle::Handle::app_handle();
    app.emit(
        "run-status-changed",
        RunStatusChange {
            run_id: run_id.to_string(),
            status,
        },
    )?;
    Ok(())
}

#[cfg(unix)]
fn terminate_process_tree(pid: u32, force: bool) {
    let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
    // Python is made its own process-group leader in `python_runtime`; a
    // negative PID addresses that complete group rather than only Python.
    unsafe {
        libc::kill(-(pid as i32), signal);
    }
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32, _force: bool) {
    crate::module::python_runtime::PythonRuntime::terminate_process_tree(pid);
}

async fn publish_value_event(run_id: &str, event: Value) -> Result<()> {
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

    let app = handle::Handle::app_handle();
    app.emit(
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

        let app = handle::Handle::app_handle();
        app.emit(
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

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::terminate_process_tree;
    use super::workflow_session_from_runtime;
    use serde_json::json;

    #[test]
    fn rehydrates_a_paused_workflow_session_from_durable_runtime() {
        let session = workflow_session_from_runtime(&json!({
            "kind": "workflow",
            "dsl": { "id": "workflow-1" },
            "threadId": "thread-1",
            "initialState": { "input": "hello" },
        }))
        .unwrap();

        assert_eq!(session.thread_id, "thread-1");
        assert_eq!(session.initial_state, json!({ "input": "hello" }));
    }

    #[test]
    fn rejects_runtime_without_the_state_needed_to_resume() {
        let error = workflow_session_from_runtime(&json!({
            "kind": "workflow",
            "dsl": {},
            "threadId": "thread-1",
        }))
        .unwrap_err();

        assert!(error.to_string().contains("initial state"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_signal_reaches_a_spawned_child_process() {
        use tokio::io::{AsyncBufReadExt as _, BufReader};

        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            // Keep the shell alive as the group leader while its child is
            // running; this matches an App process that spawns a worker.
            .arg("sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let mut parent = command.spawn().unwrap();
        let parent_pid = parent.id().unwrap();
        let stdout = parent.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let child_pid: i32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();

        terminate_process_tree(parent_pid, false);
        let exited = tokio::time::timeout(std::time::Duration::from_secs(3), parent.wait()).await;
        if exited.is_err() {
            terminate_process_tree(parent_pid, true);
        }
        assert!(exited.is_ok(), "parent process did not exit after SIGTERM");

        for _ in 0..30 {
            let alive = unsafe { libc::kill(child_pid, 0) } == 0;
            if !alive {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("spawned child {child_pid} survived process-group cancellation");
    }
}
