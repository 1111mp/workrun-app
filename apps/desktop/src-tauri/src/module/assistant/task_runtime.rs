//! Durable human-feedback gates. Graph checkpoints own control flow; native
//! operation journals still own side effects and reconcile uncertain writes.
use super::planning_agent::plans::Plan;
use adk_rust::graph::{
    Checkpointer, CompiledGraph, END, ExecutionConfig, GraphError, NodeOutput, START, SqliteCheckpointer, State,
    StateGraph,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{path::Path, sync::Arc};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interaction {
    pub id: String,
    pub task_id: String,
    pub thread_id: String,
    pub checkpoint_id: String,
    pub kind: String,
    pub version: u32,
    pub status: String,
}

pub struct TaskRuntime {
    graph: CompiledGraph,
    checkpoints: Arc<SqliteCheckpointer>,
}
impl TaskRuntime {
    pub async fn open(root: &Path) -> Result<Self> {
        let directory = root.join("assistant");
        std::fs::create_dir_all(&directory)?;
        // ADK and the application currently use different sqlx versions; let
        // ADK own its pool rather than sharing incompatible Pool types.
        let database = directory.join("tasks.sqlite");
        let url = format!(
            "sqlite://{}?mode=rwc",
            database.to_str().context("Invalid task database path")?
        );
        let checkpoints = Arc::new(SqliteCheckpointer::new(&url).await?);
        let graph = StateGraph::with_channels(&["request", "decision", "outcome", "stage"])
            .add_node_fn("review", |ctx| async move {
                match ctx.state.get("decision").and_then(Value::as_str) {
                    Some("approve") => Ok(NodeOutput::new().with_update(
                        "stage",
                        ctx.state
                            .get("request")
                            .and_then(|r| r.get("effectStage"))
                            .cloned()
                            .unwrap_or(json!("creating")),
                    )),
                    Some("cancel") => Ok(NodeOutput::new()
                        .with_update("stage", json!("cancelled"))
                        .with_goto([END])),
                    _ => Ok(NodeOutput::interrupt_with_data(
                        "assistant.user_feedback",
                        ctx.state.get("request").cloned().unwrap_or(Value::Null),
                    )),
                }
            })
            .add_node_fn("create", |ctx| async move {
                if let Some(outcome) = ctx.state.get("outcome").filter(|v| !v.is_null()) {
                    Ok(NodeOutput::new().with_update("stage", outcome["status"].clone()))
                } else {
                    // Dispatch belongs to the native host. Its stable operation ID
                    // is derived from this frozen plan, never from a model response.
                    Ok(NodeOutput::interrupt_with_data(
                        "assistant.native_effect",
                        ctx.state.get("request").cloned().unwrap_or(Value::Null),
                    ))
                }
            })
            .add_edge(START, "review")
            .add_edge("review", "create")
            .add_edge("create", END)
            .compile()?
            .with_checkpointer_arc(checkpoints.clone());
        Ok(Self { graph, checkpoints })
    }
    fn thread(plan: &Plan) -> Result<String> {
        uuid::Uuid::parse_str(&plan.session_id)?;
        uuid::Uuid::parse_str(&plan.id)?;
        Ok(format!("{}/{}/v{}", plan.session_id, plan.id, plan.version))
    }
    fn request(plan: &Plan) -> Value {
        json!({"id":format!("{}:v{}",plan.id,plan.version),"taskId":plan.id,"sessionId":plan.session_id,"version":plan.version,
            "kind":if plan.status=="needs_clarification" {"clarification"} else {"plan_confirmation"},
            "document":plan.document,"dependencyIssues":plan.dependency_issues})
    }
    async fn invoke(&self, thread: &str, state: State) -> Result<()> {
        match self.graph.invoke(state, ExecutionConfig::new(thread)).await {
            Ok(_) | Err(GraphError::Interrupted(_)) => Ok(()),
            Err(error) => Err(error.into()),
        }
    }
    pub async fn suspend(&self, plan: &Plan) -> Result<()> {
        let thread = Self::thread(plan)?;
        if let Some(checkpoint) = self.checkpoints.load(&thread).await? {
            ensure!(
                checkpoint.state.get("request") == Some(&Self::request(plan)),
                "Task request changed without a new version"
            );
            return Ok(());
        }
        self.invoke(
            &thread,
            State::from([
                ("request".into(), Self::request(plan)),
                ("stage".into(), json!("waiting")),
            ]),
        )
        .await
    }
    pub async fn interaction(&self, plan: &Plan) -> Result<Option<Interaction>> {
        let thread = Self::thread(plan)?;
        let Some(checkpoint) = self.checkpoints.load(&thread).await? else {
            return Ok(None);
        };
        let request = checkpoint.state.get("request").context("Task request missing")?;
        let status = checkpoint
            .state
            .get("stage")
            .and_then(Value::as_str)
            .context("Task stage missing")?;
        Ok(Some(Interaction {
            id: request["id"].as_str().context("Interaction ID missing")?.into(),
            task_id: plan.id.clone(),
            thread_id: thread,
            checkpoint_id: checkpoint.checkpoint_id,
            kind: request["kind"].as_str().context("Interaction kind missing")?.into(),
            version: plan.version,
            status: status.into(),
        }))
    }
    pub async fn decide(&self, plan: &Plan, approve: bool) -> Result<()> {
        let thread = Self::thread(plan)?;
        let checkpoint = self
            .checkpoints
            .load(&thread)
            .await?
            .context("No checkpoint awaiting feedback")?;
        let state = &checkpoint.state;
        ensure!(
            state.get("request").is_some_and(|r| r["taskId"] == plan.id
                && r["version"] == plan.version
                && r["sessionId"] == plan.session_id),
            "Feedback belongs to a different task"
        );
        let decision = if approve { "approve" } else { "cancel" };
        // Repeated delivery of the same feedback is harmless. A different
        // decision after consumption cannot rewind the graph into review.
        if !approve && plan.status == "failed" && state.get("stage").and_then(Value::as_str) == Some("failed") {
            self.graph
                .update_state(
                    &thread,
                    [
                        ("stage".into(), json!("cancelled")),
                        ("decision".into(), json!("cancel")),
                    ],
                )
                .await?;
            return self.invoke(&thread, State::new()).await;
        }
        if !approve && plan.status == "approved" && state.get("stage").and_then(Value::as_str) == Some("creating") {
            self.graph
                .update_state(
                    &thread,
                    [
                        ("outcome".into(), json!({"status":"cancelled"})),
                        ("decision".into(), json!("cancel")),
                    ],
                )
                .await?;
            return self.invoke(&thread, State::new()).await;
        }
        if state.get("stage").and_then(Value::as_str) != Some("waiting") {
            ensure!(
                state.get("decision").and_then(Value::as_str) == Some(decision),
                "Feedback has already been consumed"
            );
            return Ok(());
        }
        if approve {
            ensure!(
                plan.document.questions.is_empty() && plan.dependency_issues.is_empty(),
                "Resolve questions before approving"
            );
        }
        self.graph
            .update_state(&thread, [("decision".into(), json!(decision))])
            .await?;
        self.invoke(&thread, State::new()).await
    }
    pub async fn require_creation(&self, plan: &Plan) -> Result<()> {
        let thread = Self::thread(plan)?;
        let checkpoint = self
            .checkpoints
            .load(&thread)
            .await?
            .context("Creation checkpoint missing")?;
        ensure!(
            checkpoint.state.get("stage") == Some(&json!("creating"))
                && checkpoint.state.get("decision") == Some(&json!("approve")),
            "Task is not authorized to create a workflow"
        );
        Ok(())
    }
    pub async fn finish(&self, plan: &Plan) -> Result<()> {
        let thread = Self::thread(plan)?;
        if self.interaction(plan).await?.is_some_and(|i| i.status == plan.status) {
            return Ok(());
        }
        self.require_creation(plan).await?;
        self.graph
            .update_state(
                &thread,
                [("outcome".into(), json!({"status":plan.status,"result":plan.outcome}))],
            )
            .await?;
        self.invoke(&thread, State::new()).await
    }
    fn tool_thread(record: &Value) -> Result<String> {
        let session = record["sessionId"].as_str().context("Tool session missing")?;
        let id = uuid::Uuid::parse_str(record["id"].as_str().context("Tool operation missing")?)?;
        ensure!(!session.is_empty(), "Tool session missing");
        Ok(format!("{session}/tools/{id}"))
    }
    fn tool_request(record: &Value) -> Value {
        json!({"id":format!("tool:{}",record["id"].as_str().unwrap_or_default()),"taskId":record["id"],"sessionId":record["sessionId"],"version":1,"kind":"tool_confirmation","effectStage":"executing", "tool":record["tool"],"arguments":record["arguments"],"implementation":record["implementation"]})
    }
    pub async fn suspend_tool(&self, record: &Value) -> Result<()> {
        let thread = Self::tool_thread(record)?;
        let request = Self::tool_request(record);
        if let Some(checkpoint) = self.checkpoints.load(&thread).await? {
            ensure!(
                checkpoint.state.get("request") == Some(&request),
                "Frozen tool request changed"
            );
            return Ok(());
        }
        self.invoke(
            &thread,
            State::from([("request".into(), request), ("stage".into(), json!("waiting"))]),
        )
        .await
    }
    pub async fn tool_interaction(&self, record: &Value) -> Result<Option<Interaction>> {
        let thread = Self::tool_thread(record)?;
        let Some(checkpoint) = self.checkpoints.load(&thread).await? else {
            return Ok(None);
        };
        ensure!(
            checkpoint.state.get("request") == Some(&Self::tool_request(record)),
            "Frozen tool request changed"
        );
        Ok(Some(Interaction {
            id: format!("tool:{}", record["id"].as_str().context("Tool operation missing")?),
            task_id: record["id"].as_str().unwrap().into(),
            thread_id: thread,
            checkpoint_id: checkpoint.checkpoint_id,
            kind: "tool_confirmation".into(),
            version: 1,
            status: checkpoint
                .state
                .get("stage")
                .and_then(Value::as_str)
                .context("Task stage missing")?
                .into(),
        }))
    }
    pub async fn decide_tool(&self, record: &Value, approve: bool) -> Result<()> {
        let thread = Self::tool_thread(record)?;
        let checkpoint = self
            .checkpoints
            .load(&thread)
            .await?
            .context("Tool confirmation checkpoint missing")?;
        ensure!(
            checkpoint.state.get("request") == Some(&Self::tool_request(record)),
            "Tool confirmation scope changed"
        );
        let stage = checkpoint
            .state
            .get("stage")
            .and_then(Value::as_str)
            .context("Task stage missing")?;
        if approve {
            ensure!(
                matches!(stage, "waiting" | "executing"),
                "Tool confirmation was already closed"
            );
            if stage == "executing" {
                return Ok(());
            }
        } else if stage == "cancelled" {
            return Ok(());
        } else if stage == "executing" {
            // Only the native journal's undispatched record may withdraw this gate.
            ensure!(
                record["status"] == "awaiting_confirmation",
                "Tool operation is already in progress"
            );
            self.graph
                .update_state(&thread, [("outcome".into(), json!({"status":"cancelled"}))])
                .await?;
            return self.invoke(&thread, State::new()).await;
        } else {
            ensure!(stage == "waiting", "Tool confirmation was already closed");
        }
        self.graph
            .update_state(
                &thread,
                [("decision".into(), json!(if approve { "approve" } else { "cancel" }))],
            )
            .await?;
        self.invoke(&thread, State::new()).await
    }
    pub async fn require_tool(&self, record: &Value) -> Result<()> {
        let thread = Self::tool_thread(record)?;
        let checkpoint = self
            .checkpoints
            .load(&thread)
            .await?
            .context("Tool checkpoint missing")?;
        ensure!(
            checkpoint.state.get("request") == Some(&Self::tool_request(record))
                && checkpoint.state.get("stage") == Some(&json!("executing"))
                && checkpoint.state.get("decision") == Some(&json!("approve")),
            "Tool task is not authorized to execute"
        );
        Ok(())
    }
    pub async fn finish_tool(&self, record: &Value) -> Result<()> {
        let thread = Self::tool_thread(record)?;
        let interaction = self
            .tool_interaction(record)
            .await?
            .context("Tool checkpoint missing")?;
        if record["status"] == interaction.status {
            return Ok(());
        }
        self.require_tool(record).await?;
        self.graph
            .update_state(
                &thread,
                [(
                    "outcome".into(),
                    json!({"status":record["status"],"operationId":record["id"]}),
                )],
            )
            .await?;
        self.invoke(&thread, State::new()).await
    }
    pub async fn decorate(&self, plan: &Plan) -> Result<Value> {
        let mut value = serde_json::to_value(plan)?;
        value["interaction"] = serde_json::to_value(self.interaction(plan).await?)?;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::assistant::{
        planning_agent::plans::{Document, Store},
        planning_tests,
    };

    fn proposal(root: &Path) -> Plan {
        Store::new(root)
            .save(
                &uuid::Uuid::new_v4().to_string(),
                "proposal-turn",
                0,
                Document::parse(&planning_tests::document()).unwrap(),
                vec![],
            )
            .unwrap()
    }
    #[tokio::test]
    async fn sqlite_pause_survives_new_runtime_and_requires_feedback_before_creation() {
        let directory = tempfile::tempdir().unwrap();
        let plan = proposal(directory.path());
        let tasks = TaskRuntime::open(directory.path()).await.unwrap();
        tasks.suspend(&plan).await.unwrap();
        let waiting = tasks.interaction(&plan).await.unwrap().unwrap();
        assert_eq!(waiting.status, "waiting");
        assert!(tasks.require_creation(&plan).await.is_err());
        drop(tasks);
        let tasks = TaskRuntime::open(directory.path()).await.unwrap();
        assert_eq!(
            tasks.interaction(&plan).await.unwrap().unwrap().checkpoint_id,
            waiting.checkpoint_id
        );
        // Merely reading/explaining a task cannot resume it.
        tasks.suspend(&plan).await.unwrap();
        assert!(tasks.require_creation(&plan).await.is_err());
        tasks.decide(&plan, true).await.unwrap();
        tasks.require_creation(&plan).await.unwrap();
        assert_eq!(tasks.interaction(&plan).await.unwrap().unwrap().status, "creating");
        let checkpoint = tasks.interaction(&plan).await.unwrap().unwrap().checkpoint_id;
        tasks.decide(&plan, true).await.unwrap();
        assert_eq!(
            tasks.interaction(&plan).await.unwrap().unwrap().checkpoint_id,
            checkpoint
        );
        assert!(tasks.decide(&plan, false).await.is_err());
        drop(tasks);
        let tasks = TaskRuntime::open(directory.path()).await.unwrap();
        tasks.require_creation(&plan).await.unwrap();
        let mut saved = plan.clone();
        saved.status = "saved".into();
        saved.outcome = Some(json!({"workflow_id":uuid::Uuid::new_v4().to_string()}));
        tasks.finish(&saved).await.unwrap();
        tasks.finish(&saved).await.unwrap();
        assert_eq!(tasks.interaction(&saved).await.unwrap().unwrap().status, "saved");
        assert!(tasks.require_creation(&saved).await.is_err());
        assert!(
            tasks
                .checkpoints
                .load(&TaskRuntime::thread(&saved).unwrap())
                .await
                .unwrap()
                .unwrap()
                .pending_nodes
                .is_empty()
        );
    }
    #[tokio::test]
    async fn revisions_cancellation_questions_and_other_sessions_cannot_release_a_gate() {
        let directory = tempfile::tempdir().unwrap();
        let old = proposal(directory.path());
        let tasks = TaskRuntime::open(directory.path()).await.unwrap();
        tasks.suspend(&old).await.unwrap();
        let mut revised = old.clone();
        revised.version += 1;
        revised.document.questions.push("Which resource should be used?".into());
        revised.status = "needs_clarification".into();
        tasks.suspend(&revised).await.unwrap();
        tasks.decide(&old, false).await.unwrap();
        tasks.decide(&old, false).await.unwrap();
        assert!(tasks.decide(&old, true).await.is_err());
        assert!(tasks.decide(&revised, true).await.is_err());
        assert_eq!(tasks.interaction(&revised).await.unwrap().unwrap().status, "waiting");
        let mut wrong_session = revised.clone();
        wrong_session.session_id = uuid::Uuid::new_v4().to_string();
        assert!(tasks.decide(&wrong_session, true).await.is_err());
        tasks.decide(&revised, false).await.unwrap();
        assert!(tasks.require_creation(&revised).await.is_err());
    }
}
