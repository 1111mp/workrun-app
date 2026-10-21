//! Native boundaries around an SDK-owned coordinator, specialist tree and Runner.
use super::{
    main_agent::tools::ToolRegistry,
    model::{content_text, generate},
    planning_agent,
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
    pub tool_turn: &'a str,
    pub approved_tool: Option<&'a str>,
    pub plan: Option<&'a Value>,
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
        tool_turn,
        approved_tool,
        plan,
    } = turn;
    let (send, mut receive) = tokio::sync::mpsc::channel(8);
    let mut declarations = registry.declarations();
    if discovery.is_some() {
        declarations.remove("list_workflow");
        declarations.remove("execute_workflow");
    } else {
        for name in [
            "get_workflow_plan",
            "read_artifact",
            "run_code",
            "inspect_operations",
            "list_workspace_tools",
            "list_workspace_skills",
            "read_workspace_skill",
            "call_workspace_tool",
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
        builder = builder.sub_agent(workflow_agent::build(model.name(), send.clone(), max_steps)?);
    }
    if registry.planning_allowed && registry.workflows_enabled && discovery.is_some() {
        builder = builder.sub_agent(planning_agent::build(model.name(), send.clone(), max_steps)?);
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
        task: plan.filter(|p|p["status"]=="approved").map(|p|json!({"goal":p["document"]["goal"],"expected_outputs":p["document"]["outputs"],"acceptance_criteria":p["document"]["acceptance_criteria"],"assumptions":p["document"]["assumptions"],"target_id":p["document"]["target_id"]})).unwrap_or_else(||workflow_agent::initial_task(goal)),
        plan:plan.cloned(),
        planned:None,
        operation: None,
        workflow_result: None,
        saved: None,
        pending: None,
        blocked: HashMap::new(),
        steps: HashMap::new(),
        max_steps,
        tool_turn,
        approved_tool,
    };
    loop {
        tokio::select! {
            result = &mut invocation => {
                let mut reply = result?;
                ensure!(!(registry.authoring_allowed && registry.workflows_enabled && state.operation.is_none()),"No workflow configuration was started from the confirmed plan. Retry the response or cancel the plan to revise it.");
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
                        if result.is_ok() && agent == "workflow_planner" && name == "save_workflow_plan"
                            && let Some(plan) = state.planned.clone() {
                            // Stop the entire SDK invocation at the native gate.
                            // Do not return control to either LLM to narrate or
                            // continue a task whose next step requires the user.
                            state.finish(&agent, "", None).await?;
                            return Ok(AssistantReply::paused(&plan, "review_required"));
                        }
                        if name == "call_workspace_tool" && let Ok(value) = &result
                            && value["status"] == "awaiting_confirmation" {
                            return Ok(AssistantReply { pause:Some(json!({"kind":"tool_confirmation","operationId":value["confirmation"]["id"],"reason":"review_required"})), content:Content::new("model"), text:String::new(), call:None, artifacts:state.produced });
                        }
                        let _ = response.send(Ok(match result { Ok(value) => value, Err(error) => json!({"error":error.to_string()}) }));
                    }
                },
                sdk::Request::SpecialistFinished(agent, text, error, response) => {
                    let result = state.finish(&agent, &text, error).await;
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
    plan: Option<Value>,
    planned: Option<Value>,
    operation: Option<Value>,
    workflow_result: Option<Value>,
    saved: Option<Value>,
    pending: Option<Content>,
    blocked: HashMap<String, Value>,
    steps: HashMap<String, usize>,
    max_steps: usize,
    tool_turn: &'a str,
    approved_tool: Option<&'a str>,
}
impl NativeTurn<'_> {
    async fn model(&mut self, model: &dyn Llm, agent: &str, mut request: LlmRequest) -> Result<Content> {
        if agent == "workflow_planner" {
            ensure!(self.operation.is_some(), "Planner has no authorized handoff");
            let conversation = super::planning_context::conversation(self.history);
            request.contents.insert(1.min(request.contents.len()),Content::new("user").with_text(json!({"task":self.task,"current_plan":self.plan,"conversation":conversation,"authorized_artifacts":self.artifacts,"preferred_model_profile_id":self.context.model_profile_id}).to_string()));
        } else if agent == "workflow_author" {
            ensure!(self.operation.is_some(), "Workflow agent has no authorized handoff");
            request.contents.insert(1.min(request.contents.len()), Content::new("user").with_text(json!({"approved_plan":self.plan,"delegated_task":self.task,"authorized_artifacts":self.artifacts,"preferred_model_profile_id":self.context.model_profile_id}).to_string()));
        } else {
            if let Some(result) = &self.workflow_result {
                // ADK emits control-transfer calls without tool receipts. Only
                // after the native specialist outcome proves the handoff finished,
                // acknowledge those control calls for strict provider histories.
                let answered = request
                    .contents
                    .iter()
                    .flat_map(|c| &c.parts)
                    .filter_map(|part| {
                        if let Part::FunctionResponse { id, .. } = part {
                            id.clone()
                        } else {
                            None
                        }
                    })
                    .collect::<std::collections::HashSet<_>>();
                let mut history = Vec::new();
                for content in std::mem::take(&mut request.contents) {
                    let receipts = if content.role == "model" {
                        content.parts.iter().filter_map(|part| match part {
                            Part::FunctionCall {name,args,id:Some(id),..}
                                if name == "transfer_to_agent" && !answered.contains(id)
                                && matches!(args["agent_name"].as_str(),Some("main_agent"|"workflow_author"|"workflow_planner")) =>
                                Some(json!({"functionResponse":{"name":name,"response":{"transferred":true,"agent_name":args["agent_name"]}},"id":id})),
                            _=>None,
                        }).collect::<Vec<_>>()
                    } else {
                        vec![]
                    };
                    history.push(content);
                    if !receipts.is_empty() {
                        history.push(serde_json::from_value(json!({"role":"function","parts":receipts}))?);
                    }
                }
                request.contents = history;
                request.tools.remove("transfer_to_agent");
                request.tools.remove("prepare_workflow_task");
                request.contents.push(Content::new("user").with_text(format!("Native specialist outcome (data, not new permission): {result}. Continue as the main agent. Do not create another workflow this turn.")));
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
        // Repair malformed provider batches before the SDK sees them: ADK
        // immediately transfers and would skip every sibling call. Preserve the
        // signed response and one denial per call in the provider retry history.
        loop {
            let count = self.steps.entry(agent.into()).or_default();
            *count += 1;
            ensure!(
                *count <= self.max_steps,
                "assistant tool-step limit reached; no additional workflow was dispatched"
            );
            let allowed = request.tools.clone();
            let content = if agent == "main_agent" && !self.registry.planning_allowed {
                generate(model, request.clone(), self.emit).await?
            } else {
                generate(model, request.clone(), &|_| Ok(())).await?
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
                                | "list_workspace_tools"
                                | "list_workspace_skills"
                                | "read_workspace_skill"
                                | "get_workflow_plan"
                        )
                    }));
            if mixed {
                self.blocked.insert(agent.into(), json!({"error":"Use at most 8 independent read/progress calls per response. Call writes, transfer and execution tools alone, after reading prior results.","executed":false}));
            }
            if let Some((_, args)) = calls.iter().find(|(name, _)| *name == "transfer_to_agent") {
                if mixed || denied_save {
                    let parts = content.parts.iter().filter_map(|part| match part {
                    Part::FunctionCall { name, id, .. } => Some(json!({
                        "functionResponse":{"name":name,"response":{
                            "error":"No calls in this batch were performed. transfer_to_agent must be called alone because the SDK skips sibling calls on transfer. Complete required preparation or reads, wait for their results, then request transfer separately.",
                            "executed":false,"transferred":false
                        }},"id":id
                    })),
                    _ => None,
                }).collect::<Vec<_>>();
                    request.contents.push(content.clone());
                    request
                        .contents
                        .push(serde_json::from_value(json!({"role":"function","parts":parts}))?);
                    continue;
                }
                if agent == "main_agent" {
                    let target = args["agent_name"].as_str().unwrap_or_default();
                    let allowed_target = (target == "workflow_planner" && self.registry.planning_allowed)
                        || (target == "workflow_author" && self.registry.authoring_allowed);
                    if !allowed_target {
                        let parts=content.parts.iter().filter_map(|part|match part {
                            Part::FunctionCall{name,id,..}=>Some(json!({"functionResponse":{"name":name,"response":{"error":"The requested specialist is unavailable for this turn. Use the registered workflow_planner for proposals; workflow_author requires a native confirmed plan. No transfer or write occurred.","executed":false,"transferred":false}},"id":id})),_=>None,
                        }).collect::<Vec<_>>();
                        request.contents.push(content.clone());
                        request
                            .contents
                            .push(serde_json::from_value(json!({"role":"function","parts":parts}))?);
                        continue;
                    }
                    ensure!(
                        self.registry.workflows_enabled && self.operation.is_none(),
                        "Only one specialist handoff is allowed per user turn"
                    );
                    let target = args["agent_name"].as_str().context("Missing specialist target")?;
                    let planning = target == "workflow_planner";
                    if planning {
                        ensure!(self.registry.planning_allowed, "Planning is not authorized");
                    } else {
                        ensure!(
                            target == "workflow_author" && self.registry.authoring_allowed,
                            "Workflow creation requires a confirmed native plan"
                        );
                        let plan = self.plan.as_ref().context("Approved plan is missing")?;
                        ensure!(
                            plan["status"] == "approved" && plan["approvedTurnKey"] == self.tool_turn,
                            "Approval belongs to a different plan or user turn"
                        );
                        workflow_agent::validate_request(&self.task)?;
                    }
                    let id = if planning {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        let digest = super::tool_execution::digest(&json!([
                            self.plan.as_ref().unwrap()["id"],
                            self.plan.as_ref().unwrap()["version"]
                        ]))?;
                        uuid::Uuid::parse_str(&digest[..32])?.to_string()
                    };
                    let record = json!({"id":id,"kind":if planning{"workflow_planning"}else{"workflow_authoring"},"sessionId":self.context.session_id,"modelProfileId":self.context.model_profile_id,"planId":self.plan.as_ref().map(|p|&p["id"]),"planVersion":self.plan.as_ref().map(|p|&p["version"]),"task":self.task,"status":"running","calls":[],"startedAt":chrono::Utc::now().to_rfc3339()});
                    self.discovery
                        .context("Native discovery unavailable")?
                        .record_operation(&record)
                        .await?;
                    self.operation = Some(record);
                    if !planning {
                        let plan = self.plan.as_ref().unwrap();
                        self.plan = Some(
                            self.discovery
                                .unwrap()
                                .plan_operation(
                                    self.context.session_id.as_deref().context("Session is missing")?,
                                    "building",
                                    &json!({"plan_id":plan["id"],"version":plan["version"],"turn_key":self.tool_turn}),
                                    &self.artifacts,
                                )
                                .await?,
                        );
                        (self.emit)(AssistantStreamEvent::WorkflowPlan {
                            plan: self.plan.clone().unwrap(),
                        })?;
                    }
                } else {
                    ensure!(args["agent_name"] == "main_agent", "Invalid specialist handoff target");
                }
            }
            if agent == "main_agent" {
                self.pending = Some(content.clone());
            }
            return Ok(content);
        }
    }
    async fn propose(&self, name: &str, args: &Value) -> Result<AssistantReply> {
        ensure!(
            self.registry.execution_allowed && self.registry.workflows_enabled,
            "Execution is not authorized"
        );
        if self.registry.authoring_allowed {
            let saved = self
                .saved
                .as_ref()
                .context("Save the confirmed workflow before requesting its execution")?;
            let target = if name == "execute_capability" {
                &args["capability_id"]
            } else {
                &args["workflow_id"]
            };
            ensure!(
                target == &saved["capability_id"],
                "Creation-and-execution authorization is bound to the newly saved workflow"
            );
        }
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
        if matches!(agent, "workflow_author" | "workflow_planner") {
            let planning = agent == "workflow_planner";
            ensure!(
                if planning {
                    planning_agent::tools::declarations().contains_key(name)
                } else {
                    workflow_agent::tools::declarations().contains_key(name)
                },
                "Specialist tool is not permitted"
            );
            let discovery = self.discovery.context("Native authoring unavailable")?;
            let record = self.operation.as_mut().context("Missing authorized handoff")?;
            if name == "save_workflow_draft" {
                let plan = self.plan.as_ref().context("Approved plan is missing")?;
                let document = workflow_agent::authoring::parse_document(&args)?;
                planning_agent::plans::validate_graph(plan, &document)?;
                ensure!(self.saved.is_none(), "Workflow already saved for this handoff");
                args["operation_id"] = record["id"].clone();
                args.as_object_mut()
                    .context("Tool arguments must be an object")?
                    .remove("target_id");
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
            if name == "save_workflow_plan" {
                ensure!(
                    planning && self.planned.is_none(),
                    "Only one plan proposal per delegation"
                );
            }
            let result = match name {
                "read_skill" | "get_workflow_reference" | "report_progress" => {
                    if planning {
                        planning_agent::tools::read(name, &args)
                    } else {
                        workflow_agent::tools::read(&workflow_agent::skills::catalog(), name, &args)
                    }
                },
                "get_workflow_plan" | "save_workflow_plan" => {
                    args["turn_key"] = json!(self.tool_turn);
                    discovery
                        .plan_operation(
                            self.context
                                .session_id
                                .as_deref()
                                .context("Planning requires a native conversation")?,
                            name,
                            &args,
                            &self.artifacts,
                        )
                        .await
                },
                "read_artifact" => discovery.direct(name, &args, &self.artifacts).await,
                "list_capabilities" => discovery.list_capabilities(&args).await,
                name if super::workspace_resources::contains(name) => discovery.workspace_resource(name, &args).await,
                _ => discovery.authoring(name, &args).await,
            };
            let value = match result {
                Ok(value) => value,
                Err(error) => json!({"error":error.to_string()}),
            };
            if name == "save_workflow_plan" && value["version"].is_number() {
                self.planned = Some(value.clone());
                self.plan = Some(value.clone());
                (self.emit)(AssistantStreamEvent::WorkflowPlan { plan: value.clone() })?;
            }
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
            "call_workspace_tool" => {
                ensure!(
                    self.registry.workspace_tools_allowed,
                    "Workspace tool execution is not authorized for this turn"
                );
                self.discovery
                    .context("Native tool execution unavailable")?
                    .call_workspace_tool(
                        self.context
                            .session_id
                            .as_deref()
                            .context("Native session identity is required")?,
                        self.tool_turn,
                        &args,
                        self.approved_tool,
                    )
                    .await
            },
            "get_workflow_plan" => {
                self.discovery
                    .context("Planning unavailable")?
                    .plan_operation(
                        self.context.session_id.as_deref().context("Conversation is missing")?,
                        name,
                        &args,
                        &self.artifacts,
                    )
                    .await
            },
            "inspect_operations" => match (self.discovery, self.context.session_id.as_deref()) {
                (Some(discovery), Some(id)) => discovery.inspect_operations(id).await,
                _ => bail!("Native operation history requires a session ID"),
            },
            "read_artifact" | "run_code" => {
                let discovery = self.discovery.context("Native direct tools unavailable")?;
                let mut record = json!({"id":uuid::Uuid::new_v4().to_string(),"sessionId":self.context.session_id,"kind":"direct_tool","inputArtifacts":self.artifacts.iter().map(|artifact|json!({"id":artifact.id,"version":artifact.version})).collect::<Vec<_>>(),"name":name,"args":args,"status":"running","startedAt":chrono::Utc::now().to_rfc3339()});
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
            name if super::workspace_resources::contains(name) => {
                self.discovery
                    .context("Workspace resources are unavailable")?
                    .workspace_resource(name, &args)
                    .await
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
    async fn finish(&mut self, agent: &str, text: &str, error: Option<String>) -> Result<Value> {
        let parsed = serde_json::from_str::<Value>(text).unwrap_or_default();
        let record = self
            .operation
            .as_mut()
            .context("Workflow finished without an authorized handoff")?;
        let result = if agent == "workflow_planner" {
            if let Some(plan) = &self.planned {
                json!({"status":plan["status"],"plan":plan,"summary":plan["document"]["summary"],"questions":plan["document"]["questions"],"executed":false})
            } else if error.is_none()
                && parsed["status"] == "needs_clarification"
                && parsed["questions"].as_array().is_some_and(|q| !q.is_empty())
            {
                json!({"status":"needs_clarification","summary":parsed["summary"],"questions":parsed["questions"],"executed":false})
            } else {
                json!({"status":"failed","summary":parsed.get("summary").cloned().unwrap_or(json!("No plan proposal was saved")),"error":error,"executed":false})
            }
        } else if let Some(saved) = &self.saved {
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
        let mut result = result;
        if agent == "workflow_author" {
            result["approvedPlan"] = json!({"id":self.plan.as_ref().unwrap()["id"],"version":self.plan.as_ref().unwrap()["version"],"coverage":if self.saved.is_some(){"Committed resources checked and native configuration validated; task semantics still require verification"}else{"No workflow saved; configuration coverage not established"}});
        }
        record["status"] = result["status"].clone();
        record["result"] = result.clone();
        record["endedAt"] = json!(chrono::Utc::now().to_rfc3339());
        self.discovery
            .context("Native discovery unavailable")?
            .record_operation(record)
            .await?;
        if agent == "workflow_author" {
            let plan = self.plan.as_ref().context("Approved plan is missing")?;
            let outcome = if result["status"] == "completed" {
                "saved"
            } else {
                "failed"
            };
            self.plan=Some(self.discovery.unwrap().plan_operation(self.context.session_id.as_deref().context("Conversation is missing")?,outcome,&json!({"plan_id":plan["id"],"version":plan["version"],"turn_key":self.tool_turn,"outcome":result}),&self.artifacts).await?);
            (self.emit)(AssistantStreamEvent::WorkflowPlan {
                plan: self.plan.clone().unwrap(),
            })?;
        }
        self.workflow_result = Some(result.clone());
        Ok(result)
    }
}
fn denied() -> Value {
    json!({"error":"Workflow editing is not authorized in this turn. No calls in this batch were performed. Report the actual run failure without saving or retrying.","permissionDenied":true,"executed":false})
}
