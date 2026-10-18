//! Durable native conversation owner. Renderer disconnection never dispatches or
//! cancels an operation; reattachment observes the saved run identity.
use super::{
    AssistantRequest, AssistantRuntime,
    catalog::{Catalog, validate_input},
};
use crate::{
    config::{BaseConfig, model_catalog},
    core::db::DBManager,
    module::{
        run_history::RunHistoryStore,
        run_manager::{self, StartWorkflowRun},
        workflow::agent::create_model_with_thinking,
    },
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::{collections::HashSet, sync::LazyLock, time::Duration};
use tauri::Emitter;

static OWNERS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));
struct Lease(String);
impl Drop for Lease {
    fn drop(&mut self) {
        OWNERS.lock().remove(&self.0);
    }
}
fn acquire(workspace: &str, id: &str) -> Result<Lease> {
    let key = format!("{workspace}/{id}");
    if !OWNERS.lock().insert(key.clone()) {
        bail!("This conversation already has an active native turn");
    }
    Ok(Lease(key))
}
fn running(workspace: &str, id: &str) -> bool {
    OWNERS.lock().contains(&format!("{workspace}/{id}"))
}
fn ensure_workspace(workspace: &str) -> Result<()> {
    if dirs::active_workspace_id() != workspace {
        bail!("Workspace changed; reopen the conversation in its workspace");
    }
    Ok(())
}

