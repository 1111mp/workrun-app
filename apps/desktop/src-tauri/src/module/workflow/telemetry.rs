//! One transparent execution boundary; ADK owns model and tool spans beneath it.
use super::*;
use crate::core::{telemetry as config, telemetry_langfuse as view};
use tracing::Instrument;

struct ObservedNode {
    inner: Arc<dyn Node>,
    name: String,
    kind: String,
    state: SharedWorkflowState,
    origin: crate::module::model_usage::CallContext,
    parent: tracing::Span,
    edges: Vec<WorkflowEdge>,
}
pub(super) fn wrap(graph: &mut StateGraph, dsl: &WorkflowDsl, state: &SharedWorkflowState) {
    let label = |node: &WorkflowNode| {
        node.data
            .get("name")
            .or_else(|| node.data.get("label"))
            .and_then(Value::as_str)
            .unwrap_or(&node.id)
            .to_owned()
    };
    for (id, inner) in &mut graph.nodes {
        let Some(node) = dsl.nodes.iter().find(|n| &n.id == id) else {
            continue;
        };
        let name = label(node);
        let name = if dsl.nodes.iter().filter(|n| label(n) == name).count() > 1 {
            format!("{name} [{id}]")
        } else {
            name
        };
        *inner = Arc::new(ObservedNode {
            inner: inner.clone(),
            name,
            kind: node.kind.clone(),
            state: state.clone(),
            origin: crate::module::model_usage::current(),
            parent: tracing::Span::current(),
            edges: dsl.edges.iter().filter(|e| &e.source == id).cloned().collect(),
        });
    }
}
fn selected_route(id: &str, output: &NodeOutput) -> Option<String> {
    output
        .updates
        .get(&format!("workflow.route.{id}"))
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            let node = output.updates.get("workflow.node")?;
            match node["type"].as_str()? {
                "human_review" => node["result"]["approved"]
                    .as_bool()
                    .map(|v| if v { "approved" } else { "rejected" }.to_owned()),
                "ask_user_question" => node["result"]["optionId"].as_str().map(|id| format!("option:{id}")),
                _ => None,
            }
        })
}
struct Observation(tracing::Span, bool);
impl Drop for Observation {
    fn drop(&mut self) {
        if !self.1 {
            self.0.record("langfuse.observation.metadata.status", "interrupted");
        }
    }
}
impl ObservedNode {
    fn start(&self, context: &NodeContext) -> Observation {
        let span = tracing::info_span!(parent:&self.parent,"workrun.node",
            "otel.name"=%self.name,"langfuse.observation.type"="chain",
            "langfuse.session.id"=self.origin.session_id.as_deref().or(self.origin.run_id.as_deref()).unwrap_or(""),
            "langfuse.observation.metadata.runId"=self.origin.run_id.as_deref().unwrap_or(""),
            "langfuse.observation.metadata.nodeId"=self.inner.name(),
            "langfuse.observation.metadata.nodeKind"=%self.kind,
            "langfuse.observation.metadata.step"=context.step as u64,
            "langfuse.observation.metadata.executionPath"=%context.config.metadata.get("workrun.execution_path").unwrap_or(&serde_json::Value::Null),
            "langfuse.observation.metadata.status"=tracing::field::Empty,
            "langfuse.observation.metadata.selectedRoute"=tracing::field::Empty,
            "langfuse.observation.metadata.targets"=tracing::field::Empty,
            "langfuse.observation.level"=tracing::field::Empty,
            "langfuse.observation.input"=tracing::field::Empty,"langfuse.observation.output"=tracing::field::Empty);
        if config::capture_content()
            && let Ok(state) = self.state.lock()
            && let Ok(input) = state.agent_input(self.inner.name())
        {
            span.record("langfuse.observation.input", view::encoded(&input));
        }
        Observation(span, false)
    }
    fn finish(&self, observation: &mut Observation, result: Result<&NodeOutput, &GraphError>) {
        match result {
            Ok(output) => {
                observation.0.record(
                    "langfuse.observation.metadata.status",
                    if output.interrupt.is_some() {
                        "waiting_for_input"
                    } else {
                        "completed"
                    },
                );
                let route = selected_route(self.inner.name(), output);
                if let Some(route) = route.as_deref() {
                    observation
                        .0
                        .record("langfuse.observation.metadata.selectedRoute", json!(route).to_string());
                }
                if output.interrupt.is_none() {
                    let targets = output.goto.clone().unwrap_or_else(|| {
                        self.edges
                            .iter()
                            .filter(|e| route.is_none() || e.source_handle.as_deref() == route.as_deref())
                            .map(|e| e.target.clone())
                            .collect::<BTreeSet<_>>()
                            .into_iter()
                            .collect()
                    });
                    observation
                        .0
                        .record("langfuse.observation.metadata.targets", json!(targets).to_string());
                }
                if config::capture_content() {
                    observation.0.record(
                        "langfuse.observation.output",
                        view::encoded(&json!({
                            "result":output.updates.get("workflow.node").and_then(|node|node.get("result").or_else(||node.get("messages"))),
                            "stateUpdates":output.updates.iter().filter(|(key,_)|!key.starts_with("workflow.")).map(|(key,value)|(key.clone(),value.clone())).collect::<serde_json::Map<_,_>>(),
                            "pauseReason":output.interrupt.as_ref().map(ToString::to_string)
                        })),
                    );
                }
            },
            Err(error) => {
                observation.0.record("langfuse.observation.metadata.status", "failed");
                observation.0.record("langfuse.observation.level", "ERROR");
                if config::capture_content() {
                    observation.0.record(
                        "langfuse.observation.output",
                        view::encoded(&json!({"error":error.to_string()})),
                    );
                }
            },
        }
        observation.1 = true;
    }
    async fn scoped<T>(&self, future: impl std::future::Future<Output = T>) -> T {
        let mut origin = self.origin.clone();
        origin.node_id = Some(self.inner.name().into());
        crate::module::model_usage::scope(origin, view::node(self.inner.name(), &self.name, future)).await
    }
}
#[async_trait::async_trait]
impl Node for ObservedNode {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn description(&self) -> &str {
        self.inner.description()
    }
    fn capabilities(&self) -> adk_rust::AgentCapabilities {
        self.inner.capabilities()
    }
    fn validate(&self) -> adk_rust::graph::Result<()> {
        self.inner.validate()
    }
    fn validate_against(&self, schema: &adk_rust::graph::StateSchema) -> adk_rust::graph::Result<()> {
        self.inner.validate_against(schema)
    }
    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let mut observation = self.start(context);
        let result = self
            .scoped(self.inner.execute(context))
            .instrument(observation.0.clone())
            .await;
        self.finish(&mut observation, result.as_ref());
        result
    }
    fn execute_stream<'a>(
        &'a self,
        context: &'a NodeContext,
    ) -> std::pin::Pin<Box<dyn futures::Stream<Item = adk_rust::graph::Result<StreamEvent>> + Send + 'a>> {
        Box::pin(async_stream::stream! {
            let mut observation=self.start(context);
            let stream=self.inner.execute_stream(context);tokio::pin!(stream);
            let mut output=NodeOutput::new();
            // Poll the original stream exactly once. Never invoke execute again:
            // StreamingAgentNode owns the event-cache/postprocessing contract.
            while let Some(event)=self.scoped(stream.next()).instrument(observation.0.clone()).await {
                match &event {
                    Ok(StreamEvent::Updates{updates,..})=>output.updates.extend(updates.clone()),
                    Ok(StreamEvent::RouteDispatched{targets,..})=>output.goto=Some(targets.clone()),
                    Ok(StreamEvent::NodeInterrupt{message,data,..})=> {
                        output.interrupt=Some(adk_rust::graph::Interrupt::Dynamic{message:message.clone(),data:data.clone()});
                        self.finish(&mut observation,Ok(&output));
                    },
                    Err(error)=>{self.finish(&mut observation,Err(error));yield event;return;},
                    _=>{},
                }
                yield event;
            }
            self.finish(&mut observation,Ok(&output));
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing::instrument::WithSubscriber;

    #[test]
    fn decisions_identify_only_the_executed_branch() {
        let branch = NodeOutput::new().with_update("workflow.route.route", json!("false"));
        assert_eq!(selected_route("route", &branch).as_deref(), Some("false"));
        let review = NodeOutput::new().with_update(
            "workflow.node",
            json!({"type":"human_review","result":{"approved":false}}),
        );
        assert_eq!(selected_route("review", &review).as_deref(), Some("rejected"));
        let question = NodeOutput::new().with_update(
            "workflow.node",
            json!({"type":"ask_user_question","result":{"optionId":"safe"}}),
        );
        assert_eq!(selected_route("question", &question).as_deref(), Some("option:safe"));
    }
    #[tokio::test]
    #[ignore = "local Langfuse required; real checkpoint pause/resume, no model or business tools"]
    async fn export_checkpoint_resume_using_production_context() {
        let subscriber = config::subscriber("http://127.0.0.1:4317").unwrap();
        config::test_capture(true);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workflow.sqlite");
        std::fs::File::create(&path).unwrap();
        let url = format!("sqlite://{}", path.display());
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut migrator = sqlx::migrate!("resources/migrations");
        migrator.dangerous_set_table_name("_workrun_sqlx_migrations");
        migrator.run(&pool).await.unwrap();
        let run = uuid::Uuid::new_v4().to_string();
        println!("workflow_probe={run}");
        sqlx::query("INSERT INTO run_records(id,target_type,target_id,target_name,status,started_at,target_snapshot_json,runtime_json,created_at,updated_at,workspace_id) VALUES (?,'workflow','review','原生观测验收','running','2026-11-12','{}','{}','2026-11-12','2026-11-12','personal')").bind(&run).execute(&pool).await.unwrap();
        let document = json!({"id":"review","name":"原生观测验收","nodes":[{"id":"start","type":"start"},{"id":"review","type":"human_review","data":{"label":"人工确认"}},{"id":"end","type":"end"}],"edges":[{"source":"start","target":"review"},{"source":"review","target":"end","sourceHandle":"approved"},{"source":"review","target":"end","sourceHandle":"rejected"}]});
        async {
            TEST_CHECKPOINT_DB.scope(url,async {
                let origin=crate::module::model_usage::CallContext{workspace_id:"personal".into(),run_id:Some(run.clone()),session_id:Some(run.clone()),..Default::default()};
                let first=tracing::info_span!("workrun.workflow.phase","otel.name"="原生观测验收","langfuse.observation.type"="chain","langfuse.session.id"=%run,"langfuse.observation.metadata.runId"=%run);
                config::workflow_parent(&pool,&run,&json!({}),&first).await;
                crate::module::model_usage::scope(origin.clone(),async {
                    let dsl=serde_json::from_value(document.clone()).unwrap();
                    let result=compile(dsl,&Default::default(),None).await.unwrap().run_stream(State::new(),"review",false,None,|_|{}).await.unwrap();
                    assert!(result.interrupted);
                }).instrument(first).await;
                let runtime:String=sqlx::query_scalar("SELECT runtime_json FROM run_records WHERE id=?").bind(&run).fetch_one(&pool).await.unwrap();
                let runtime:Value=serde_json::from_str(&runtime).unwrap();
                assert!(runtime.pointer("/observability/traceparent").and_then(Value::as_str).unwrap().starts_with("00-"));
                let second=tracing::info_span!("workrun.workflow.phase","otel.name"="恢复执行","langfuse.observation.type"="chain","langfuse.session.id"=%run,"langfuse.observation.metadata.runId"=%run);
                config::workflow_parent(&pool,&run,&runtime,&second).await;
                crate::module::model_usage::scope(origin,async {
                    let dsl=serde_json::from_value(document.clone()).unwrap();
                    let compiled=compile(dsl,&Default::default(),None).await.unwrap();
                    compiled.update_state("review",vec![("workflow.human_review.review.approved".into(),json!(true))]).await.unwrap();drop(compiled);
                    let dsl=serde_json::from_value(document).unwrap();
                    let result=compile(dsl,&Default::default(),None).await.unwrap().run_stream(State::new(),"review",true,None,|_|{}).await.unwrap();
                    assert!(!result.interrupted);
                }).instrument(second).await;
            }).await;
        }.with_subscriber(subscriber).await;
        tokio::time::sleep(std::time::Duration::from_secs(6)).await;
        config::test_capture(false);
    }
}
