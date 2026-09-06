use super::events::{finish_run, publish_run_status, publish_value_event};
use super::execution::workflow_resume_runtime;
use super::*;

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
            workflow_module::resolve_human_review_checkpoint(
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
            workflow_module::resolve_ask_user_question_checkpoint(
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

pub(super) fn workflow_session_from_runtime(runtime: &Value) -> Result<WorkflowSession> {
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