pub async fn save(pool: &SqlitePool, workspace: &str, session: &Value) -> Result<()> {
    let id = session["id"].as_str().context("session ID is missing")?;
    uuid::Uuid::parse_str(id).context("invalid session ID")?;
    let data = serde_json::to_string(session)?;
    if data.len() > 4 * 1024 * 1024 {
        bail!("conversation is too large; start a new conversation");
    }
    let result=sqlx::query("INSERT INTO assistant_sessions (id, workspace_id, session_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET session_json = excluded.session_json, updated_at = excluded.updated_at WHERE assistant_sessions.workspace_id = excluded.workspace_id")
        .bind(id).bind(workspace).bind(data).bind(chrono::Utc::now().to_rfc3339()).execute(pool).await?;
    if result.rows_affected() != 1 {
        bail!("conversation belongs to another workspace");
    }
    Ok(())
}
pub async fn get(pool: &SqlitePool, workspace: &str, id: &str) -> Result<Value> {
    let source: String =
        sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id = ? AND workspace_id = ?")
            .bind(id)
            .bind(workspace)
            .fetch_optional(pool)
            .await?
            .context("conversation was not found in this workspace")?;
    let mut session: Value = serde_json::from_str(&source)?;
    // A process restart loses inference, but never the run receipt. Active native
    // workers survive renderer reloads and must not be marked interrupted.
    if !running(workspace, id) && matches!(session["status"].as_str(), Some("thinking" | "running")) {
        session["status"] = json!("error");
        session["error"] = json!("Assistant response was interrupted. Continue to retry the response.");
    }
    Ok(session)
}
async fn commit(pool: &SqlitePool, workspace: &str, session: &Value) -> Result<()> {
    save(pool, workspace, session).await?;
    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit(
            "assistant-session-updated",
            json!({"id":session["id"],"workspaceId":workspace}),
        );
    }
    Ok(())
}
/// Hold the same lease as turn dispatch so deletion cannot race a native writer.
pub async fn delete(pool: &SqlitePool, workspace: &str, id: &str) -> Result<()> {
    let _lease = acquire(workspace, id)?;
    let session = get(pool, workspace, id).await?;
    if session["activeCall"].is_object() || !matches!(session["status"].as_str(), Some("idle" | "error")) {
        bail!("Only an idle conversation can be deleted");
    }
    sqlx::query("DELETE FROM assistant_sessions WHERE id = ? AND workspace_id = ?")
        .bind(id)
        .bind(workspace)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn renderer_save(session: Value) -> Result<()> {
    let pool = DBManager::global().pool()?;
    let workspace = dirs::active_workspace_id();
    let _lease = acquire(&workspace, session["id"].as_str().context("session ID is missing")?)?;
    // Renderer writes are limited to creating an empty session or feedback. It
    // cannot forge messages, execution state or overwrite a running native turn.
    let old =
        sqlx::query_scalar::<_, String>("SELECT session_json FROM assistant_sessions WHERE id=? AND workspace_id=?")
            .bind(session["id"].as_str())
            .bind(&workspace)
            .fetch_optional(&pool)
            .await?;
    if let Some(old) = old {
        let mut old: Value = serde_json::from_str(&old)?;
        if !matches!(old["status"].as_str(), Some("idle" | "error")) {
            bail!("Only an idle conversation can be edited");
        }
        let requested = session["messages"].as_array().context("messages are missing")?;
        for message in old["messages"].as_array_mut().context("stored messages are invalid")? {
            if message["role"] == "assistant"
                && let Some(value) = requested.iter().find(|value| value["id"] == message["id"])
            {
                let feedback = value["feedback"].clone();
                if !feedback.is_null() && !matches!(feedback.as_str(), Some("helpful" | "unhelpful")) {
                    bail!("Invalid feedback");
                }
                message["feedback"] = feedback;
            }
        }
        save(&pool, &workspace, &old).await
    } else {
        if session["status"] != "idle"
            || session["activeCall"].is_object()
            || session["messages"]
                .as_array()
                .is_none_or(|messages| !messages.is_empty())
        {
            bail!("New conversations must be empty and idle");
        }
        save(&pool, &workspace, &session).await
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TurnAction {
    Send {
        text: String,
        #[serde(default)]
        attachments: Vec<Value>,
    },
    Continue,
    Inputs {
        input: Value,
    },
    Decline,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub session_id: String,
    pub action: TurnAction,
    pub team_token: Option<String>,
}

pub async fn start(request: TurnRequest) -> Result<Value> {
    let workspace = dirs::active_workspace_id();
    let pool = DBManager::global().pool()?;
    let lease = acquire(&workspace, &request.session_id)?;
    // Read before spawning and acknowledge the durable state. No task is owned by
    // the Tauri invocation future, Channel, component, or webview lifetime.
    let source: String =
        sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id=? AND workspace_id=?")
            .bind(&request.session_id)
            .bind(&workspace)
            .fetch_optional(&pool)
            .await?
            .context("Conversation not found")?;
    let mut session: Value = serde_json::from_str(&source)?;
    let mut input = None;
    match request.action {
        TurnAction::Send { text, attachments } => {
            if session["activeCall"].is_object() || !matches!(session["status"].as_str(), Some("idle" | "error")) {
                bail!("Conversation is busy");
            }
            if text.trim().is_empty() && attachments.is_empty() {
                bail!("Message is empty");
            }
            let content = if attachments.is_empty() {
                text.clone()
            } else {
                format!(
                    "{text}\n\nAttached file references (use these exact objects for file inputs):\n{}",
                    serde_json::to_string(&attachments)?
                )
            };
            session["messages"].as_array_mut().context("messages missing")?.push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"user","text":text,"artifacts":attachments,"content":{"role":"user","parts":[{"text":content}]}}));
            session["steps"] = json!(0);
            session["status"] = json!("thinking");
        },
        TurnAction::Continue => {
            if session["activeCall"].is_object() && !session["activeCall"]["runId"].is_string() {
                session["status"] = json!("needs_input");
            } else {
                session["status"] = json!(if session["activeCall"]["runId"].is_string() {
                    "running"
                } else {
                    "thinking"
                });
            }
        },
        TurnAction::Inputs { input: values } => {
            if session["status"] != "needs_input" || session["activeCall"]["runId"].is_string() {
                bail!("No workflow is awaiting inputs");
            }
            session["activeCall"]["input"] = values.clone();
            session["activeCall"]["inputSources"] = json!({"source":"user_form"});
            input = Some(values);
            session["status"] = json!("thinking");
        },
        TurnAction::Decline => {
            if session["status"] != "needs_input" {
                bail!("No workflow is awaiting inputs");
            }
            append_result(
                &mut session,
                json!({"status":"cancelled","reason":"User cancelled parameter collection"}),
                "cancelled",
            )?;
        },
    }
    session["error"] = Value::Null;
    commit(&pool, &workspace, &session).await?;
    let acknowledged = session.clone();
    tauri::async_runtime::spawn(async move {
        let _lease = lease;
        let result = drive(&pool, &workspace, &mut session, request.team_token.as_deref(), input).await;
        if let Err(error) = result {
            session["status"] = json!("error");
            session["error"] = json!(error.to_string());
            let _ = commit(&pool, &workspace, &session).await;
        }
    });
    Ok(acknowledged)
}

