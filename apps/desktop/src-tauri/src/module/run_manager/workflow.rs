use super::events::{finish_run, publish_run_status, publish_transient_event, publish_value_event};
use super::execution::workflow_resume_runtime;
use super::*;
use crate::{
    config::Config,
    core::db::DBManager,
    module::chat_session::ChatSessionStore,
    module::process_node::{ProcessNodeInstallStatus, ProcessNodeRegistry},
};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingReplayDependency {
    pub remote_app_id: String,
    pub release_id: String,
    pub version: String,
    pub archive_sha256: String,
    pub installation_scope: String,
}

pub async fn start_workflow(mut request: StartWorkflowRun) -> Result<()> {
    if request.run_id.trim().is_empty() || request.thread_id.trim().is_empty() {
        bail!("run id and thread id are required");
    }
    if let Some(session_id) = request.chat_session_id.as_deref() {
        let session = ChatSessionStore::get(session_id).await?;
        let snapshot = session
            .workflow_snapshot
            .as_ref()
            .context("chat session workflow snapshot is missing")?;
        // A conversation must not silently adopt edits made after it began.
        // The session record is authoritative even if another renderer sends
        // a newer workflow document alongside this turn.
        request.dsl = snapshot
            .get("dsl")
            .cloned()
            .filter(Value::is_object)
            .context("chat session workflow DSL is invalid")?;
        request.target_snapshot = snapshot
            .get("document")
            .cloned()
            .filter(Value::is_object)
            .context("chat session workflow document is invalid")?;
        request.target_name = snapshot
            .get("targetName")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .map(str::to_owned)
            .context("chat session workflow name is invalid")?;
        request.release_id = snapshot.get("releaseId").and_then(Value::as_str).map(str::to_owned);
        request.release_version = snapshot
            .get("releaseVersion")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let fields = session_state_fields(&request.dsl)?;
        apply_session_state(&mut request.initial_state, &session.state, &fields)?;
        let compacts_context = ChatSessionStore::will_compact(session_id).await?;
        if compacts_context {
            publish_transient_event(
                &request.run_id,
                json!({ "type": "custom", "node": "workrun", "event_type": "workflow.context_compaction", "data": { "stage": "summarizing" } }),
            )?;
        }
        // The renderer's transcript is a view, not the durable source of context.
        // Replace it with Workrun-owned memory so restored and live chats agree.
        request.initial_state["conversation"] = ChatSessionStore::context_for_next_turn(session_id).await?;
        if compacts_context {
            let stage = ChatSessionStore::get(session_id).await?.summary_status;
            publish_transient_event(
                &request.run_id,
                json!({ "type": "custom", "node": "workrun", "event_type": "workflow.context_compaction", "data": { "stage": stage } }),
            )?;
        }
    }
    if let Some(schema) = request.dsl.get("inputSchema") {
        crate::module::artifact::validate_input(schema, &request.initial_state)?;
    }
    let store = crate::module::artifact::ArtifactStore::active()?;
    let references = crate::module::artifact::references(&request.initial_state)?;
    tokio::task::spawn_blocking(move || -> Result<()> {
        for reference in references {
            store.resolve(&reference)?;
        }
        Ok(())
    })
    .await??;
    // Persist the immutable Team App coordinates separately from the executable
    // local IDs. Replay and cache cleanup must not infer these from a mutable catalog.
    let release_or_draft = request
        .release_id
        .clone()
        .unwrap_or_else(|| format!("draft-{}", request.target_id));
    let installation_scope = format!("release-{release_or_draft}");
    let dependencies = team_app_dependencies(&request.dsl, &installation_scope);
    let chat_message = request.input.get("input").and_then(Value::as_str).map(str::to_owned);
    let runtime = json!({
        "kind": "workflow",
        "compensationJournalVersion": 1,
        "processCleanupVersion": 1,
        "remoteLifecycleVersion": 1,
        "executionId": request.run_id,
        "dsl": request.dsl,
        "threadId": request.thread_id,
        "chatSessionId": request.chat_session_id,
        "initialState": request.initial_state,
        "evaluationProfile": request.evaluation_profile,
        "evaluationResultId": request.evaluation_result_id,
        "releaseId": request.release_id,
        "releaseVersion": request.release_version,
        "dependencies": dependencies,
        "trigger": request.schedule_trigger.map(|trigger| json!({
            "type": "schedule",
            "scheduleId": trigger.schedule_id,
            "scheduledFor": trigger.scheduled_for,
        })),
    });
    let record = CreateRunRecord {
        id: request.run_id.clone(),
        target_type: RunTargetType::Workflow,
        target_id: request.target_id,
        target_name: request.target_name,
        status: RunStatus::Queued,
        started_at: chrono::Utc::now().to_rfc3339(),
        input: Some(request.input),
        // Workflow output is reconstructed exclusively from its event log.
        // The shared run-record column remains for App run output.
        output_view: json!({}),
        target_snapshot: request.target_snapshot,
        runtime,
    };
    if let (Some(session_id), Some(turn_id), Some(message)) = (
        request.chat_session_id.as_deref(),
        request.chat_turn_id.as_deref(),
        chat_message.as_deref(),
    ) {
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
        ChatSessionStore::ensure_turn_available(&mut transaction, session_id).await?;
        crate::module::run_history::create_in_transaction(&mut transaction, &record).await?;
        let sequence: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(sequence), -1) + 1 FROM chat_turns WHERE session_id = ?")
                .bind(session_id)
                .fetch_one(&mut *transaction)
                .await?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("INSERT INTO chat_turns (id, session_id, run_id, sequence, user_message, status, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?)").bind(turn_id).bind(session_id).bind(&request.run_id).bind(sequence).bind(message).bind(&now).execute(&mut *transaction).await?;
        sqlx::query("UPDATE chat_sessions SET active_run_id = ?, updated_at = ? WHERE id = ?")
            .bind(&request.run_id)
            .bind(&now)
            .bind(session_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
    } else {
        RunHistoryStore::create(record).await?;
    }
    publish_run_status(&request.run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
    Ok(())
}

fn session_state_fields(dsl: &Value) -> Result<Vec<String>> {
    let values = dsl
        .get("sessionStateFields")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let sensitive = dsl.pointer("/inputSchema/sensitiveFields").and_then(Value::as_array);
    let fields: Vec<String> = values
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .filter(|key| {
                    !key.is_empty() && !key.contains('.') && !matches!(*key, "input" | "messages" | "conversation")
                })
                .map(str::to_string)
                .context("session state fields must be non-reserved top-level keys")
        })
        .collect::<Result<_>>()?;
    if fields
        .iter()
        .any(|key| sensitive.is_some_and(|values| values.iter().any(|value| value.as_str() == Some(key))))
    {
        bail!("sensitive inputs cannot be session state fields");
    }
    if fields.len() != fields.iter().collect::<std::collections::HashSet<_>>().len() {
        bail!("session state fields must be unique");
    }
    Ok(fields)
}

