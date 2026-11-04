//! Dedicated scheduling agent. No workflow authoring tools, orchestration or shared conversation history.
mod runtime;
mod store;
mod stream;
#[cfg(test)]
mod tests;
mod tools;
use crate::{
    config::{BaseConfig, model_catalog},
    core::db::DBManager,
    module::assistant::{self, catalog::Catalog},
    utils::dirs,
};
use adk_rust::{Content, Llm, LlmRequest, Part};
use anyhow::{Context, Result, bail, ensure};
use chrono::Utc;
use runtime::ScheduleRuntime;
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use store::SchedulingStore;
use stream::ScheduleResponseStream;
use tauri::ipc::Channel;
use tools::ScheduleTools;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Turn {
    pub session_id: String,
    pub model_id: String,
    pub reasoning_effort: Option<String>,
    pub text: String,
    pub timezone: String,
    pub team_token: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScheduleModelSelection {
    pub model_id: String,
    pub reasoning_effort: Option<String>,
}

impl ScheduleModelSelection {
    fn validate(&self) -> Result<()> {
        let model = model_catalog()
            .into_iter()
            .find(|model| model.id == self.model_id)
            .context("Select a valid model")?;
        if let Some(effort) = &self.reasoning_effort {
            ensure!(
                model.effort_options().contains(&effort.as_str()),
                "Unsupported reasoning effort for this model"
            );
        }
        Ok(())
    }

    fn apply(&self, state: &mut Value) {
        state["modelId"] = json!(self.model_id);
        state["reasoningEffort"] = json!(self.reasoning_effort);
    }
}

/// A scheduling agent is bound to one workspace for its entire operation.
pub struct ScheduleAgent {
    store: SchedulingStore,
    runtime: &'static ScheduleRuntime,
}

/// Direct task management shares validation/storage, without an agent runtime or session.
pub struct ScheduleTaskManager {
    store: SchedulingStore,
}

impl ScheduleTaskManager {
    pub fn active() -> Result<Self> {
        Ok(Self {
            store: SchedulingStore::new(DBManager::global().pool()?, dirs::active_workspace_id()),
        })
    }

    pub async fn update(&self, args: Value, token: Option<&str>) -> Result<Value> {
        let catalog = Catalog::load(token).await?;
        self.store.update_task(&catalog, &args).await
    }
}

impl ScheduleAgent {
    pub fn active() -> Result<Self> {
        Ok(Self {
            store: SchedulingStore::new(DBManager::global().pool()?, dirs::active_workspace_id()),
            runtime: ScheduleRuntime::global(),
        })
    }
    pub async fn list_tasks(&self) -> Result<Value> {
        self.store.list().await
    }

    pub async fn task_detail(&self, id: &str) -> Result<Value> {
        self.store.detail(id).await
    }

    fn public_state(mut state: Value) -> Value {
        state.as_object_mut().unwrap().remove("contents");
        for p in state["proposals"].as_array_mut().into_iter().flatten() {
            for field in ["before", "after"] {
                if let Some(task) = p[field].as_object_mut() {
                    if let Some(recipe) = task.remove("recipe") {
                        task.insert("input".into(), recipe["input"].clone());
                        task.insert("source".into(), recipe["source"].clone());
                    }
                    task.remove("snapshot");
                }
            }
        }
        state
    }

    pub async fn create(
        &self,
        schedule_id: Option<String>,
        selection: Option<ScheduleModelSelection>,
    ) -> Result<Value> {
        if let Some(selection) = &selection {
            selection.validate()?;
        }
        if let Some(id) = &schedule_id {
            self.store.raw(id).await?;
        }
        let mut state = json!({"id":uuid::Uuid::new_v4().to_string(),"title":"","scheduleId":schedule_id,"messages":[],"contents":[],"proposals":[],"pending":null,"questions":[],"status":"idle"});
        if let Some(id) = &schedule_id {
            let task = self.store.detail(id).await?;
            let card_id = uuid::Uuid::new_v4().to_string();
            state["title"] = task["name"].clone();
            state["messages"] =
                json!([{"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","text":"","proposalId":card_id}]);
            state["proposals"] = json!([{"id":card_id,"operation":"create","status":"saved","after":task,"before":null,"messageIndex":0}]);
        }
        if let Some(selection) = selection {
            selection.apply(&mut state);
        }
        self.store.save_session(&mut state).await?;
        Ok(Self::public_state(state))
    }

    pub async fn set_model(&self, session_id: &str, selection: ScheduleModelSelection) -> Result<Value> {
        let lock = self.runtime.lease(self.store.workspace(), session_id);
        let _guard = lock.try_lock().context("Scheduling conversation is busy")?;
        selection.validate()?;
        let mut state = self.store.load_session(session_id).await?;
        // Only model preferences can be changed here; conversation and proposal state stay native-owned.
        selection.apply(&mut state);
        self.store.save_session(&mut state).await?;
        Ok(Self::public_state(state))
    }

    pub async fn get(&self, id: &str) -> Result<Value> {
        let workspace = self.store.workspace();
        let mut state = self.store.load_session(id).await?;
        // A process restart cannot resume an unfinished inference or manufacture an action approval.
        if state["status"] == "running" && !self.runtime.is_running(workspace, id) {
            state["status"] = json!("interrupted");
        }
        self.store.ensure_active()?;
        Ok(Self::public_state(state))
    }

    pub async fn sessions(&self) -> Result<Value> {
        self.store.list_sessions().await
    }

    pub fn stop(&self, id: &str) {
        self.runtime.stop(self.store.workspace(), id);
    }

    pub async fn delete_session(&self, id: &str) -> Result<()> {
        let workspace = self.store.workspace();
        let lock = self.runtime.lease(workspace, id);
        let _guard = lock.try_lock().context("Stop the current response first")?;
        self.store.delete_session(id).await
    }

    pub async fn turn(&self, request: Turn, channel: Channel<Value>) -> Result<Value> {
        ensure!(
            !request.text.trim().is_empty() && request.text.len() <= 32000,
            "Message must contain 1–32000 bytes"
        );
        let workspace = self.store.workspace();
        let lock = self.runtime.lease(workspace, &request.session_id);
        let _guard = lock.try_lock().context("Scheduling conversation is busy")?;
        let mut state = self.store.load_session(&request.session_id).await?;
        let definition = model_catalog()
            .into_iter()
            .find(|m| m.id == request.model_id)
            .context("Select a valid model")?;
        let config = BaseConfig::workrun().await.data_arc();
        let model = crate::module::workflow::agent::create_model_with_effort(
            &definition,
            &config,
            true,
            request.reasoning_effort.as_deref(),
        )?;
        let catalog = Catalog::load(request.team_token.as_deref()).await?;
        ensure!(
            state["contents"].as_array().unwrap().len() < 500,
            "Start a new scheduling conversation"
        );
        state["modelId"] = json!(request.model_id);
        state["reasoningEffort"] = json!(request.reasoning_effort);
        if state["title"].as_str().unwrap_or("").is_empty() {
            state["title"] = json!(request.text.chars().take(60).collect::<String>());
        }
        state["questions"] = json!([]);
        state["error"] = Value::Null;
        state["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"user","text":request.text}));
        state["contents"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::to_value(Content::new("user").with_text(&request.text))?);
        state["status"] = json!("running");
        let cancel = self.runtime.start(workspace, &request.session_id);
        if let Err(error) = self.store.save_session(&mut state).await {
            self.runtime.finish(workspace, &request.session_id);
            return Err(error);
        }
        let outcome = tokio::select! {
            _=cancel.cancelled()=>Err(anyhow::anyhow!("Response stopped")),
            result=tokio::time::timeout(Duration::from_secs(240), crate::module::model_usage::scope(crate::module::model_usage::CallContext {
                workspace_id: workspace.to_owned(), session_kind: Some("schedule_agent".into()), session_id: Some(request.session_id.clone()), purpose: "schedule_agent".into(), model_profile_id: Some(request.model_id.clone()), ..Default::default()
            }, self.run(model.as_ref(),&definition.provider,&catalog,&request.timezone,&mut state,&channel)))=>result.context("Scheduling response timed out").and_then(|r|r),
        };
        self.runtime.finish(workspace, &request.session_id);
        state["status"] = json!(if cancel.is_cancelled() { "interrupted" } else { "idle" });
        if let Err(error) = outcome {
            state["error"] = json!(error.to_string());
        }
        self.store.save_session(&mut state).await?;
        Ok(Self::public_state(state))
    }

    async fn run(
        &self,
        model: &dyn Llm,
        provider: &crate::config::ModelProvider,
        catalog: &Catalog,
        timezone: &str,
        state: &mut Value,
        channel: &Channel<Value>,
    ) -> Result<()> {
        let selected = if let Some(id) = state["scheduleId"].as_str() {
            self.store.detail(id).await.ok()
        } else {
            None
        };
        let instruction = format!(
            "{}\nCurrent UTC time: {}. Device timezone: {}. Selected task (data): {}. Pending card (data): {}.",
            include_str!("AGENT.md"),
            Utc::now().to_rfc3339(),
            timezone,
            json!(selected),
            state["pending"]
        );
        let tools = ScheduleTools::new(&self.store, catalog);
        let mut history: Vec<Content> = serde_json::from_value(state["contents"].clone())?;
        let mut awaiting_card = false;
        let mut reasoning = Vec::new();
        for _ in 0..12 {
            self.store.ensure_active()?;
            let mut request = LlmRequest::new(
                model.name(),
                assistant::agent_contents(provider, &instruction, &history),
            );
            // After a card is prepared, allow one final streamed explanation,
            // with tools disabled so it cannot mutate or create another card.
            if !awaiting_card {
                request.tools = ScheduleTools::declarations();
            }
            let response_stream = ScheduleResponseStream::new(channel);
            let reply =
                assistant::generate_agent_stream(model, request, &|event| response_stream.forward(event)).await?;
            let calls = reply
                .parts
                .iter()
                .filter_map(|p| {
                    if let Part::FunctionCall { name, args, id, .. } = p {
                        Some((name.clone(), args.clone(), id.clone()))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>();
            ensure!(
                !awaiting_card || calls.is_empty(),
                "The prepared card requires confirmation; no further tools are allowed"
            );
            reasoning.extend(response_stream.reasoning());
            response_stream.finish(!calls.is_empty());
            let text = assistant::agent_text(&reply);
            history.push(reply);
            let mut boundary = false;
            let stateful = calls
                .iter()
                .filter(|(name, _, _)| matches!(name.as_str(), "preview_change" | "ask_questions"))
                .count();
            for (name, args, id) in &calls {
                response_stream.tool_start(name);
                let result = if stateful > 1 && matches!(name.as_str(), "preview_change" | "ask_questions") {
                    Err(anyhow::anyhow!("Use only one preview or question card per response"))
                } else {
                    tools.call(state, name, args).await
                };
                let response = match result {
                    Ok(value) => value,
                    Err(error) => json!({"error":error.to_string()}),
                };
                if response["awaitingUser"] == true {
                    boundary = true;
                }
                // Retain provider call IDs/signatures, with one response per call.
                history.push(serde_json::from_value(
                    json!({"role":"function","parts":[{"functionResponse":{"name":name,"response":response},"id":id}]}),
                )?);
            }
            state["contents"] = serde_json::to_value(&history)?;
            if calls.is_empty() {
                if !text.trim().is_empty() {
                    state["messages"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","text":text,"reasoning":reasoning}));
                }
                if awaiting_card {
                    let count = state["messages"].as_array().unwrap().len();
                    for proposal in state["proposals"].as_array_mut().unwrap() {
                        if proposal["status"] == "waiting" {
                            proposal["messageIndex"] = json!(count);
                        }
                    }
                }
                return Ok(());
            }
            if boundary {
                awaiting_card = true;
            }
        }
        bail!("Too many scheduling steps. Please narrow the request.")
    }

    pub async fn reply_receipt(&self, session_id: &str, channel: Channel<Value>) -> Result<Value> {
        let workspace = self.store.workspace();
        let lock = self.runtime.lease(workspace, session_id);
        let _guard = lock.try_lock().context("Scheduling conversation is busy")?;
        let mut state = self.store.load_session(session_id).await?;
        let history: Vec<Content> = serde_json::from_value(state["contents"].clone())?;
        // A native receipt must be the latest input. Reopening details never generates replies.
        ensure!(
            history.last().is_some_and(
                |content| assistant::agent_text(content).starts_with("Native schedule action receipt (data):")
            ),
            "No new action receipt"
        );
        let receipt_text = assistant::agent_text(history.last().unwrap());
        let receipt: Value =
            serde_json::from_str(receipt_text.trim_start_matches("Native schedule action receipt (data): "))?;
        let definition = model_catalog()
            .into_iter()
            .find(|m| Some(m.id.as_str()) == state["modelId"].as_str())
            .context("Select a valid model")?;
        let config = BaseConfig::workrun().await.data_arc();
        let model = crate::module::workflow::agent::create_model_with_effort(
            &definition,
            &config,
            true,
            state["reasoningEffort"].as_str(),
        )?;
        let request = LlmRequest::new(
            model.name(),
            assistant::agent_contents(
                &definition.provider,
                "Respond in the user's language. Confirm the last native schedule action receipt accurately in one short sentence. The task card already shows its settings: do not repeat every field or include raw Cron expressions, internal IDs or technical flags. Use everyday language. Only saved receipts mean success. Do not invent execution results. No tools or further actions are available.",
                &history,
            ),
        );
        state["status"] = json!("running");
        state["error"] = Value::Null;
        let cancel = self.runtime.start(workspace, session_id);
        if let Err(error) = self.store.save_session(&mut state).await {
            self.runtime.finish(workspace, session_id);
            return Err(error);
        }
        let response_stream = ScheduleResponseStream::new(&channel);
        let forward = |event| response_stream.forward(event);
        let inference = crate::module::model_usage::scope(
            crate::module::model_usage::CallContext {
                workspace_id: workspace.to_owned(),
                session_kind: Some("schedule_agent".into()),
                session_id: Some(session_id.to_owned()),
                purpose: "schedule_agent".into(),
                model_profile_id: Some(definition.id.clone()),
                ..Default::default()
            },
            assistant::generate_agent_stream(model.as_ref(), request, &forward),
        );
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(anyhow::anyhow!("Response stopped")),
            result = tokio::time::timeout(Duration::from_secs(120), inference) => result.context("Scheduling response timed out").and_then(|result| result),
        };
        self.runtime.finish(workspace, session_id);
        response_stream.finish(false);
        state["status"] = json!(if cancel.is_cancelled() { "interrupted" } else { "idle" });
        match result {
            Ok(reply) => {
                let text = assistant::agent_text(&reply);
                state["messages"].as_array_mut().unwrap().push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","text":text,"reasoning":response_stream.reasoning(),"proposalId":receipt["proposalId"]}));
                state["contents"]
                    .as_array_mut()
                    .unwrap()
                    .push(serde_json::to_value(reply)?);
            },
            Err(error) => state["error"] = json!(error.to_string()),
        }
        self.store.save_session(&mut state).await?;
        Ok(Self::public_state(state))
    }

    pub async fn propose(&self, session_id: &str, args: Value, token: Option<&str>) -> Result<Value> {
        let workspace = self.store.workspace();
        let lock = self.runtime.lease(workspace, session_id);
        let _guard = lock.try_lock().context("Scheduling conversation is busy")?;
        let mut state = self.store.load_session(session_id).await?;
        let catalog = Catalog::load(token).await?;
        // Detail-dialog actions are new conversation entries, not attachments
        // to an earlier model receipt. Persist the row only if preview succeeds.
        state["messages"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":uuid::Uuid::new_v4().to_string(),"role":"assistant","text":""}));
        ScheduleTools::new(&self.store, &catalog)
            .call(&mut state, "preview_change", &args)
            .await?;
        self.store.save_session(&mut state).await?;
        Ok(Self::public_state(state))
    }

    pub async fn decide(
        &self,
        session_id: &str,
        proposal_id: &str,
        approve: bool,
        token: Option<&str>,
    ) -> Result<Value> {
        let workspace = self.store.workspace();
        let lock = self.runtime.lease(workspace, session_id);
        let _guard = lock.try_lock().context("Scheduling conversation is busy")?;
        let mut state = self.store.load_session(session_id).await?;
        if approve {
            let proposal = state["proposals"]
                .as_array()
                .and_then(|items| items.iter().find(|p| p["id"] == proposal_id))
                .context("Task card is unavailable")?;
            if proposal["status"] == "waiting"
                && matches!(proposal["operation"].as_str(), Some("create" | "update" | "resume"))
                && proposal["after"]["recipe"]["source"]["kind"] != "published_release"
            {
                let after = &proposal["after"];
                let catalog = Catalog::load(token).await?;
                let selected = SchedulingStore::target(
                    &catalog,
                    after["targetType"].as_str().context("Missing target type")?,
                    after["targetId"].as_str().context("Missing target ID")?,
                )
                .await?;
                ensure!(
                    selected["snapshot"] == after["snapshot"],
                    "Execution target changed. Preview the task again before confirming."
                );
            }
        }
        self.store.decide(&mut state, proposal_id, approve).await?;
        Ok(Self::public_state(state))
    }
}
