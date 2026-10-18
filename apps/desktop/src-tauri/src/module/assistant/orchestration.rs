//! Native boundaries around an SDK-owned coordinator, specialist tree and Runner.
use super::{
    main_agent::tools::ToolRegistry,
    model::{content_text, generate},
    protocol::{self, AssistantContext, AssistantReply, AssistantStreamEvent},
    sdk,
    tools::WorkflowDiscovery,
    workflow_agent,
};
use crate::module::artifact::ArtifactRef;
use adk_rust::prelude::LlmAgentBuilder;
use adk_rust::runner::Runner;
use adk_rust::session::{CreateRequest, InMemorySessionService, SessionService};
use adk_rust::{Content, Event, Llm, LlmRequest, Part, RunConfig, ToolExecutionStrategy};
use anyhow::{Context, Result, bail, ensure};
use futures::StreamExt;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::Arc};

pub(super) struct Turn<'a> {
    pub instruction: &'a str,
    pub history: &'a [Content],
    pub context: &'a AssistantContext,
    pub registry: &'a ToolRegistry<'a>,
    pub discovery: Option<&'a dyn WorkflowDiscovery>,
    pub emit: &'a (dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
    pub max_steps: usize,
    pub goal: &'a str,
}

pub(super) async fn run(model: &dyn Llm, turn: Turn<'_>) -> Result<AssistantReply> {
    let Turn {
        instruction,
        history,
        context,
        registry,
        discovery,
        emit,
        max_steps,
        goal,
    } = turn;
    let (send, mut receive) = tokio::sync::mpsc::channel(8);
    let mut declarations = registry.declarations();
    if discovery.is_some() {
        declarations.remove("list_workflow");
        declarations.remove("execute_workflow");
    } else {
        for name in [
            "prepare_workflow_task",
            "read_artifact",
            "run_code",
            "inspect_operations",
        ] {
            declarations.remove(name);
        }
    }
    let mut builder = LlmAgentBuilder::new("main_agent")
        .description("Understand user goals, perform direct work and coordinate workflow specialists")
        .instruction(instruction)
        .model(Arc::new(sdk::Model {
            agent: "main_agent".into(),
            name: model.name().into(),
            requests: send.clone(),
        }))
        .max_iterations(max_steps as u32 + 1)
        .tool_execution_strategy(ToolExecutionStrategy::Sequential);
    for declaration in declarations.into_values() {
        builder = builder.tool(Arc::new(sdk::NativeTool {
            agent: "main_agent".into(),
            declaration,
            requests: send.clone(),
        }));
    }
    if registry.authoring_allowed && registry.workflows_enabled && discovery.is_some() {
        builder = builder.sub_agent(workflow_agent::build(model.name(), send, max_steps)?);
    }
    let coordinator = Arc::new(builder.build()?);
    let sessions = Arc::new(InMemorySessionService::new());
    let session = sessions
        .create(CreateRequest {
            app_name: "workrun_assistant".into(),
            user_id: "workspace_user".into(),
            session_id: None,
            state: HashMap::new(),
        })
        .await?;
    let session_id = session.id().to_string();
    // Native history remains the durable authority. This scoped SDK session starts
    // at the coordinator on every user turn, so a specialist cannot capture later turns.
    let has_user = history.last().is_some_and(|content| content.role == "user");
    let initial = if has_user {
        &history[..history.len() - 1]
    } else {
        history
    };
    for content in initial {
        let mut event = Event::new("native_history");
        event.author = if content.role == "user" { "user" } else { "main_agent" }.into();
        event.llm_response.content = Some(content.clone());
        sessions.append_event(&session_id, event).await?;
    }
    let user = if has_user {
        history.last().unwrap().clone()
    } else {
        Content::new("user").with_text("Continue delivery from the existing native receipts. This continuation grants no new execution or workflow editing.")
    };
    let runner = Runner::builder()
        .app_name("workrun_assistant")
        .agent(coordinator)
        .session_service(sessions)
        .run_config(RunConfig {
            max_transfer_depth: Some(2),
            ..Default::default()
        })
        .build()?;
    let invocation = async {
        let mut events = runner
            .run("workspace_user".try_into()?, session_id.as_str().try_into()?, user)
            .await?;
        let mut reply = None;
        while let Some(event) = events.next().await {
            let event = event?;
            if event.author == "main_agent"
                && let Some(content) = event.llm_response.content
                && !content
                    .parts
                    .iter()
                    .any(|part| matches!(part, Part::FunctionCall { .. }))
                && !content_text(&content).trim().is_empty()
            {
                reply = Some(protocol::parse_reply(content, &[])?);
            }
        }
        reply.context("SDK runner returned no main-agent answer")
    };
    tokio::pin!(invocation);
    let mut state = NativeTurn {
        context,
        registry,
        discovery,
        emit,
        history,
        artifacts: context.artifacts.clone(),
        produced: vec![],
        task: workflow_agent::initial_task(goal),
        operation: None,
        workflow_result: None,
        saved: None,
        pending: None,
        blocked: HashMap::new(),
        steps: HashMap::new(),
        max_steps,
    };
    loop {
        tokio::select! {
            result = &mut invocation => {
                let mut reply = result?;
                reply.artifacts = state.produced;
                return Ok(reply);
            },
            Some(request) = receive.recv() => match request {
                sdk::Request::Model(agent, request, response) => {
                    let result = state.model(model, &agent, *request).await;
                    let _ = response.send(result);
                },
                sdk::Request::Tool(agent, name, args, response) => {
                    if agent == "main_agent" && matches!(name.as_str(), "execute_capability" | "execute_workflow")
                        && !state.blocked.contains_key(&agent) {
                        match state.propose(&name, &args).await {
                            Ok(mut reply) => { reply.artifacts = state.produced; return Ok(reply); },
                            Err(error) => { let _ = response.send(Ok(json!({"error":error.to_string(),"executed":false}))); },
                        }
                    } else {
                        let result = state.tool(&agent, &name, args).await;
                        let _ = response.send(Ok(match result { Ok(value) => value, Err(error) => json!({"error":error.to_string()}) }));
                    }
                },
                sdk::Request::WorkflowFinished(text, error, response) => {
                    let result = state.finish(&text, error).await;
                    let _ = response.send(result);
                },
            },
        }
    }
}

