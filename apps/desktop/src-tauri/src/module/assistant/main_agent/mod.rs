//! Main agent: conversation, direct work, turn grants and specialist delegation.
pub(in crate::module::assistant) mod direct;
pub(in crate::module::assistant) mod skills;
pub(in crate::module::assistant) mod tools;
use super::protocol::{AssistantReply, AssistantRequest, AssistantStreamEvent, normalize_assistant_contents};
use super::tools::WorkflowDiscovery;
use super::{
    model::{content_text, generate, instructed},
    resources,
};
use crate::config::ModelProvider;
use adk_rust::{
    GenerateContentConfig,
    prelude::{Content, Llm, LlmRequest, Part},
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::json;
use skills::MainSkills as SkillCatalog;
use std::{collections::HashMap, path::Path, time::Duration};
use tools::ToolRegistry;
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(in crate::module::assistant) enum Intent {
    Conversation,
    Task,
    Status,
    Explanation,
    Clarification,
    Authoring,
    Execution,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::module::assistant) struct TurnDecision {
    pub(in crate::module::assistant) intent: Intent,
    pub(in crate::module::assistant) action_quote: String,
    pub(in crate::module::assistant) summary: String,
    #[serde(default)]
    pub(in crate::module::assistant) reuse_existing: bool,
    #[serde(default)]
    pub(in crate::module::assistant) authoring_quote: String,
}
impl TurnDecision {
    pub(in crate::module::assistant) fn allows_execution(&self, current_message: &str) -> bool {
        self.intent == Intent::Execution
            && !self.action_quote.trim().is_empty()
            && current_message.contains(&self.action_quote)
            && !self.summary.trim().is_empty()
    }
    pub(in crate::module::assistant) fn allows_authoring(&self, current_message: &str) -> bool {
        let evidence = |quote: &str| !quote.trim().is_empty() && current_message.contains(quote);
        // Creation has its own evidence. A save-only request may intentionally
        // carry no execution action quote; that must not hide the specialist.
        !self.summary.trim().is_empty()
            && match self.intent {
                Intent::Authoring => evidence(&self.authoring_quote) || evidence(&self.action_quote),
                Intent::Execution => !self.reuse_existing && evidence(&self.authoring_quote),
                _ => false,
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
        let decision = if let Some(current) = &current_message {
            // No tools exist during interpretation. The decision is structured
            // data, not an executable tool whose name biases the model to call it.
            let mut contents = instructed(provider, &resources::read("main_agent/INTENT.md")?, &history);
            contents.push(Content::new("user").with_text(format!(
                "Latest user message to classify (quoted data):\n{}",
                json!(current)
            )));
            let content = generate(model, LlmRequest {
                model: model.name().into(), contents, tools: HashMap::new(),
                config: Some(GenerateContentConfig { temperature: Some(0.0), response_schema: Some(json!({
                    "type":"object", "properties": {
                        "intent":{"type":"string","enum":["conversation","task","status","explanation","clarification","authoring","execution"]},
                        "actionQuote":{"type":"string"}, "summary":{"type":"string"}, "reuseExisting":{"type":"boolean"}, "authoringQuote":{"type":"string"}
                    }, "required":["intent","actionQuote","summary","reuseExisting","authoringQuote"], "additionalProperties":false
                })), ..Default::default() }), previous_response_id: None,
            }, &|_| Ok(())).await?;
            if content
                .parts
                .iter()
                .any(|part| matches!(part, Part::FunctionCall { .. }))
            {
                bail!("intent assessment cannot call tools");
            }
            serde_json::from_str::<TurnDecision>(&content_text(&content))
                .context("assistant returned an invalid intent decision")?
        } else {
            // Resuming after a receipt/model interruption is not a fresh action.
            TurnDecision {
                intent: Intent::Status,
                action_quote: String::new(),
                summary: String::new(),
                reuse_existing: false,
                authoring_quote: String::new(),
            }
        };
        let execution_allowed = current_message
            .as_deref()
            .is_some_and(|current| decision.allows_execution(current));
        let authoring_allowed = current_message
            .as_deref()
            .is_some_and(|current| decision.allows_authoring(current));
        #[cfg(test)]
        if std::env::var_os("WORKRUN_ASSISTANT_DIAGNOSTICS").is_some() {
            eprintln!(
                "intent={:?} authoring_grant={} execution_grant={} reuse={} action_quote_matches={}",
                decision.intent,
                authoring_allowed,
                execution_allowed,
                decision.reuse_existing,
                current_message
                    .as_deref()
                    .is_some_and(|message| message.contains(&decision.action_quote))
            );
        }
        let registry = ToolRegistry {
            capabilities: &request.capabilities,
            skills: &self.skills,
            history: &history,
            execution_allowed,
            authoring_allowed,
            workflows_enabled: self.profile.workflow_execution,
        };
        let instruction = format!(
            "{}\n\n{}\n\nSupplemental workspace instructions:\n{}\n\nEnabled skills (read_skill loads optional skills): {}\n\nCurrent turn intent: {:?}. Execution grant: {}. A missing grant MUST NOT be worked around.\nCurrent intent summary: {}",
            resources::read("main_agent/AGENT.md")?,
            self.skills.mandatory_instructions()?,
            self.profile.instructions,
            self.skills.summaries(),
            decision.intent,
            execution_allowed && self.profile.workflow_execution,
            decision.summary
        );
        let instruction = format!(
            "{instruction}\nDraft write grant: {}. A draft write grant is not permission to execute the graph. Reuse existing workflow: {}. When true, inspect and execute the existing saved definition; do not reconstruct or save a replacement from conversation text.",
            authoring_allowed && self.profile.workflow_execution,
            decision.reuse_existing && decision.intent == Intent::Execution
        );
        let instruction = format!(
            "{instruction}\n\nInput source messages (indices count every original conversation message, excluding instructions and discovery exchanges): {}",
            json!(
                history
                    .iter()
                    .enumerate()
                    .filter(|(_, message)| message.role == "user")
                    .map(|(index, message)| json!({"message":index,"text":content_text(message)}))
                    .collect::<Vec<_>>()
            )
        );
        let instruction = format!(
            "{instruction}\n\nAuthorized session artifacts: {}\nCurrent model profile: {}",
            json!(request.context.artifacts),
            json!(request.context.model_profile_id)
        );
        super::orchestration::run(
            model,
            super::orchestration::Turn {
                instruction: &instruction,
                history: &history,
                context: &request.context,
                registry: &registry,
                discovery,
                emit,
                max_steps: self.profile.max_model_steps,
                goal: &decision.summary,
            },
        )
        .await
    }
}