fn apply_session_state(initial_state: &mut Value, saved_state: &Value, fields: &[String]) -> Result<()> {
    let saved = saved_state
        .as_object()
        .context("chat session state must be an object")?;
    let input = initial_state
        .as_object_mut()
        .context("workflow initial state must be an object")?;
    // The configured allowlist is the only bridge across runs. Conversation
    // text is separate prompt context and must never silently become State.
    for key in fields {
        if !input.contains_key(key)
            && let Some(value) = saved.get(key)
        {
            input.insert(key.clone(), value.clone());
        }
    }
    Ok(())
}

#[cfg(test)]
mod session_state_tests {
    use super::{apply_session_state, session_state_fields};
    use serde_json::json;

    #[test]
    fn accepts_explicit_top_level_global_keys() {
        assert_eq!(
            session_state_fields(&json!({"sessionStateFields": ["customerId", "draft"]})).unwrap(),
            ["customerId", "draft"]
        );
    }

    #[test]
    fn rejects_reserved_sensitive_and_duplicate_keys() {
        for dsl in [
            json!({"sessionStateFields": ["conversation"]}),
            json!({"sessionStateFields": ["customer.email"]}),
            json!({"inputSchema": {"sensitiveFields": ["token"]}, "sessionStateFields": ["token"]}),
            json!({"sessionStateFields": ["draft", "draft"]}),
        ] {
            assert!(session_state_fields(&dsl).is_err());
        }
    }

