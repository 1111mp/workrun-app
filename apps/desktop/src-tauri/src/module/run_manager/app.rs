use super::events::{complete_app_cancellation, finish_run, publish_run_status, terminate_process_tree};
use super::*;

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