async fn drive(
    pool: &SqlitePool,
    workspace: &str,
    session: &mut Value,
    team_token: Option<&str>,
    input: Option<Value>,
) -> Result<()> {
    ensure_workspace(workspace)?;
    if session["status"] == "needs_input" {
        return Ok(());
    }
    if session["activeCall"]["runId"].is_string() {
        wait(pool, workspace, session).await?;
    } else if let Some(input) = input {
        let catalog = Catalog::load(team_token).await?;
        if !launch(pool, workspace, session, &catalog, input).await? {
            return Ok(());
        }
    }
    loop {
        ensure_workspace(workspace)?;
        let config = BaseConfig::workrun().await.data_arc();
        let model_id = session["modelId"].as_str().context("Model is missing")?.to_owned();
        let definition = model_catalog()
            .into_iter()
            .find(|definition| definition.id == model_id)
            .context("Select a valid assistant model")?;
        let model = create_model_with_thinking(&definition, &config, true)?;
        let runtime = AssistantRuntime::load(&dirs::app_home_dir()?)?;
        let catalog = Catalog::load(team_token).await?;
        let contents = session["messages"]
            .as_array()
            .context("messages missing")?
            .iter()
            .map(|message| serde_json::from_value(message["content"].clone()))
            .collect::<std::result::Result<_, _>>()?;
        let message_id = uuid::Uuid::new_v4().to_string();
        // A workflow receipt starts a new model phase within the same user turn.
        // Its thinking indicator must not reuse discovery summaries from before execution.
        session["responsePhaseId"] = json!(message_id);
        commit(pool, workspace, session).await?;
        let turn_id = session["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "user")
            .map(|message| message["id"].clone())
            .unwrap_or(Value::Null);
        let activities = std::sync::Mutex::new(Vec::<Value>::new());
        let reasoning = std::sync::Mutex::new(Vec::<Value>::new());
        let emit = |event: super::AssistantStreamEvent| {
            let activity = if let super::AssistantStreamEvent::Activity { summary } = &event {
                let activity = json!({"id":uuid::Uuid::new_v4().to_string(),"turnId":turn_id,"phaseId":message_id,"summary":summary});
                activities.lock().unwrap().push(activity.clone());
                Some(activity)
            } else {
                None
            };
            let thought = if let super::AssistantStreamEvent::Reasoning {
                id,
                text,
                duration_ms,
                complete,
            } = &event
            {
                let thought = json!({"id":id,"turnId":turn_id,"phaseId":message_id,"text":text,"durationMs":duration_ms,"complete":complete});
                let mut records = reasoning.lock().unwrap();
                if let Some(record) = records.iter_mut().find(|record| record["id"] == *id) {
                    *record = thought.clone();
                } else {
                    records.push(thought.clone());
                }
                Some(thought)
            } else {
                None
            };
            // Missing observers are harmless; native persistence and execution
            // continue independently of this delivery channel.
            if let Some(app) = crate::APP_HANDLE.get() {
                let _ = app.emit(
                    "assistant-stream",
                    json!({
                        "sessionId": session["id"], "workspaceId": workspace,
                        "messageId": message_id, "event": event, "activity": activity, "reasoning": thought,
                    }),
                );
            }
            Ok(())
        };
        let reply = runtime
            .run_with_discovery(
                model.as_ref(),
                &definition.provider,
                AssistantRequest {
                    context: super::protocol::AssistantContext {
                        session_id: session["id"].as_str().map(str::to_owned),
                        model_profile_id: Some(model_id.to_owned()),
                        artifacts: session["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|message| matches!(message["role"].as_str(), Some("user" | "assistant")))
                            .flat_map(|message| message["artifacts"].as_array().into_iter().flatten())
                            .map(|reference| serde_json::from_value(reference.clone()))
                            .collect::<std::result::Result<Vec<_>, _>>()?,
                    },
                    contents,
                    capabilities: vec![],
                },
                &emit,
                &catalog,
            )
            .await;
        if !session["activities"].is_array() {
            session["activities"] = json!([]);
        }
        session["activities"]
            .as_array_mut()
            .unwrap()
            .extend(activities.into_inner().unwrap());
        if !session["reasoning"].is_array() {
            session["reasoning"] = json!([]);
        }
        session["reasoning"]
            .as_array_mut()
            .unwrap()
            .extend(reasoning.into_inner().unwrap());
        // Persist thinking and public progress even when the model phase fails.
        commit(pool, workspace, session).await?;
        let reply = reply?;
        ensure_workspace(workspace)?;
        session["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":message_id,"role":"assistant","text":reply.text,"content":reply.content,"artifacts":reply.artifacts}));
        if let Some(call) = reply.call {
            let steps = session["steps"].as_u64().unwrap_or(0);
            if steps >= 1 {
                bail!("Another workflow execution requires a new user request");
            }
            let workflow = match catalog.resolve(&call.workflow_id).await {
                Ok(workflow) => workflow,
                Err(error) => {
                    // The catalog may change between discovery and dispatch.
                    // Complete the original function exchange even on deletion.
                    session["activeCall"] = json!({"toolName":call.tool_name,"callId":call.call_id,"workflow":{"document":{"settings":{"name":call.workflow_id}}}});
                    append_result(session, json!({"status":"failed","error":error.to_string()}), "failed")?;
                    commit(pool, workspace, session).await?;
                    continue;
                },
            };
            session["activeCall"] = json!({"workflowId":call.workflow_id,"toolName":call.tool_name,"callId":call.call_id,"input":call.input,"workflow":workflow});
            if call.tool_name == "execute_capability" {
                session["activeCall"]["inputSources"] = call.input_sources.unwrap_or(Value::Null);
            }
            session["steps"] = json!(steps + 1);
            session["status"] = json!("thinking");
            commit(pool, workspace, session).await?;
            let input = call.input;
            match launch(pool, workspace, session, &catalog, input).await {
                Ok(false) => return Ok(()),
                Ok(true) => {},
                Err(error) if !session["activeCall"]["runId"].is_string() => {
                    append_result(session, json!({"status":"failed","error":error.to_string()}), "failed")?;
                    commit(pool, workspace, session).await?;
                },
                Err(error) => return Err(error),
            }
        } else {
            session["status"] = json!("idle");
            session["error"] = Value::Null;
            commit(pool, workspace, session).await?;
            return Ok(());
        }
    }
}
async fn launch(
    pool: &SqlitePool,
    workspace: &str,
    session: &mut Value,
    catalog: &Catalog,
    input: Value,
) -> Result<bool> {
    ensure_workspace(workspace)?;
    // A saved editor change can occur while collecting missing inputs. Resolve
    // the selected identity again instead of replaying the proposal's snapshot.
    let id = session["activeCall"]["workflowId"]
        .as_str()
        .context("Workflow is missing")?;
    let workflow = catalog.resolve(id).await?;
    session["activeCall"]["workflow"] = workflow.clone();
    let settings = &workflow["document"]["settings"];
    if session["activeCall"]["toolName"] == "execute_capability"
        && session["activeCall"]["inputSources"]["source"] != "user_form"
    {
        // Resolve again against the exact native target snapshot, in case the
        // catalog changed after discovery. No model-supplied values override it.
        let contents = session["messages"]
            .as_array()
            .context("messages missing")?
            .iter()
            .map(|message| serde_json::from_value(message["content"].clone()))
            .collect::<std::result::Result<Vec<adk_rust::prelude::Content>, _>>()?;
        let resolved = super::bindings::resolve(
            &super::catalog::parameters(settings),
            &session["activeCall"]["inputSources"],
            &contents,
        )?;
        anyhow::ensure!(resolved == input, "Capability bindings changed after discovery");
    }
    if !validate_input(settings, &input)? {
        session["status"] = json!("needs_input");
        commit(pool, workspace, session).await?;
        return Ok(false);
    }
    // Recheck the native policy when a paused input form is submitted; the
    // profile may have changed since the model originally proposed this call.
    if !AssistantRuntime::load(&dirs::app_home_dir()?)?
        .profile
        .workflow_execution
    {
        bail!("Workflow execution is disabled for this assistant");
    }
    let dsl = catalog.prepare(&workflow).await?;
    dispatch(pool, workspace, session, input, dsl, &NativeRuns).await?;
    Ok(true)
}

