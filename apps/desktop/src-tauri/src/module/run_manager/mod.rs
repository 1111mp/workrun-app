//! Native ownership of long-running workflow sessions.

use crate::{
    config::Config,
    core::handle,
    module::{
        python_runtime::PythonOutputChunk,
        run_history::{
            AppendRunEvents, CreatePendingAction, CreateRunRecord, NewRunEvent, RunHistoryStore, RunRecordSummary,
            RunStatus, RunTargetType,
        },
        workflow::{self as workflow_module, ToolConfirmationDecisionRequest, WorkflowDsl},
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

mod app;
mod events;
mod execution;
mod workflow;

use events::{publish_run_status, terminate_process_tree};
use execution::execute_claimed_run;

pub use app::{cancel_running_app, start_app};
pub use workflow::{cancel_waiting_workflow, replay_run, resolve_workflow_action, resume_workflow, start_workflow};

#[cfg(test)]
mod tests;
