//! Workrun assistant composition and native integration.
mod bindings;
mod capability;
pub mod catalog;
mod main_agent;
mod model;
mod orchestration;
mod planning_agent;
mod protocol;
mod resources;
mod sdk;
pub mod session;
mod skills;
mod task_runtime;
mod tool_execution;
mod tools;
mod workflow_agent;
mod workspace_resources;
#[cfg(test)]
use crate::config::ModelProvider;
#[cfg(test)]
use adk_rust::prelude::{Content, Llm, LlmRequest, Part};
#[cfg(test)]
use anyhow::{Context, Result, bail};
#[cfg(test)]
use futures::StreamExt;
pub use main_agent::AssistantRuntime;
#[cfg(test)]
use main_agent::{AgentProfile, Intent, TurnDecision, skills::MainSkills as SkillCatalog};
#[cfg(test)]
use model::{content_text, generate};
#[cfg(test)]
use protocol::AssistantReply;
pub use protocol::{AssistantRequest, AssistantStreamEvent};
#[cfg(test)]
use protocol::{ReplyStream, normalize_assistant_contents, parse_reply};
#[cfg(test)]
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
#[cfg(test)]
use std::{collections::HashMap, time::Duration};
#[cfg(test)]
use workflow_agent::authoring;
#[cfg(test)]
mod protocol_tests;
#[cfg(test)]
mod tests;

#[cfg(test)]
mod evaluation;
#[cfg(test)]
mod native_outcome_tests;
#[cfg(test)]
mod outcome_evaluation;
#[cfg(test)]
mod task_outcome_tests;

#[cfg(test)]
mod acceptance;
#[cfg(test)]
mod authoring_tests;

#[cfg(test)]
pub(crate) fn codeact_live_test_model() -> adk_rust::model::GeminiModel {
    tests::live_gemini_model_from_env()
}

#[cfg(test)]
mod multi_agent_tests;

#[cfg(test)]
mod planning_tests;
