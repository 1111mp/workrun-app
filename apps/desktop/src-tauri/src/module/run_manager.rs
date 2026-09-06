//! Native ownership of long-running workflow sessions.

use crate::{
    config::Config,
    core::handle,
    module::{
        process_node::ProcessNodeRegistry,
        python_runtime::PythonOutputChunk,
        run_history::{
            AppendRunEvents, CreatePendingAction, CreateRunRecord, NewRunEvent, RunHistoryStore, RunRecordSummary,
            RunStatus, RunTargetType,
        },
        workflow::{self, ToolConfirmationDecisionRequest, WorkflowDsl},
    },
    process::AsyncHandler,
    singleton,
};
use adk_rust::graph::{State, StreamEvent};
use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::{
    Emitter,
    ipc::{Channel, InvokeResponseBody},
};
use tokio::sync::{Notify, Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

const MAX_CONCURRENT_TOP_LEVEL_RUNS: usize = 4;
const MAX_CONCURRENT_TOP_LEVEL_APP_RUNS: usize = 2;

/// The native owner of all top-level Run lifecycle state. Keeping these
/// indexes together prevents a renderer-owned map from becoming authoritative.
struct RunManager {
    workflow_sessions: Mutex<HashMap<String, WorkflowSession>>,
    workflow_cancellations: Mutex<HashMap<String, CancellationToken>>,
    app_runs: Mutex<HashMap<String, Arc<AppRunHandle>>>,
    supervisor: RunSupervisor,
}

impl Default for RunManager {
    fn default() -> Self {
        Self {
            workflow_sessions: Mutex::new(HashMap::new()),
            workflow_cancellations: Mutex::new(HashMap::new()),
            app_runs: Mutex::new(HashMap::new()),
            supervisor: RunSupervisor::new(),
        }
    }
}

impl RunManager {
    fn new() -> Self {
        Self::default()
    }

    fn start_supervisor(&'static self) {
        self.supervisor.start();
    }
}

singleton!(RunManager, RUN_MANAGER);

/// Owns dispatch of persisted top-level runs. Workflow-internal Apps deliberately
/// remain children of their workflow task: queueing them again could deadlock a
/// workflow that already holds the last top-level execution permit.
struct RunSupervisor {
    permits: Arc<Semaphore>,
    app_permits: Arc<Semaphore>,
    wake: Notify,
    idle: Notify,
    started: AtomicBool,
    accepting: AtomicBool,
    active_runs: AtomicUsize,
}

impl RunSupervisor {
    fn new() -> Self {
        Self {
            permits: Arc::new(Semaphore::new(MAX_CONCURRENT_TOP_LEVEL_RUNS)),
            app_permits: Arc::new(Semaphore::new(MAX_CONCURRENT_TOP_LEVEL_APP_RUNS)),
            wake: Notify::new(),
            idle: Notify::new(),
            started: AtomicBool::new(false),
            accepting: AtomicBool::new(true),
            active_runs: AtomicUsize::new(0),
        }
    }

    fn start(&'static self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        AsyncHandler::spawn(move || async move {
            loop {
                self.dispatch_available_runs().await;
                self.wake.notified().await;
            }
        });
        self.wake.notify_one();
    }

    fn notify(&self) {
        if self.accepting.load(Ordering::Acquire) {
            self.wake.notify_one();
        }
    }

    async fn shutdown(&self) {
        self.accepting.store(false, Ordering::Release);
        self.wake.notify_waiters();
        // Let native tasks flush their final events before Tauri exits. The
        // timeout bounds shutdown when an external model or process ignores
        // cancellation; OS process teardown remains the final safeguard.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let notified = self.idle.notified();
                if self.active_runs.load(Ordering::Acquire) == 0 {
                    break;
                }
                notified.await;
            }
        })
        .await;
    }

    async fn dispatch_available_runs(&'static self) {
        loop {
            if !self.accepting.load(Ordering::Acquire) {
                return;
            }
            let permit = match Arc::clone(&self.permits).try_acquire_owned() {
                Ok(permit) => permit,
                Err(_) => return,
            };
            // Reserve an App slot before claiming. When all App slots are full,
            // SQLite can still select a queued Workflow rather than marking an
            // App as running while it waits for an in-memory permit.
            let available_app_permit = Arc::clone(&self.app_permits).try_acquire_owned().ok();
            let run_id = match RunHistoryStore::claim_next_queued_run(available_app_permit.is_some()).await {
                Ok(Some(run_id)) => run_id,
                Ok(None) => return,
                Err(error) => {
                    log::error!("failed to claim queued run: {error:#}");
                    return;
                },
            };
            let claimed = match RunHistoryStore::inspect(&run_id).await {
                Ok(run) => run,
                Err(error) => {
                    log::error!("failed to inspect claimed run {run_id}: {error:#}");
                    return;
                },
            };
            let app_permit = (claimed.summary.target_type == "app")
                .then_some(available_app_permit)
                .flatten();
            publish_run_status(&run_id, RunStatus::Running).ok();
            self.active_runs.fetch_add(1, Ordering::AcqRel);
            AsyncHandler::spawn(move || async move {
                execute_claimed_run(&run_id).await;
                drop(permit);
                drop(app_permit);
                self.active_runs.fetch_sub(1, Ordering::AcqRel);
                self.idle.notify_waiters();
                RunManager::global().supervisor.notify();
            });
        }
    }
}

