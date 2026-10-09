//! Native ownership of long-running workflow sessions.

use crate::{
    config::BaseConfig,
    core::handle,
    module::{
        python_runtime::PythonOutputChunk,
        run_history::{
            AppendRunEvents, CreatePendingAction, CreateRunRecord, CreateRunSpan, FinishRunSpan, NewRunEvent,
            RunHistoryStore, RunRecordSummary, RunStatus, RunTargetType, TelemetrySpanKind, TelemetrySpanStatus,
        },
        workflow::{self as workflow_module, EvaluationExecutionProfile, ToolConfirmationDecisionRequest, WorkflowDsl},
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
                if !self.accepting.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = super_recovery_tick().await {
                    log::warn!("recovery scheduler: {error:#}");
                }
                self.dispatch_compensation().await;
                self.dispatch_available_runs().await;
                tokio::select! {
                    _ = self.wake.notified() => {},
                    _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                }
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

    async fn dispatch_compensation(&'static self) {
        if !self.accepting.load(Ordering::Acquire) {
            return;
        }
        let Ok(permit) = Arc::clone(&self.permits).try_acquire_owned() else {
            return;
        };
        let Ok(pool) = crate::core::db::DBManager::global().pool() else {
            return;
        };
        if let Ok(key) = crate::utils::dirs::get_encryption_key()
            && let Err(error) = workflow_module::process_cleanup::recover_failed(&pool, &key).await
        {
            log::warn!("Failed to schedule App cleanup: {error:#}");
        }

        let run_id = match workflow_module::saga_scheduler::claim(&pool).await {
            Ok(Some(id)) => id,
            Ok(None) => return,
            Err(error) => {
                log::warn!("compensation claim: {error:#}");
                return;
            },
        };
        // Shutdown can begin while SQLite is claiming. Keep the durable claim
        // for startup recovery rather than starting external work after exit.
        if !self.accepting.load(Ordering::Acquire) {
            return;
        }
        self.active_runs.fetch_add(1, Ordering::AcqRel);
        AsyncHandler::spawn(move || async move {
            let result = async {
                // Reissue local Stop after a crash between durable abandonment
                // and cancellation. Compensation starts only after owners stop.
                let record = RunHistoryStore::inspect(&run_id).await?;
                if matches!(record.summary.status.as_str(), "running" | "waiting_for_input") {
                    let _ = workflow::cancel_waiting_workflow(&run_id).await;
                }
                let key = crate::utils::dirs::get_encryption_key()?;
                workflow_module::saga_scheduler::tick(pool, key, &run_id).await
            }
            .await;
            if result.is_err() {
                log::warn!("compensation worker blocked for {run_id}");
                let _ = workflow_module::saga_scheduler::block_claim(&run_id).await;
            }
            if let Ok(record) = RunHistoryStore::inspect(&run_id).await
                && let Ok(status) = serde_json::from_value::<RunStatus>(json!(record.summary.status))
            {
                publish_run_status(&run_id, status).ok();
            }
            drop(permit);
            self.active_runs.fetch_sub(1, Ordering::AcqRel);
            self.idle.notify_waiters();
            self.notify();
        });
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
            if let Err(error) =
                crate::module::chat_session::ChatSessionStore::set_turn_status(&run_id, RunStatus::Running).await
            {
                log::warn!("failed to mark chat turn running for {run_id}: {error:#}");
            }
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

async fn super_recovery_tick() -> Result<()> {
    let pool = crate::core::db::DBManager::global().pool()?;
    let Some(id) = crate::module::run_history::recovery::claim_recovery(&pool).await? else {
        return Ok(());
    };
    if let Err(error) = workflow::recover_workflow(&id, true).await {
        crate::module::run_history::recovery::block_job(&pool, &id, &error.to_string()).await?;
        let status = RunHistoryStore::inspect(&id).await?.summary.status;
        if matches!(status.as_str(), "failed" | "interrupted") {
            publish_run_status(
                &id,
                if status == "interrupted" {
                    RunStatus::Interrupted
                } else {
                    RunStatus::Failed
                },
            )
            .ok();
        }
    }
    Ok(())
}

/// Called only after the database has completed migration and recovery. Recovery
/// marks incomplete records interrupted; journaled operations are reconciled
/// by persisted recovery jobs before the original task is requeued.
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
    pub target_snapshot: Value,
    pub release_id: Option<String>,
    pub release_version: Option<String>,
    pub dsl: Value,
    pub initial_state: Value,
    pub thread_id: String,
    #[serde(default)]
    pub chat_session_id: Option<String>,
    #[serde(default)]
    pub chat_turn_id: Option<String>,
    /// Present only for an Evaluation Case. Its fixtures are persisted in the
    /// run runtime snapshot and never supplied by a normal editor run.
    pub evaluation_profile: Option<EvaluationExecutionProfile>,
    /// Links a durable workflow Run back to its Case. Persist this in the Run
    /// runtime so a very fast completion can recover the link before the
    /// evaluation coordinator has finished its follow-up database update.
    pub evaluation_result_id: Option<String>,
    #[serde(default)]
    pub schedule_trigger: Option<ScheduleTrigger>,
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
    #[serde(default)]
    pub schedule_trigger: Option<ScheduleTrigger>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTrigger {
    pub schedule_id: String,
    pub scheduled_for: String,
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

mod startup_recovery;
pub(crate) use startup_recovery::StartupRecovery;

mod app;
mod events;
mod execution;
mod workflow;

use events::{publish_run_status, terminate_process_tree};
use execution::execute_claimed_run;

pub use app::{cancel_running_app, start_app};
pub use workflow::{
    MissingReplayDependency, cancel_waiting_workflow, recover_interrupted_workflow, replay_missing_dependencies,
    replay_run, resolve_workflow_action, resume_workflow, review_operation, start_workflow,
};

#[cfg(test)]
mod tests;

pub(crate) use events::emit_cleanup_event;