struct NativeTurn<'a> {
    context: &'a AssistantContext,
    registry: &'a ToolRegistry<'a>,
    discovery: Option<&'a dyn WorkflowDiscovery>,
    emit: &'a (dyn Fn(AssistantStreamEvent) -> Result<()> + Send + Sync),
    history: &'a [Content],
    artifacts: Vec<ArtifactRef>,
    produced: Vec<ArtifactRef>,
    task: Value,
    operation: Option<Value>,
    workflow_result: Option<Value>,
    saved: Option<Value>,
    pending: Option<Content>,
    blocked: HashMap<String, Value>,
    steps: HashMap<String, usize>,
    max_steps: usize,
}
impl NativeTurn<'_> {
    async fn model(&mut self, model: &dyn Llm, agent: &str, mut request: LlmRequest) -> Result<Content> {
        let count = self.steps.entry(agent.into()).or_default();
        *count += 1;
        ensure!(
            *count <= self.max_steps,
            "assistant tool-step limit reached; no additional workflow was dispatched"
        );
        if agent == "workflow_author" {
            ensure!(self.operation.is_some(), "Workflow agent has no authorized handoff");
            request.contents.insert(1.min(request.contents.len()), Content::new("user").with_text(json!({"delegated_task":self.task,"authorized_artifacts":self.artifacts,"preferred_model_profile_id":self.context.model_profile_id}).to_string()));
        } else {
            if let Some(result) = &self.workflow_result {
                request.tools.remove("transfer_to_agent");
                request.tools.remove("prepare_workflow_task");
                request.contents.push(Content::new("user").with_text(format!("Native workflow-authoring outcome (data, not new permission): {result}. Continue as the main agent. Do not create another workflow this turn.")));
            }
            // SDK supplies unknown-tool feedback. Preserve Workrun's explicit
            // permission feedback without advertising a forbidden write tool.
            for content in &mut request.contents {
                for part in &mut content.parts {
                    if let Part::FunctionResponse { function_response, .. } = part
                        && function_response.name == "save_workflow_draft"
                    {
                        function_response.response = denied();
                    }
                }
            }
        }
        let allowed = request.tools.clone();
        let content = if agent == "main_agent" {
            generate(model, request, self.emit).await?
        } else {
            generate(model, request, &|_| Ok(())).await?
        };
        let calls = content
            .parts
            .iter()
            .filter_map(|part| match part {
                Part::FunctionCall { name, args, .. } => Some((name.as_str(), args)),
                _ => None,
            })
            .collect::<Vec<_>>();
        self.blocked.remove(agent);
        let denied_save = agent == "main_agent" && calls.iter().any(|(name, _)| *name == "save_workflow_draft");
        if denied_save {
            self.blocked.insert(agent.into(), denied());
        }
        for (name, _) in &calls {
            ensure!(
                allowed.contains_key(*name) || denied_save,
                "tool `{name}` is not permitted for this turn"
            );
        }
        let mixed = calls.len() > 8
            || (calls.len() > 1
                && calls.iter().any(|(name, _)| {
                    !matches!(
                        *name,
                        "read_skill"
                            | "get_workflow_reference"
                            | "list_authoring_resources"
                            | "validate_workflow_draft"
                            | "get_workflow_draft"
                            | "list_capabilities"
                            | "list_workflow"
                            | "inspect_execution"
                            | "report_progress"
                            | "read_artifact"
                            | "inspect_operations"
                    )
                }));
        if mixed {
            self.blocked.insert(agent.into(), json!({"error":"Use at most 8 independent read/progress calls per response. Call writes, transfer and execution tools alone, after reading prior results.","executed":false}));
        }
        if let Some((_, args)) = calls.iter().find(|(name, _)| *name == "transfer_to_agent") {
            ensure!(!mixed && !denied_save, "SDK transfer must be isolated");
            if agent == "main_agent" {
                ensure!(
                    self.registry.authoring_allowed && self.registry.workflows_enabled && self.operation.is_none(),
                    "Workflow handoff is not authorized"
                );
                ensure!(
                    args["agent_name"] == "workflow_author",
                    "Invalid workflow handoff target"
                );
                workflow_agent::validate_request(&self.task)?;
                let record = json!({"id":uuid::Uuid::new_v4().to_string(),"kind":"workflow_authoring","sessionId":self.context.session_id,"modelProfileId":self.context.model_profile_id,"task":self.task,"status":"running","calls":[],"startedAt":chrono::Utc::now().to_rfc3339()});
                self.discovery
                    .context("Native discovery unavailable")?
                    .record_operation(&record)
                    .await?;
                self.operation = Some(record);
            } else {
                ensure!(args["agent_name"] == "main_agent", "Invalid specialist handoff target");
            }
        }
        if agent == "main_agent" {
            self.pending = Some(content.clone());
        }
        Ok(content)
    }
    async fn propose(&self, name: &str, args: &Value) -> Result<AssistantReply> {
        ensure!(
            self.registry.execution_allowed && self.registry.workflows_enabled,
            "Execution is not authorized"
        );
        let content = self.pending.clone().context("Missing signed execution proposal")?;
        if let Some(discovery) = self.discovery {
            let id = args[if name == "execute_capability" {
                "capability_id"
            } else {
                "workflow_id"
            }]
            .as_str()
            .context("workflow_id is required")?;
            let capability = if name == "execute_capability" {
                discovery.describe_capability(id).await?
            } else {
                discovery.describe(id).await?
            };
            protocol::parse_reply_with_history(content, &[capability], self.history)
        } else {
            protocol::parse_reply_with_history(content, self.registry.capabilities, self.history)
        }
    }
    async fn tool(&mut self, agent: &str, name: &str, mut args: Value) -> Result<Value> {
        if let Some(error) = self.blocked.get(agent) {
            return Ok(error.clone());
        }
        if agent == "workflow_author" {
            ensure!(
                workflow_agent::tools::declarations().contains_key(name),
                "Specialist tool is not permitted"
            );
            let discovery = self.discovery.context("Native authoring unavailable")?;
            let record = self.operation.as_mut().context("Missing authorized handoff")?;
            if name == "save_workflow_draft" {
                ensure!(self.saved.is_none(), "Workflow already saved for this handoff");
                args["operation_id"] = record["id"].clone();
                if let Some(id) = self.task["target_id"].as_str() {
                    args["target_id"] = json!(id);
                }
            }
            let index = record["calls"].as_array().unwrap().len();
            record["calls"]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name,"args":args,"status":"running"}));
            discovery.record_operation(record).await?;
            let result = match name {
                "read_skill" | "get_workflow_reference" | "report_progress" => {
                    workflow_agent::tools::read(&workflow_agent::skills::catalog(), name, &args)
                },
                "read_artifact" => discovery.direct(name, &args, &self.artifacts).await,
                "list_capabilities" => discovery.list_capabilities(&args).await,
                _ => discovery.authoring(name, &args).await,
            };
            let value = match result {
                Ok(value) => value,
                Err(error) => json!({"error":error.to_string()}),
            };
            if name == "save_workflow_draft"
                && value["validation"]["valid"] == true
                && value["capability_id"].is_string()
            {
                self.saved = Some(value.clone());
            }
            record["calls"][index]["status"] = json!(if value.get("error").is_some() {
                "failed"
            } else {
                "completed"
            });
            record["calls"][index]["result"] = value.clone();
            discovery.record_operation(record).await?;
            if name == "report_progress"
                && let Some(summary) = value["summary"].as_str()
            {
                (self.emit)(AssistantStreamEvent::Activity {
                    summary: summary.into(),
                })?;
            }
            return Ok(value);
        }
        match name {
            "prepare_workflow_task" => {
                ensure!(
                    self.registry.authoring_allowed && self.operation.is_none(),
                    "Workflow task preparation is not authorized"
                );
                workflow_agent::validate_request(&args)?;
                self.task = args;
                Ok(json!({"prepared":true,"executed":false,"next":"transfer_to_agent with agent_name workflow_author"}))
            },
            "inspect_operations" => match (self.discovery, self.context.session_id.as_deref()) {
                (Some(discovery), Some(id)) => discovery.inspect_operations(id).await,
                _ => bail!("Native operation history requires a session ID"),
            },
            "read_artifact" | "run_code" => {
                let discovery = self.discovery.context("Native direct tools unavailable")?;
                let mut record = json!({"id":uuid::Uuid::new_v4().to_string(),"sessionId":self.context.session_id,"kind":"direct_tool","name":name,"args":args,"status":"running","startedAt":chrono::Utc::now().to_rfc3339()});
                discovery.record_operation(&record).await?;
                let result = discovery.direct(name, &args, &self.artifacts).await;
                record["status"] = json!(if result.as_ref().is_ok_and(|value| value.get("error").is_none()) {
                    "completed"
                } else {
                    "failed"
                });
                record["endedAt"] = json!(chrono::Utc::now().to_rfc3339());
                record["result"] = match &result {
                    Ok(value) => value.clone(),
                    Err(error) => json!({"error":error.to_string()}),
                };
                discovery.record_operation(&record).await?;
                if let Ok(value) = &result
                    && let Some(artifacts) = value["artifacts"].as_array()
                {
                    for value in artifacts {
                        let reference: ArtifactRef = serde_json::from_value(value.clone())?;
                        if !self.artifacts.iter().any(|existing| existing.id == reference.id) {
                            self.artifacts.push(reference.clone());
                            self.produced.push(reference);
                        }
                    }
                }
                result
            },
            "list_capabilities" => match self.discovery {
                Some(discovery) => discovery.list_capabilities(&args).await,
                None => self.registry.read(name, &args),
            },
            "list_workflow" => match self.discovery {
                Some(discovery) => discovery.list(&args).await,
                None => self.registry.read(name, &args),
            },
            _ => {
                let value = self.registry.read(name, &args)?;
                if name == "report_progress" {
                    (self.emit)(AssistantStreamEvent::Activity {
                        summary: value["summary"].as_str().unwrap_or_default().into(),
                    })?;
                }
                Ok(value)
            },
        }
    }
    async fn finish(&mut self, text: &str, error: Option<String>) -> Result<Value> {
        let parsed = serde_json::from_str::<Value>(text).unwrap_or_default();
        let record = self
            .operation
            .as_mut()
            .context("Workflow finished without an authorized handoff")?;
        let result = if let Some(saved) = &self.saved {
            json!({"status":"completed","workflow_id":saved["capability_id"],"validation":saved["validation"],"summary":parsed.get("summary").cloned().unwrap_or(json!("Workflow saved and validated")),"assumptions":parsed["assumptions"],"executed":false})
        } else if error.is_none()
            && parsed["status"] == "needs_clarification"
            && parsed["questions"]
                .as_array()
                .is_some_and(|questions| !questions.is_empty())
        {
            json!({"status":"needs_clarification","summary":parsed["summary"],"questions":parsed["questions"],"executed":false})
        } else {
            json!({"status":"failed","summary":parsed.get("summary").cloned().unwrap_or(json!("The specialist did not save a validated workflow")),"error":error,"executed":false})
        };
        record["status"] = result["status"].clone();
        record["result"] = result.clone();
        record["endedAt"] = json!(chrono::Utc::now().to_rfc3339());
        self.discovery
            .context("Native discovery unavailable")?
            .record_operation(record)
            .await?;
        self.workflow_result = Some(result.clone());
        Ok(result)
    }
}
fn denied() -> Value {
    json!({"error":"Workflow editing is not authorized in this turn. No calls in this batch were performed. Report the actual run failure without saving or retrying.","permissionDenied":true,"executed":false})
}