/// Called only after the database has completed migration and recovery. Recovery
/// marks incomplete records interrupted, so this only dispatches new user work.
pub fn start_supervisor() {
    RunManager::global().start_supervisor();
}

pub async fn shutdown_supervisor() {
    RunManager::global().supervisor.shutdown().await;
}

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
    RunHistoryStore::create(CreateRunRecord {
        id: request.run_id.clone(),
        target_type: RunTargetType::App,
        target_id: request.target_id.clone(),
        target_name: request.target_name,
        status: RunStatus::Queued,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: None,
        output_view: request.output_view,
        target_snapshot: request.target_snapshot,
        runtime: json!({ "kind": "app" }),
    })
    .await?;
    publish_run_status(&request.run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
    Ok(())
}

/// Stop an App and its descendants, then let pipe readers drain before the
/// cancellation becomes durable. That preserves output emitted just before the
/// operating system delivered the termination signal.
pub async fn cancel_running_app(run_id: &str) -> Result<()> {
    let active_handle = { RunManager::global().app_runs.lock().get(run_id).cloned() };
    let handle = match active_handle {
        Some(handle) => handle,
        None => {
            let run = RunHistoryStore::inspect(run_id).await?;
            if run.summary.target_type == "app" && run.summary.status == "queued" {
                RunHistoryStore::cancel_queued_run(run_id).await?;
                publish_run_status(run_id, RunStatus::Cancelled)?;
                return Ok(());
            }
            return reconcile_inactive_app_run(run_id).await;
        },
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
    RunHistoryStore::create(CreateRunRecord {
        id: request.run_id.clone(),
        target_type: RunTargetType::Workflow,
        target_id: request.target_id,
        target_name: request.target_name,
        status: RunStatus::Queued,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: Some(request.input),
        output_view: request.output_view,
        target_snapshot: request.target_snapshot,
        runtime,
    })
    .await?;
    publish_run_status(&request.run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
    Ok(())
}

/// Creates a fresh queued execution from an immutable terminal history entry.
/// It intentionally does not try to revive a process or workflow checkpoint
/// that disappeared with the previous native process.
pub async fn replay_run(source_run_id: &str) -> Result<RunRecordSummary> {
    let source = RunHistoryStore::inspect(source_run_id).await?;
    let target_type = replay_target_type(&source.summary.target_type)?;
    if !matches!(
        source.summary.status.as_str(),
        "completed" | "failed" | "cancelled" | "interrupted"
    ) {
        bail!("only a finished run can be replayed");
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let output_view = replay_output_view(target_type);
    RunHistoryStore::create(CreateRunRecord {
        id: run_id.clone(),
        target_type,
        target_id: source.summary.target_id,
        target_name: source.summary.target_name,
        status: RunStatus::Queued,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: source.input,
        output_view,
        target_snapshot: source.target_snapshot,
        runtime: replay_runtime(source.runtime, source_run_id)?,
    })
    .await?;
    publish_run_status(&run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
    Ok(RunHistoryStore::inspect(&run_id).await?.summary)
}

fn replay_output_view(target_type: RunTargetType) -> Value {
    match target_type {
        // Workflow history restores this snapshot before replaying its event
        // journal, so its collection fields must exist even before node events.
        RunTargetType::Workflow => json!({
            "status": "running",
            "nodes": [],
            "messages": [],
            "thoughts": [],
            "processLogs": [],
            "execution": [],
        }),
        RunTargetType::App => json!({}),
    }
}

fn replay_target_type(target_type: &str) -> Result<RunTargetType> {
    match target_type {
        "workflow" => Ok(RunTargetType::Workflow),
        "app" => Ok(RunTargetType::App),
        _ => bail!("unsupported run target type: {target_type}"),
    }
}

fn replay_runtime(mut runtime: Value, source_run_id: &str) -> Result<Value> {
    let object = runtime.as_object_mut().context("run runtime metadata is invalid")?;
    // A replay starts from the original recipe, but never from its checkpoint.
    // The thread ID namespaces persisted graph state, so it must also be new.
    object.remove("resume");
    object.remove("toolConfirmation");
    if object.contains_key("threadId") {
        object.insert("threadId".to_string(), json!(uuid::Uuid::new_v4()));
    }
    object.insert("replayOf".to_string(), json!(source_run_id));
    Ok(runtime)
}

#[cfg(test)]
mod replay_tests {
    use super::{replay_output_view, replay_runtime};
    use serde_json::json;

    #[test]
    fn replay_runtime_preserves_recipe_and_clears_checkpoint_controls() {
        let runtime = replay_runtime(
            json!({
                "kind": "workflow",
                "dsl": { "nodes": [] },
                "resume": true,
                "toolConfirmation": { "approved": true },
            }),
            "old-run",
        )
        .unwrap();

        assert_eq!(runtime["dsl"], json!({ "nodes": [] }));
        assert_eq!(runtime["replayOf"], "old-run");
        assert!(runtime.get("resume").is_none());
        assert!(runtime.get("toolConfirmation").is_none());
    }

    #[test]
    fn replay_runtime_uses_a_new_workflow_state_thread() {
        let runtime = replay_runtime(json!({ "kind": "workflow", "threadId": "original-thread" }), "old-run").unwrap();

        assert_ne!(runtime["threadId"], "original-thread");
    }

    #[test]
    fn replayed_workflow_starts_with_a_restorable_output_view() {
        let view = replay_output_view(super::RunTargetType::Workflow);

        assert_eq!(view["status"], "running");
        assert_eq!(view["nodes"], json!([]));
        assert_eq!(view["messages"], json!([]));
        assert_eq!(view["thoughts"], json!([]));
        assert_eq!(view["processLogs"], json!([]));
        assert_eq!(view["execution"], json!([]));
    }
}

/// Resume a checkpointed workflow without asking the original React component
/// to keep its DSL or event channel alive.
pub async fn resume_workflow(request: ResumeWorkflowRun) -> Result<()> {
    let record = RunHistoryStore::inspect(&request.run_id).await?;
    if record.summary.target_type != "workflow" || record.summary.status != "waiting_for_input" {
        bail!("only a workflow waiting for input can be resumed");
    }
    let runtime = workflow_resume_runtime(record.runtime, request.tool_confirmation)?;
    RunHistoryStore::enqueue_workflow_resume(&request.run_id, runtime).await?;
    publish_run_status(&request.run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
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
    let session = if let Some(session) = RunManager::global()
        .workflow_sessions
        .lock()
        .get(&action.run_id)
        .cloned()
    {
        session
    } else {
        let session = workflow_session_from_runtime(&record.runtime)?;
        RunManager::global()
            .workflow_sessions
            .lock()
            .insert(action.run_id.clone(), session.clone());
        session
    };
    let tool_confirmation = apply_pending_action_checkpoint(&session, &action, &request.resolution).await?;
    let runtime = workflow_resume_runtime(record.runtime, tool_confirmation)?;
    RunHistoryStore::resolve_claimed_action_and_enqueue(&action.id, &request.claimant_id, request.resolution, runtime)
        .await?;
    // The checkpoint is already applied above. The durable recipe now tells the
    // dispatcher to continue it when a top-level execution permit is available.
    drop(session);
    publish_run_status(&action.run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
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
    if run.summary.target_type == "workflow" && run.summary.status == "queued" {
        RunHistoryStore::cancel_queued_run(run_id).await?;
        publish_run_status(run_id, RunStatus::Cancelled)?;
        return Ok(());
    }
    if run.summary.target_type == "workflow" && run.summary.status == "running" {
        let cancellation = RunManager::global()
            .workflow_cancellations
            .lock()
            .get(run_id)
            .cloned()
            .context("workflow run has not reached a cancellable execution point")?;
        cancellation.cancel();
        return Ok(());
    }
    if run.summary.target_type != "workflow" || run.summary.status != "waiting_for_input" {
        bail!("only a workflow waiting for input can be cancelled");
    }
    RunManager::global().workflow_sessions.lock().remove(run_id);
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

async fn execute_claimed_run(run_id: &str) {
    let result = async {
        let record = RunHistoryStore::inspect(run_id).await?;
        match record.summary.target_type.as_str() {
            "app" => execute_claimed_app(run_id, &record.summary.target_id).await,
            "workflow" => execute_claimed_workflow(run_id, record.runtime).await,
            target_type => bail!("unsupported queued run target type: {target_type}"),
        }
    }
    .await;
    if let Err(error) = result {
        let message = error.to_string();
        if publish_error(run_id, &message).await.is_err() {
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

async fn execute_claimed_workflow(run_id: &str, runtime: Value) -> Result<()> {
    let session = workflow_session_from_runtime(&runtime)?;
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
    let result = execute_workflow(run_id, session, resume, tool_confirmation, cancellation).await;
    RunManager::global().workflow_cancellations.lock().remove(run_id);
    result
}

fn workflow_resume_runtime(
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
                if let Ok(event) = serde_json::to_value(workflow::redact_event_for_transport(event)) {
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
        RunManager::global().workflow_sessions.lock().remove(run_id);
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

async fn persist_events(run_id: String, mut receiver: mpsc::UnboundedReceiver<Value>) -> Result<bool> {
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
    emit_on_main_thread(
        "run-status-changed",
        RunStatusChange {
            run_id: run_id.to_string(),
            status,
        },
    )
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