    #[test]
    fn does_not_restore_values_when_no_session_fields_are_configured() {
        let mut initial = json!({
            "input": "Was order 43 cancelled?",
            "conversation": {"recentMessages": [{"role": "user", "content": "Cancel order 43"}]}
        });
        apply_session_state(&mut initial, &json!({"orderId": "43"}), &[]).unwrap();

        assert_eq!(initial.get("orderId"), None);
        assert_eq!(
            initial["conversation"]["recentMessages"][0]["content"],
            "Cancel order 43"
        );
    }

    #[test]
    fn restores_only_explicit_session_fields_and_preserves_current_input() {
        let mut initial = json!({"input": "Was it cancelled?", "orderId": "44"});
        apply_session_state(
            &mut initial,
            &json!({"orderId": "43", "customerId": "customer-1"}),
            &["orderId".to_string()],
        )
        .unwrap();

        assert_eq!(initial["orderId"], "44");
        assert_eq!(initial.get("customerId"), None);

        initial.as_object_mut().unwrap().remove("orderId");
        apply_session_state(
            &mut initial,
            &json!({"orderId": "43", "customerId": "customer-1"}),
            &["orderId".to_string()],
        )
        .unwrap();
        assert_eq!(initial["orderId"], "43");
        assert_eq!(initial.get("customerId"), None);
    }
}

