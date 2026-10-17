//! Independent main-agent runtime: conversation, skills, tool loop and turn-scoped grants.
pub mod catalog;
mod protocol;
pub mod session;
mod skills;
mod tools;

use crate::config::ModelProvider;
use adk_rust::GenerateContentConfig;
use adk_rust::prelude::{Content, Llm, LlmRequest, Part};
use anyhow::{Context, Result, bail};
use futures::StreamExt;
pub use protocol::{AssistantReply, AssistantRequest, AssistantStreamEvent};
use protocol::{ReplyStream, normalize_assistant_contents, parse_reply};
use serde::{Deserialize, Serialize};
use serde_json::json;
use skills::SkillCatalog;
use std::{collections::HashMap, path::Path, time::Duration};
use tools::{ToolRegistry, WorkflowDiscovery};

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
struct AgentProfile {
    skills: Vec<String>,
    instructions: String,
    workflow_execution: bool,
    max_model_steps: usize,
}
impl Default for AgentProfile {
    fn default() -> Self {
        Self {
            skills: vec![],
            instructions: String::new(),
            workflow_execution: true,
            max_model_steps: 8,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Intent {
    Conversation,
    Status,
    Explanation,
    Clarification,
    Execution,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TurnDecision {
    intent: Intent,
    action_quote: String,
    summary: String,
}
impl TurnDecision {
    fn allows_execution(&self, current_message: &str) -> bool {
        self.intent == Intent::Execution
            && !self.action_quote.trim().is_empty()
            && current_message.contains(&self.action_quote)
            && !self.summary.trim().is_empty()
    }
}

pub struct AssistantRuntime {
    profile: AgentProfile,
    skills: SkillCatalog,
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
            Duration::from_secs(120),
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
            Duration::from_secs(120),
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
            let mut contents = instructed(provider, include_str!("INTENT.md"), &history);
            contents.push(Content::new("user").with_text(format!(
                "Latest user message to classify (quoted data):\n{}",
                json!(current)
            )));
            let content = generate(model, LlmRequest {
                model: model.name().into(), contents, tools: HashMap::new(),
                config: Some(GenerateContentConfig { temperature: Some(0.0), response_schema: Some(json!({
                    "type":"object", "properties": {
                        "intent":{"type":"string","enum":["conversation","status","explanation","clarification","execution"]},
                        "actionQuote":{"type":"string"}, "summary":{"type":"string"}
                    }, "required":["intent","actionQuote","summary"], "additionalProperties":false
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
            }
        };
        let execution_allowed = current_message
            .as_deref()
            .is_some_and(|current| decision.allows_execution(current));
        let registry = ToolRegistry {
            capabilities: &request.capabilities,
            skills: &self.skills,
            history: &history,
            execution_allowed,
            workflows_enabled: self.profile.workflow_execution,
        };
        let instruction = format!(
            "{}\n\n{}\n\nSupplemental workspace instructions:\n{}\n\nEnabled skills (read_skill loads optional skills): {}\n\nCurrent turn intent: {:?}. Execution grant: {}. A missing grant MUST NOT be worked around.\nCurrent intent summary: {}",
            include_str!("AGENT.md"),
            self.skills.mandatory_instructions(),
            self.profile.instructions,
            self.skills.summaries(),
            decision.intent,
            execution_allowed && self.profile.workflow_execution,
            decision.summary
        );
        let mut contents = instructed(provider, &instruction, &history);
        for _ in 0..self.profile.max_model_steps {
            let content = generate(
                model,
                LlmRequest {
                    model: model.name().into(),
                    contents: contents.clone(),
                    tools: registry.declarations(),
                    config: None,
                    previous_response_id: None,
                },
                emit,
            )
            .await?;
            let calls = content
                .parts
                .iter()
                .filter_map(|part| match part {
                    Part::FunctionCall { name, args, id, .. } => Some((name.clone(), args.clone(), id.clone())),
                    _ => None,
                })
                .collect::<Vec<_>>();
            if calls.len() > 1 {
                bail!("assistant must call one tool at a time");
            }
            if let Some((name, args, id)) = calls.first() {
                // Validate against exactly the declarations offered THIS turn,
                // even if a provider emits a tool call absent from the schema.
                if !registry.declarations().contains_key(name) {
                    bail!("tool `{name}` is not permitted for this turn");
                }
                if name == tools::EXECUTE_WORKFLOW {
                    if let Some(discovery) = discovery {
                        let workflow_id = args
                            .get("workflow_id")
                            .and_then(serde_json::Value::as_str)
                            .context("workflow_id is required")?;
                        let capability = discovery.describe(workflow_id).await?;
                        return parse_reply(content, &[capability]);
                    }
                    return parse_reply(content, &request.capabilities);
                }
                let read_result = if name == "list_workflow" {
                    if let Some(discovery) = discovery {
                        discovery.list(args).await
                    } else {
                        registry.read(name, args)
                    }
                } else {
                    registry.read(name, args)
                };
                let response = match read_result {
                    Ok(value) => {
                        if name == "report_progress" {
                            emit(AssistantStreamEvent::Activity {
                                summary: value["summary"].as_str().unwrap_or_default().into(),
                            })?;
                        }
                        value
                    },
                    Err(error) => json!({"error":error.to_string()}),
                };
                let receipt: Content = serde_json::from_value(json!({"role":"function","parts":[{
                    "functionResponse":{"name":name,"response":response}, "id":id
                }]}))?;
                contents.push(content);
                contents.push(receipt);
            } else {
                return parse_reply(content, &[]);
            }
        }
        bail!("assistant tool-step limit reached; no additional workflow was dispatched")
    }
}

fn content_text(content: &Content) -> String {
    content
        .parts
        .iter()
        .filter_map(|part| match part {
            Part::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

fn instructed(provider: &ModelProvider, instruction: &str, history: &[Content]) -> Vec<Content> {
    // ADK 2.3 Gemini ignores role=system entirely. Its own LlmAgent uses a user
    // preamble. Keep that compatibility at this boundary, not in saved history.
    let role = if *provider == ModelProvider::Gemini {
        "user"
    } else {
        "system"
    };
    let mut contents = vec![Content::new(role).with_text(instruction)];
    contents.extend_from_slice(history);
    contents
}

async fn generate(
    model: &dyn Llm,
    mut request: LlmRequest,
    emit: &(dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
) -> Result<Content> {
    // ADK normalizes function schemas, but forwards response_schema verbatim.
    // Apply the same provider adapter to structured intent output (Gemini's
    // response Schema rejects JSON Schema's additionalProperties keyword).
    if let Some(config) = &mut request.config
        && let Some(schema) = config.response_schema.take()
    {
        config.response_schema = Some(model.schema_adapter().normalize_schema(schema));
    }
    let mut stream = model.generate_content(request, true).await?;
    let mut reply = ReplyStream::new();
    while let Some(response) = stream.next().await {
        if let Some(event) = reply.push(response?)? {
            emit(event)?;
        }
    }
    reply.finish_content()
}

#[cfg(test)]
mod protocol_tests;
#[cfg(test)]
mod tests;