pub(super) struct RunObservation {
    pub(super) status: String,
    pub(super) name: String,
    pub(super) error: Option<String>,
    pub(super) state: Value,
}
#[async_trait::async_trait]
pub(super) trait WorkflowRuns: Send + Sync {
    async fn start(&self, request: StartWorkflowRun) -> Result<()>;
    async fn inspect(&self, id: &str) -> Result<RunObservation>;
}
struct NativeRuns;
#[async_trait::async_trait]
impl WorkflowRuns for NativeRuns {
    async fn start(&self, request: StartWorkflowRun) -> Result<()> {
        run_manager::start_workflow(request).await
    }
    async fn inspect(&self, id: &str) -> Result<RunObservation> {
        let record = RunHistoryStore::inspect(id).await?;
        let state = record
            .events
            .iter()
            .rev()
            .find(|event| event.event["type"] == "done")
            .map(|event| event.event["state"].clone())
            .unwrap_or(Value::Null);
        Ok(RunObservation {
            status: record.summary.status,
            name: record.summary.target_name,
            error: record.summary.error,
            state,
        })
    }
}
pub(super) async fn dispatch(
    pool: &SqlitePool,
    workspace: &str,
    session: &mut Value,
    input: Value,
    dsl: Value,
    runs: &dyn WorkflowRuns,
) -> Result<()> {
    ensure_workspace(workspace)?;
    let workflow = session["activeCall"]["workflow"].clone();
    let settings = &workflow["document"]["settings"];
    let run_id = uuid::Uuid::new_v4().to_string();
    session["activeCall"]["input"] = input.clone();
    session["activeCall"]["runId"] = json!(run_id);
    session["status"] = json!("running");
    // The native task records its identity before queue creation. A lost response
    // is recovered by observation of this ID, never by another dispatch.
    commit(pool, workspace, session).await?;
    let request: StartWorkflowRun = serde_json::from_value(
        json!({"runId":run_id,"targetId":workflow["id"],"targetName":settings["name"],"input":input,"initialState":input,"targetSnapshot":workflow["document"],"dsl":dsl,"threadId":uuid::Uuid::new_v4().to_string(),"releaseId":workflow["releaseId"],"releaseVersion":workflow["version"]}),
    )?;
    ensure_workspace(workspace)?;
    if let Err(error) = runs.start(request).await {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE id=? AND workspace_id=?)")
            .bind(&run_id)
            .bind(workspace)
            .fetch_one(pool)
            .await?;
        if !exists {
            session["activeCall"].as_object_mut().unwrap().remove("runId");
        }
        return Err(error);
    }
    wait_with(pool, workspace, session, runs).await
}
async fn wait(pool: &SqlitePool, workspace: &str, session: &mut Value) -> Result<()> {
    wait_with(pool, workspace, session, &NativeRuns).await
}
async fn wait_with(pool: &SqlitePool, workspace: &str, session: &mut Value, runs: &dyn WorkflowRuns) -> Result<()> {
    let id = session["activeCall"]["runId"]
        .as_str()
        .context("Run ID is missing")?
        .to_owned();
    loop {
        ensure_workspace(workspace)?;
        let record = runs.inspect(&id).await?;
        if matches!(
            record.status.as_str(),
            "completed" | "failed" | "cancelled" | "interrupted"
        ) {
            let state = record.state;
            let result = serde_json::to_string(&state)?;
            let clipped: String = result.chars().take(24000).collect();
            let artifacts = crate::module::artifact::references(&state)?;
            let mut response = json!({"runId":id,"workflow":record.name,"status":record.status,"error":record.error,"result":clipped,"truncated":result.chars().count()>24000,"artifacts":artifacts});
            if record.status == "completed" {
                match super::capability::validated_output(&session["activeCall"]["workflow"], &state) {
                    Ok(output) => {
                        response["output"] = output;
                    },
                    Err(error) => {
                        response["outputError"] = json!(error.to_string());
                    },
                }
            }
            append_result(session, response, &record.status)?;
            commit(pool, workspace, session).await?;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
fn append_result(session: &mut Value, response: Value, text: &str) -> Result<()> {
    let call = session["activeCall"].clone();
    session["messages"].as_array_mut().context("messages missing")?.push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"tool","text":text,"runId":call["runId"],"workflowName":call["workflow"]["document"]["settings"]["name"],"artifacts":response["artifacts"],"content":{"role":"function","parts":[{"functionResponse":{"name":call["toolName"],"response":response},"id":call["callId"]}]}}));
    session["activeCall"] = Value::Null;
    session["status"] = json!("thinking");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn pool() -> SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../resources/migrations/20261016100000_assistant_sessions.up.sql"
        ))
        .execute(&pool)
        .await
        .unwrap();
        pool
    }
    #[test]
    fn native_lease_serializes_turns_and_isolated_workspaces() {
        let first = acquire("a", "conversation").unwrap();
        assert!(acquire("a", "conversation").is_err());
        let other = acquire("b", "conversation").unwrap();
        drop(other);
        drop(first);
        assert!(acquire("a", "conversation").is_ok());
    }
    #[tokio::test]
    async fn reload_observes_live_native_inference_but_restart_never_replays_an_operation() {
        let pool = pool().await;
        let id = uuid::Uuid::new_v4().to_string();
        let session = json!({"id":id,"status":"thinking","messages":[]});
        save(&pool, "personal", &session).await.unwrap();
        let lease = acquire("personal", &id).unwrap();
        assert_eq!(get(&pool, "personal", &id).await.unwrap()["status"], "thinking");
        drop(lease);
        assert_eq!(get(&pool, "personal", &id).await.unwrap()["status"], "error");
        let session = json!({"id":id,"status":"running","activeCall":{"runId":"durable-run-id"},"messages":[]});
        save(&pool, "personal", &session).await.unwrap();
        let restored = get(&pool, "personal", &id).await.unwrap();
        assert_eq!(restored["status"], "error");
        assert_eq!(restored["activeCall"]["runId"], "durable-run-id");
        assert!(get(&pool, "other", &id).await.is_err());
    }
    #[test]
    fn receipt_continues_the_original_function_call_without_authorizing_dispatch() {
        let mut session = json!({"activeCall":{"runId":"run-1","toolName":"execute_workflow","callId":"call-1","workflow":{"document":{"settings":{"name":"Report"}}}},"messages":[]});
        append_result(
            &mut session,
            json!({"status":"completed","result":"Report ready"}),
            "completed",
        )
        .unwrap();
        let receipt = &session["messages"][0];
        assert_eq!(receipt["runId"], "run-1");
        assert_eq!(receipt["content"]["role"], "function");
        assert_eq!(receipt["content"]["parts"][0]["id"], "call-1");
        assert_eq!(
            receipt["content"]["parts"][0]["functionResponse"]["name"],
            "execute_workflow"
        );
        assert!(session["activeCall"].is_null());
        assert_eq!(session["status"], "thinking");
    }
    struct TestRuns {
        pool: SqlitePool,
        session_id: String,
        starts: std::sync::atomic::AtomicUsize,
        inspections: std::sync::atomic::AtomicUsize,
        complete: std::sync::atomic::AtomicBool,
        lose_response: bool,
    }
    #[async_trait::async_trait]
    impl WorkflowRuns for TestRuns {
        async fn start(&self, request: StartWorkflowRun) -> Result<()> {
            use std::sync::atomic::Ordering;
            self.starts.fetch_add(1, Ordering::SeqCst);
            let saved: String = sqlx::query_scalar("SELECT session_json FROM assistant_sessions WHERE id=?")
                .bind(&self.session_id)
                .fetch_one(&self.pool)
                .await?;
            let saved: Value = serde_json::from_str(&saved)?;
            assert_eq!(saved["activeCall"]["runId"], request.run_id);
            assert_eq!(request.input, json!({"period":"week"}));
            sqlx::query("INSERT INTO run_records VALUES (?,?)")
                .bind(&request.run_id)
                .bind("personal")
                .execute(&self.pool)
                .await?;
            if self.lose_response {
                bail!("queue response lost");
            }
            Ok(())
        }
        async fn inspect(&self, _: &str) -> Result<RunObservation> {
            use std::sync::atomic::Ordering;
            self.inspections.fetch_add(1, Ordering::SeqCst);
            Ok(RunObservation {
                status: if self.complete.load(Ordering::SeqCst) {
                    "completed"
                } else {
                    "running"
                }
                .into(),
                name: "Report".into(),
                error: None,
                state: json!({"summary":"Ready"}),
            })
        }
    }
    async fn dispatch_fixture(lose_response: bool) -> (SqlitePool, Value, std::sync::Arc<TestRuns>) {
        let pool = pool().await;
        sqlx::query("CREATE TABLE run_records(id TEXT PRIMARY KEY,workspace_id TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let session = json!({"id":id,"status":"thinking","messages":[],"activeCall":{"toolName":"execute_workflow","callId":"native-call","workflow":{"id":"report","document":{"settings":{"name":"Report"}}}}});
        let runs = std::sync::Arc::new(TestRuns {
            pool: pool.clone(),
            session_id: id,
            starts: 0.into(),
            inspections: 0.into(),
            complete: false.into(),
            lose_response,
        });
        (pool, session, runs)
    }
    #[tokio::test]
    async fn native_task_persists_dispatch_then_waits_and_delivers_without_renderer_participation() {
        use std::sync::atomic::Ordering;
        let (pool, mut session, runs) = dispatch_fixture(false).await;
        let id = session["id"].as_str().unwrap().to_owned();
        let lease = acquire("personal", &id).unwrap();
        let worker_pool = pool.clone();
        let worker_runs = runs.clone();
        let task = tokio::spawn(async move {
            let _lease = lease;
            dispatch(
                &worker_pool,
                "personal",
                &mut session,
                json!({"period":"week"}),
                json!({}),
                worker_runs.as_ref(),
            )
            .await
            .unwrap();
            session
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while runs.inspections.load(Ordering::SeqCst) == 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(get(&pool, "personal", &id).await.unwrap()["status"], "running");
        assert!(acquire("personal", &id).is_err());
        runs.complete.store(true, Ordering::SeqCst);
        let completed = task.await.unwrap();
        assert_eq!(runs.starts.load(Ordering::SeqCst), 1);
        assert!(completed["activeCall"].is_null());
        assert_eq!(completed["messages"][0]["content"]["role"], "function");
        assert!(completed["messages"][0]["content"].to_string().contains("Ready"));
    }
    #[tokio::test]
    async fn uncertain_queue_response_is_recovered_by_inspection_of_original_run_id() {
        use std::sync::atomic::Ordering;
        let (pool, mut session, runs) = dispatch_fixture(true).await;
        let _lease = acquire("personal", session["id"].as_str().unwrap()).unwrap();
        assert!(
            dispatch(
                &pool,
                "personal",
                &mut session,
                json!({"period":"week"}),
                json!({}),
                runs.as_ref()
            )
            .await
            .is_err()
        );
        let run_id = session["activeCall"]["runId"].clone();
        assert!(run_id.is_string());
        runs.complete.store(true, Ordering::SeqCst);
        wait_with(&pool, "personal", &mut session, runs.as_ref()).await.unwrap();
        assert_eq!(runs.starts.load(Ordering::SeqCst), 1);
        assert_eq!(session["messages"][0]["runId"], run_id);
    }
}