fn team_app_dependencies(dsl: &Value, installation_scope: &str) -> Vec<Value> {
    let mut dependencies = std::collections::BTreeMap::new();
    let Some(nodes) = dsl.get("nodes").and_then(Value::as_array) else {
        return Vec::new();
    };
    for node in nodes {
        let Some(data) = node.get("data").and_then(Value::as_object) else {
            continue;
        };
        let Some(app_ref) = data.get("appRef").and_then(Value::as_object) else {
            continue;
        };
        let (Some(remote_app_id), Some(release_id), Some(version), Some(archive_sha256)) = (
            app_ref.get("remoteAppId").and_then(Value::as_str),
            app_ref.get("releaseId").and_then(Value::as_str),
            app_ref.get("version").and_then(Value::as_str),
            app_ref.get("archiveSha256").and_then(Value::as_str),
        ) else {
            continue;
        };
        if app_ref.get("source").and_then(Value::as_str) != Some("team") {
            continue;
        }
        dependencies.insert(
            format!("{remote_app_id}:{release_id}:{archive_sha256}"),
            json!({
                "remoteAppId": remote_app_id,
                "releaseId": release_id,
                "version": version,
                "archiveSha256": archive_sha256,
                "installationScope": installation_scope,
                "localAppId": data.get("processNodeId").cloned(),
            }),
        );
    }
    dependencies.into_values().collect()
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
    ensure_replay_dependencies_installed(&source.runtime).await?;
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

/// Continue the same business task; attempts and event sequences are append-only.
pub async fn retry_failed_workflow(source_run_id: &str) -> Result<RunRecordSummary> {
    recover_workflow(source_run_id, false).await
}

pub(super) async fn recover_workflow(run_id: &str, automatic: bool) -> Result<RunRecordSummary> {
    let source = RunHistoryStore::inspect(run_id).await?;
    if source.summary.target_type != "workflow" || !matches!(source.summary.status.as_str(), "failed" | "interrupted") {
        bail!("only a failed or interrupted workflow can be continued");
    }
    // A finished run can still be flushing its writer/session. Requeue only
    // after its native owner has actually released it.
    if RunManager::global().workflow_cancellations.lock().contains_key(run_id) {
        bail!("The previous execution is still stopping; retry shortly");
    }
    ensure_replay_dependencies_installed(&source.runtime).await?;
    let session = workflow_session_from_runtime(&source.runtime)?;
    let dsl: WorkflowDsl = serde_json::from_value(session.dsl.clone())?;
    let config = BaseConfig::workrun().await.latest_arc();
    let compiled = workflow_module::compile(dsl.clone(), &config, None).await?;
    let pool = crate::core::db::DBManager::global().pool()?;
    let key = crate::utils::dirs::get_encryption_key()?;
    let execution_id = source
        .runtime
        .get("executionId")
        .and_then(Value::as_str)
        .unwrap_or(run_id);
    let workflow_path = if dsl.id.is_empty() {
        Vec::new()
    } else {
        vec![dsl.id.clone()]
    };
    workflow_module::recovery::validate_frontier(
        &compiled,
        &dsl,
        &pool,
        &key,
        execution_id,
        run_id,
        "root",
        &session.thread_id,
        &config,
        workflow_path,
        automatic,
    )
    .await?;
    let mut runtime = workflow_resume_runtime(source.runtime, None)?;
    runtime
        .as_object_mut()
        .unwrap()
        .entry("executionId")
        .or_insert_with(|| json!(run_id));
    RunHistoryStore::enqueue_recovery(run_id, runtime).await?;
    publish_run_status(run_id, RunStatus::Queued)?;
    RunManager::global().supervisor.notify();
    Ok(RunHistoryStore::inspect(run_id).await?.summary)
}

async fn ensure_replay_dependencies_installed(runtime: &Value) -> Result<()> {
    let missing = missing_replay_dependencies(runtime).await?;
    if !missing.is_empty() {
        bail!(
            "Cannot replay because these Team App releases are not installed: {}",
            missing
                .iter()
                .map(|dependency| format!("{} v{}", dependency.remote_app_id, dependency.version))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }
    Ok(())
}

pub async fn replay_missing_dependencies(source_run_id: &str) -> Result<Vec<MissingReplayDependency>> {
    let source = RunHistoryStore::inspect(source_run_id).await?;
    missing_replay_dependencies(&source.runtime).await
}

async fn missing_replay_dependencies(runtime: &Value) -> Result<Vec<MissingReplayDependency>> {
    let Some(dependencies) = runtime.get("dependencies").and_then(Value::as_array) else {
        // Runs created before immutable Team App references were introduced
        // retain their legacy replay behavior.
        return Ok(Vec::new());
    };
    let installed = Config::team_process_nodes().await.data_arc().get_process_nodes();
    let mut missing = Vec::new();
    for dependency in dependencies {
        let (Some(remote_app_id), Some(release_id), Some(archive_sha256), Some(installation_scope)) = (
            dependency.get("remoteAppId").and_then(Value::as_str),
            dependency.get("releaseId").and_then(Value::as_str),
            dependency.get("archiveSha256").and_then(Value::as_str),
            dependency.get("installationScope").and_then(Value::as_str),
        ) else {
            continue;
        };
        let available = installed.iter().find(|node| {
            node.remote_app_id.as_deref() == Some(remote_app_id)
                && node.remote_release_id.as_deref() == Some(release_id)
                && node.remote_archive_sha256.as_deref() == Some(archive_sha256)
                && node.team_installation_scope.as_deref() == Some(installation_scope)
        });
        let is_ready = match available {
            Some(node) => matches!(
                ProcessNodeRegistry::with_installation(node.clone())
                    .await
                    .install_status,
                ProcessNodeInstallStatus::Installed
            ),
            None => false,
        };
        if !is_ready {
            missing.push(MissingReplayDependency {
                remote_app_id: remote_app_id.to_string(),
                release_id: release_id.to_string(),
                version: dependency
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or(release_id)
                    .to_string(),
                archive_sha256: archive_sha256.to_string(),
                installation_scope: installation_scope.to_string(),
            });
        }
    }
    Ok(missing)
}

fn replay_output_view(target_type: RunTargetType) -> Value {
    match target_type {
        RunTargetType::Workflow => json!({}),
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
    object.insert("executionId".to_string(), json!(uuid::Uuid::new_v4().to_string()));
    if object.get("kind").and_then(Value::as_str) == Some("workflow") {
        object.insert("compensationJournalVersion".to_string(), json!(1));
    }
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
    use super::{replay_output_view, replay_runtime, team_app_dependencies};
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
        assert_eq!(runtime["compensationJournalVersion"], 1);
        assert!(runtime.get("resume").is_none());
        assert!(runtime.get("toolConfirmation").is_none());
    }

    #[test]
    fn replay_runtime_uses_a_new_workflow_state_thread() {
        let runtime = replay_runtime(json!({ "kind": "workflow", "threadId": "original-thread" }), "old-run").unwrap();

        assert_ne!(runtime["threadId"], "original-thread");
    }

    #[test]
    fn replayed_workflow_starts_with_an_empty_output_cache() {
        let view = replay_output_view(super::RunTargetType::Workflow);

        assert_eq!(view, json!({}));
    }

    #[test]
    fn runtime_dependencies_preserve_team_release_and_local_execution_id() {
        let dependencies = team_app_dependencies(
            &json!({
                "nodes": [{
                    "data": {
                        "processNodeId": "local-app-1",
                        "appRef": {
                            "source": "team",
                            "remoteAppId": "remote-app-1",
                            "releaseId": "release-1",
                            "version": "1.2.3",
                            "archiveSha256": "abc"
                        }
                    }
                }]
            }),
            "release-release-1",
        );
        assert_eq!(
            dependencies,
            vec![json!({
                "remoteAppId": "remote-app-1",
                "releaseId": "release-1",
                "version": "1.2.3",
                "archiveSha256": "abc",
                "installationScope": "release-release-1",
                "localAppId": "local-app-1",
            })]
        );
    }

    #[test]
    fn recovery_runtime_keeps_thread_and_business_identity() {
        let runtime =
            super::workflow_resume_runtime(json!({"threadId":"original-thread", "executionId":"task-1"}), None)
                .unwrap();
        assert_eq!(runtime["threadId"], "original-thread");
        assert_eq!(runtime["executionId"], "task-1");
        assert_eq!(runtime["resume"], true);
        assert_ne!(replay_runtime(runtime, "task-1").unwrap()["executionId"], "task-1");
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

/// Persist authorization before sending local Stop. The worker repeats Stop
/// after startup if the process exited in that window.
pub async fn abandon_workflow(run_id: &str) -> Result<()> {
    let pool = DBManager::global().pool()?;
    workflow_module::saga_scheduler::request(&pool, run_id).await?;
    let record = RunHistoryStore::inspect(run_id).await?;
    if matches!(record.summary.status.as_str(), "running" | "waiting_for_input") {
        let _ = cancel_waiting_workflow(run_id).await;
    }
    RunManager::global().supervisor.notify();
    let record = RunHistoryStore::inspect(run_id).await?;
    let status = serde_json::from_value::<RunStatus>(json!(record.summary.status))?;
    publish_run_status(run_id, status).ok();
    Ok(())
}

pub async fn retry_workflow_compensation(run_id: &str) -> Result<()> {
    workflow_module::saga_scheduler::retry(&DBManager::global().pool()?, run_id).await?;
    RunManager::global().supervisor.notify();
    Ok(())
}

/// Manual evidence changes operation facts, never the original execution status.
pub async fn review_operation(request: workflow_module::operation_review::ReviewRequest) -> Result<()> {
    let pool = DBManager::global().pool()?;
    let key = crate::utils::dirs::get_encryption_key()?;
    workflow_module::operation_review::resolve(&pool, &key, &request, |result| {
        let refs = crate::module::artifact::references(result)?;
        if !refs.is_empty() {
            let store = crate::module::artifact::ArtifactStore::active()?;
            for reference in refs {
                store.resolve(&reference)?;
            }
        }
        Ok(())
    })
    .await?;
    RunManager::global().supervisor.notify();
    Ok(())
}

pub async fn approve_compensation(run_id: &str, approval_id: &str, approved: bool) -> Result<()> {
    workflow_module::operation_review::decide_approval(&DBManager::global().pool()?, run_id, approval_id, approved)
        .await?;
    RunManager::global().supervisor.notify();
    Ok(())
}
