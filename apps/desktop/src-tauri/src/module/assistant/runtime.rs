//! Session entry and handler dispatch; this module has no model instructions or tools.
use super::{
    model::content_text,
    protocol::{AssistantReply, AssistantRequest, AssistantStreamEvent, normalize_assistant_contents},
    task_agent::{self, skills::TaskSkills as SkillCatalog},
    tools::WorkflowDiscovery,
};
use crate::config::ModelProvider;
use adk_rust::Llm;
use anyhow::{Context, Result, bail};
use serde::Deserialize;
use std::{path::Path, time::Duration};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::module::assistant) struct AgentProfile {
    pub(in crate::module::assistant) skills: Vec<String>,
    pub(in crate::module::assistant) instructions: String,
    pub(in crate::module::assistant) workflow_execution: bool,
    pub(in crate::module::assistant) max_model_steps: usize,
}
impl Default for AgentProfile {
    fn default() -> Self {
        Self {
            skills: vec![],
            instructions: String::new(),
            workflow_execution: true,
            max_model_steps: 16,
        }
    }
}

pub struct AssistantRuntime {
    pub(in crate::module::assistant) profile: AgentProfile,
    pub(in crate::module::assistant) skills: SkillCatalog,
}
impl AssistantRuntime {
    /// Workspace configuration is optional and read-only here. Loading a profile
    /// never creates files, changes workflow settings or grants skills extra tools.
    pub fn load(workspace: &Path) -> Result<Self> {
        let path = workspace.join("assistant").join("agent.json");
        let profile = match std::fs::read_to_string(&path) {
            Ok(source) => serde_json::from_str::<AgentProfile>(&source)
                .with_context(|| format!("invalid assistant profile {}", path.display()))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => AgentProfile::default(),
            Err(error) => return Err(error.into()),
        };
        if !(1..=16).contains(&profile.max_model_steps) {
            bail!("assistant maxModelSteps must be between 1 and 16");
        }
        let skills = SkillCatalog::load(&profile.skills)?;
        Ok(Self { profile, skills })
    }

    #[allow(dead_code)]
    pub async fn run(
        &self,
        model: &dyn Llm,
        provider: &ModelProvider,
        request: AssistantRequest,
        emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
    ) -> Result<AssistantReply> {
        tokio::time::timeout(
            Duration::from_secs(240),
            self.run_turn(model, provider, request, emit, None),
        )
        .await
        .context("assistant turn timed out")?
    }

    pub async fn run_with_discovery(
        &self,
        model: &dyn Llm,
        provider: &ModelProvider,
        request: AssistantRequest,
        emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
        discovery: &dyn WorkflowDiscovery,
    ) -> Result<AssistantReply> {
        tokio::time::timeout(
            Duration::from_secs(240),
            self.run_turn(model, provider, request, emit, Some(discovery)),
        )
        .await
        .context("assistant turn timed out")?
    }

    async fn run_turn(
        &self,
        model: &dyn Llm,
        provider: &ModelProvider,
        request: AssistantRequest,
        emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
        discovery: Option<&dyn WorkflowDiscovery>,
    ) -> Result<AssistantReply> {
        let history = normalize_assistant_contents(request.contents)?;
        let current_message = history
            .last()
            .filter(|message| message.role == "user")
            .map(content_text);
        let turn_key = super::tool_execution::digest(&history)?;
        let pending_tool = match (discovery, request.context.session_id.as_deref()) {
            (Some(discovery), Some(session)) => discovery.pending_tool_call(session).await?,
            _ => None,
        };
        let plan = match (discovery, request.context.session_id.as_deref()) {
            (Some(discovery), Some(session)) => discovery.workflow_plan(session).await?,
            _ => None,
        };
        let native_approval = plan
            .as_ref()
            .is_some_and(|p| p["status"] == "approved" && p["approvedTurnKey"] == turn_key)
            && current_message.is_some();
        let delivery_only = plan.as_ref().is_some_and(|p| {
            ((p["approvedTurnKey"] == turn_key)
                && matches!(p["status"].as_str(), Some("building" | "saved" | "failed")))
                || (p["createdTurnKey"] == turn_key
                    && matches!(p["status"].as_str(), Some("ready" | "needs_clarification")))
        });
        if delivery_only
            && let Some(plan) = plan
                .as_ref()
                .filter(|p| matches!(p["status"].as_str(), Some("ready" | "needs_clarification")))
        {
            return Ok(AssistantReply::paused(plan, "review_required"));
        }
        let authorization_pending = current_message.is_some()
            && !delivery_only
            && !native_approval
            && pending_tool.is_none()
            && !plan.as_ref().is_some_and(|p| {
                matches!(
                    p["status"].as_str(),
                    Some("ready" | "needs_clarification" | "failed" | "approved" | "building")
                )
            });
        let mut start_planning = false;
        if authorization_pending {
            match super::router::choose(
                model,
                provider,
                &history,
                !request.context.artifacts.is_empty(),
                plan.as_ref(),
            )
            .await?
            {
                super::router::Route::Conversation => {
                    match super::conversation_agent::respond(
                        model,
                        provider,
                        &history,
                        &self.profile.instructions,
                        emit,
                    )
                    .await?
                    {
                        super::conversation_agent::Outcome::Answer(reply) => return Ok(*reply),
                        super::conversation_agent::Outcome::Task => {},
                    }
                },
                super::router::Route::Workflow => start_planning = true,
                super::router::Route::Task => {},
            }
        }
        task_agent::run(
            &self.profile,
            &self.skills,
            model,
            provider,
            task_agent::Turn {
                request: AssistantRequest {
                    contents: history,
                    ..request
                },
                current_message,
                turn_key,
                pending_tool,
                plan,
                native_approval,
                delivery_only,
                authorization_pending,
                start_planning,
            },
            emit,
            discovery,
        )
        .await
    }
}
