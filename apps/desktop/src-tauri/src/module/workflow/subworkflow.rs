use super::*;
use crate::{feat, module::state::NodeStateUpdate};

pub(super) fn add_subworkflow_node(
    graph: StateGraph,
    node: &WorkflowNode,
    context: SubworkflowNodeConfig,
) -> Result<StateGraph> {
    let workflow_id = string_data(node, "workflowId")
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| anyhow!("Select a saved workflow in the subworkflow node settings"))?;
    Ok(graph.add_node(SubworkflowNode {
        id: node.id.clone(),
        workflow_id,
        #[cfg(test)]
        test_storage: None,
        #[cfg(test)]
        test_dsl: None,
        config: context.config,
        on_event: context.on_event,
        state: context.state,
        global_keys: context.state_config.global_keys,
        sensitive_fields: context.state_config.sensitive_fields,
        workflow_path: context.workflow_path,
        execution_profile: context.execution_profile,
    }))
}

pub(super) struct SubworkflowNodeConfig {
    pub(super) config: IWorkrun,
    pub(super) on_event: Option<Channel<StreamEvent>>,
    pub(super) state: SharedWorkflowState,
    pub(super) state_config: WorkflowNodeStateConfig,
    pub(super) workflow_path: Vec<String>,
    pub(super) execution_profile: WorkflowExecutionProfile,
}

struct SubworkflowNode {
    id: String,
    workflow_id: String,
    #[cfg(test)]
    test_storage: Option<(sqlx::SqlitePool, Vec<u8>)>,
    #[cfg(test)]
    test_dsl: Option<WorkflowDsl>,
    config: IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
    sensitive_fields: BTreeSet<String>,
    workflow_path: Vec<String>,
    execution_profile: WorkflowExecutionProfile,
}

#[async_trait::async_trait]
impl Node for SubworkflowNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let resume_key = format!("workflow.subworkflow.{}.resume", self.id);
        let legacy_resume = context.get(&resume_key).and_then(Value::as_bool).unwrap_or(false);
        let input = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .node_input(&self.id)
            .map_err(|error| graph_node_error(&self.id, error))?;
        let scope = context
            .config
            .metadata
            .get("workrun.execution_path")
            .and_then(Value::as_str)
            .unwrap_or("root");
        let run_id = context.config.metadata.get("workrun.run_id").and_then(Value::as_str);
        let execution_id = context
            .config
            .metadata
            .get("workrun.execution_id")
            .and_then(Value::as_str)
            .unwrap_or(&context.config.thread_id);
        let mut operation = if let Some(run_id) = run_id {
            let (pool, key) = self.storage().map_err(|error| graph_node_error(&self.id, error))?;
            Some(
                super::subworkflow_journal::ChildOperation::enter(
                    pool,
                    key,
                    execution_id,
                    run_id,
                    &context.config.thread_id,
                    scope,
                    &self.id,
                    context.step,
                    &input,
                    self.load_dsl(),
                )
                .await
                .map_err(|error| graph_node_error(&self.id, error))?,
            )
        } else {
            None
        };
        if let Some(op) = &mut operation {
            let saved = (|| -> Result<Option<Value>> {
                let receipt = op.receipt()?;
                if let Some(receipt) = &receipt {
                    if !receipt["result"].is_object() {
                        bail!("Invalid saved subworkflow output");
                    }
                    let references = crate::module::artifact::references(&receipt["result"])?;
                    if !references.is_empty() {
                        let store = crate::module::artifact::ArtifactStore::active()?;
                        for reference in references {
                            store.resolve(&reference)?;
                        }
                    }
                }
                Ok(receipt)
            })();
            match saved {
                Ok(Some(receipt)) => {
                    op.complete(&receipt)
                        .await
                        .map_err(|error| graph_node_error(&self.id, error))?;
                    return self.publish_receipt(receipt);
                },
                Ok(None) => {},
                Err(error) => {
                    op.operation
                        .fail_reuse("Saved subworkflow output or artifact unavailable")
                        .await
                        .map_err(|error| graph_node_error(&self.id, error))?;
                    return Err(graph_node_error(&self.id, error));
                },
            }
        }
        let mut dsl = match &operation {
            Some(op) => op.invocation.dsl.clone(),
            None => workflow_dsl(&self.workflow_id)
                .await
                .map_err(|error| graph_node_error(&self.id, error))?,
        };
        validate_workflow_path(&self.workflow_path, &dsl.id).map_err(|error| graph_node_error(&self.id, error))?;
        let thread_id = operation
            .as_ref()
            .map(|op| op.invocation.thread_id.clone())
            .unwrap_or_else(|| format!("{}/{}", context.config.thread_id, self.id));
        let child_scope = operation
            .as_ref()
            .map(|op| op.invocation.scope.clone())
            .unwrap_or_else(|| json!([scope, self.id, context.step]).to_string());
        let resume = operation
            .as_ref()
            .map(|op| !op.operation.can_submit)
            .unwrap_or(legacy_resume);
        inject_workflow_context(&mut dsl, &thread_id, &self.id);
        let output_keys = dsl
            .output_schema
            .fields
            .iter()
            .map(|field| field.key.clone())
            .collect::<Vec<_>>();
        let workflow_name = dsl.name.clone();
        let node_names = dsl
            .nodes
            .iter()
            .map(|node| {
                let name = string_data(node, "workflowName")
                    .or_else(|| string_data(node, "name"))
                    .or_else(|| string_data(node, "label"))
                    .or_else(|| string_data(node, "title"))
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| "Workflow step".to_string());
                (node.id.clone(), name)
            })
            .collect::<HashMap<_, _>>();
        let mut child_path = self.workflow_path.clone();
        child_path.push(dsl.id.clone());
        let child = compile_with_path(
            dsl.clone(),
            &self.config,
            self.on_event.clone(),
            child_path,
            self.execution_profile.clone(),
        )
        .await
        .map_err(|error| graph_node_error(&self.id, error))?;
        if resume && operation.is_some() {
            // No checkpoint is not permission to start a new child execution.
            let validation = async {
                let (pool, key) = self.storage()?;
                let mut path = self.workflow_path.clone();
                path.push(dsl.id.clone());
                super::recovery::validate_frontier(
                    &child,
                    &dsl,
                    &pool,
                    &key,
                    execution_id,
                    run_id.unwrap(),
                    &child_scope,
                    &thread_id,
                    &self.config,
                    path,
                    false,
                )
                .await
            }
            .await;
            if let Err(error) = validation {
                if let Some(op) = &mut operation {
                    op.suspend().await.map_err(|error| graph_node_error(&self.id, error))?;
                }
                return Err(graph_node_error(&self.id, error));
            }
        }
        if let Some(op) = &operation {
            op.operation
                .mark_dispatched()
                .await
                .map_err(|error| graph_node_error(&self.id, error))?;
        }
        let input = if resume {
            adk_rust::graph::State::new()
        } else {
            serde_json::from_value(
                operation
                    .as_ref()
                    .map(|op| op.invocation.input.clone())
                    .unwrap_or(input),
            )
            .map_err(|error| graph_node_error(&self.id, error))?
        };
        let result = child
            .run_stream_scoped(
                input,
                &thread_id,
                resume,
                None,
                run_id,
                execution_id,
                &child_scope,
                |_| {},
            )
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if let Some(op) = &mut operation {
                    op.suspend().await.map_err(|error| graph_node_error(&self.id, error))?;
                }
                return Err(graph_node_error(&self.id, error));
            },
        };
        if result.interrupted {
            if let Some(op) = &mut operation {
                op.suspend().await.map_err(|error| graph_node_error(&self.id, error))?;
            }
            return Ok(NodeOutput::interrupt_with_data(
                "Subworkflow interrupted",
                json!({"workflowId":self.workflow_id, "threadId":thread_id}),
            )
            .with_update(&resume_key, true));
        }
        let terminated = result
            .state
            .get("workflow")
            .and_then(Value::as_object)
            .and_then(|workflow| workflow.get(WORKFLOW_TERMINATED_KEY))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let outputs = extract_outputs(&result.state, output_keys).map_err(|error| graph_node_error(&self.id, error))?;
        let receipt = json!({"result":outputs, "workflowName":workflow_name, "execution":workflow_trace(&result.state, &node_names), "terminated":terminated});
        if let Some(op) = &mut operation {
            op.complete(&receipt)
                .await
                .map_err(|error| graph_node_error(&self.id, error))?;
        }
        self.publish_receipt(receipt)
    }
}

impl SubworkflowNode {
    fn storage(&self) -> Result<(sqlx::SqlitePool, Vec<u8>)> {
        #[cfg(test)]
        if let Some(storage) = &self.test_storage {
            return Ok(storage.clone());
        }
        Ok((
            crate::core::db::DBManager::global().pool()?,
            crate::utils::dirs::get_encryption_key()?,
        ))
    }

    async fn load_dsl(&self) -> Result<WorkflowDsl> {
        #[cfg(test)]
        if let Some(dsl) = &self.test_dsl {
            return Ok(dsl.clone());
        }
        workflow_dsl(&self.workflow_id).await
    }

    fn publish_receipt(&self, receipt: Value) -> adk_rust::graph::Result<NodeOutput> {
        let resume_key = format!("workflow.subworkflow.{}.resume", self.id);
        let outputs = receipt["result"]
            .as_object()
            .ok_or_else(|| graph_node_error(&self.id, "Invalid subworkflow output"))?
            .clone();
        let terminated = receipt["terminated"].as_bool().unwrap_or(false);
        let global_updates = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .apply_node_update_with_sensitive_fields(
                &self.id,
                NodeStateUpdate::from_object(outputs.clone()),
                &self.global_keys,
                &self.sensitive_fields,
            )
            .map_err(|error| graph_node_error(&self.id, error))?;
        let event = json!({
            "nodeId": self.id,
            "type": "subworkflow",
            "workflowName": receipt["workflowName"],
            "result": outputs,
            "execution": receipt["execution"],
            "terminated": terminated,
        });
        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(&self.id, "workflow.node_result", event.clone()),
            );
        }
        let output = NodeOutput::new()
            .with_update(&resume_key, false)
            .with_update("workflow.last_node", json!(self.id))
            .with_update("workflow.node", event.clone())
            .with_update("workflow.trace", event)
            .with_updates(global_updates);
        if terminated {
            Ok(output
                .with_update(WORKFLOW_TERMINATED_KEY, Value::Bool(true))
                .with_goto([END]))
        } else {
            Ok(output)
        }
    }
}

fn workflow_trace(state: &State, node_names: &HashMap<String, String>) -> Vec<Value> {
    state
        .get("workflow")
        .and_then(Value::as_object)
        .and_then(|workflow| workflow.get("workflow.trace"))
        .and_then(Value::as_array)
        .map(|trace| {
            trace
                .iter()
                .cloned()
                .map(|mut entry| {
                    if let Some(record) = entry.as_object_mut()
                        && let Some(node_id) = record.get("nodeId").and_then(Value::as_str)
                        && let Some(node_name) = node_names.get(node_id)
                    {
                        record.insert("nodeName".to_string(), json!(node_name));
                    }
                    entry
                })
                .collect()
        })
        .unwrap_or_default()
}

pub(super) fn validate_workflow_path(workflow_path: &[String], workflow_id: &str) -> Result<()> {
    if workflow_path.iter().any(|id| id == workflow_id) {
        bail!(
            "subworkflow cycle detected: {} -> {workflow_id}",
            workflow_path.join(" -> "),
        )
    }
    if workflow_path.len() >= 10 {
        bail!("subworkflow nesting exceeds the maximum depth of 10")
    }
    Ok(())
}

fn extract_outputs(state: &adk_rust::graph::State, output_keys: Vec<String>) -> Result<serde_json::Map<String, Value>> {
    let child_global = state
        .get("global")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("subworkflow returned an invalid state"))?;
    Ok(output_keys
        .into_iter()
        .filter_map(|key| child_global.get(&key).cloned().map(|value| (key, value)))
        .collect())
}

pub async fn workflow_dsl(id: &str) -> Result<WorkflowDsl> {
    let workflow = feat::get_workflow(id).await?;
    let settings = workflow.document.get("settings").cloned().unwrap_or_default();
    serde_json::from_value(json!({
        "id": workflow.id,
        "name": settings.get("name").and_then(Value::as_str).unwrap_or_default(),
        "inputSchema": settings.get("inputSchema").cloned().unwrap_or(json!({ "fields": [] })),
        "outputSchema": settings.get("outputSchema").cloned().unwrap_or(json!({ "fields": [] })),
        "nodes": workflow.document.get("nodes").cloned().unwrap_or_default(),
        "edges": workflow.document.get("edges").cloned().unwrap_or_default(),
    }))
    .map_err(Into::into)
}

pub fn inject_workflow_context(dsl: &mut WorkflowDsl, thread_id: &str, parent_node_id: &str) {
    for node in &mut dsl.nodes {
        if node.kind == "human_review" || node.kind == "ask_user_question" {
            node.data["workflowContext"] = json!({
                "workflowId": dsl.id,
                "threadId": thread_id,
                "path": [parent_node_id, node.id],
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn journal_restores_child_checkpoint_without_parent_resume_flag_and_reuses_completion() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("checkpoint.sqlite");
        std::fs::write(&file, []).unwrap();
        TEST_CHECKPOINT_DB.scope(format!("sqlite://{}", file.display()), async {
            let pool = remote_tasks::test_pool().await;
            let dsl: WorkflowDsl = serde_json::from_value(json!({
                "id":"child", "name":"Original child",
                "inputSchema":{"fields":[{"key":"summary", "type":"string"}]},
                "outputSchema":{"fields":[{"key":"summary", "type":"string"}]},
                "nodes":[{"id":"start","type":"start"},{"id":"review","type":"human_review","data":{}},{"id":"end","type":"end"}],
                "edges":[{"source":"start","target":"review"},{"source":"review","target":"end","sourceHandle":"approved"},{"source":"review","target":"end","sourceHandle":"rejected"}]
            })).unwrap();
            let node = SubworkflowNode {
                id:"child-node".into(), workflow_id:"child".into(), config:Default::default(),
                test_storage:Some((pool.clone(), vec![42;32])), test_dsl:Some(dsl),
                on_event:None, state:Arc::new(Mutex::new(WorkflowStateBridge::from_initial_state(json!({"summary":"done"})).unwrap())),
                global_keys:BTreeSet::new(), sensitive_fields:BTreeSet::new(),
                workflow_path:vec!["parent".into()], execution_profile:WorkflowExecutionProfile::Production,
            };
            let context = NodeContext::new(HashMap::new(), ExecutionConfig::new("parent-thread")
                .with_metadata("workrun.run_id", json!("run-1")), 2);
            let first = node.execute(&context).await.unwrap();
            assert!(first.interrupt.is_some());
            let path = json!(["root", "child-node", 2, "subworkflow"]).to_string();
            let invocation = super::super::subworkflow_journal::saved_invocation(&pool, &[42;32], "parent-thread", &path).await.unwrap().unwrap();
            let mut saved = invocation.dsl.clone();
            inject_workflow_context(&mut saved, &invocation.thread_id, "child-node");
            let child = compile_with_path(saved.clone(), &Default::default(), None, vec!["parent".into(),"child".into()], WorkflowExecutionProfile::Production).await.unwrap();
            child.update_state(&invocation.thread_id, [(human_review_approval_key(&saved, "review").unwrap(), json!(true))]).await.unwrap();
            // Ignore the parent's returned resume update, as a parent failure
            // before checkpoint commit would do. The durable invocation wins.
            let completed = node.execute(&context).await.unwrap();
            assert!(completed.interrupt.is_none());
            assert_eq!(completed.updates["workflow.node"]["result"]["summary"], "done");
            // Restore the parent bridge as well as graph position; keeping
            // post-publication State would not model a missing checkpoint.
            *node.state.lock().unwrap() = WorkflowStateBridge::from_initial_state(json!({"summary":"done"})).unwrap();
            let reused = node.execute(&context).await.unwrap();
            assert_eq!(reused.updates["workflow.node"], completed.updates["workflow.node"]);
            let actions: Vec<String> = sqlx::query_scalar("SELECT action FROM workflow_operation_attempts ORDER BY sequence").fetch_all(&pool).await.unwrap();
            assert_eq!(actions, ["submit", "reconcile", "reuse"]);
        }).await;
    }

    #[test]
    fn injects_resume_context_only_into_interactive_nodes() {
        let mut dsl = WorkflowDsl {
            id: "child-workflow".to_string(),
            name: String::new(),
            input_schema: WorkflowInterfaceSchema::default(),
            session_state_fields: Vec::new(),
            output_schema: WorkflowInterfaceSchema::default(),
            nodes: vec![
                WorkflowNode {
                    id: "review".to_string(),
                    kind: "human_review".to_string(),
                    data: json!({}),
                },
                WorkflowNode {
                    id: "process".to_string(),
                    kind: "process".to_string(),
                    data: json!({}),
                },
            ],
            edges: vec![],
        };

        inject_workflow_context(&mut dsl, "root/subworkflow", "subworkflow");

        assert_eq!(
            dsl.nodes[0].data["workflowContext"],
            json!({
                "workflowId": "child-workflow",
                "threadId": "root/subworkflow",
                "path": ["subworkflow", "review"],
            })
        );
        assert!(dsl.nodes[1].data.get("workflowContext").is_none());
    }

    #[test]
    fn rejects_cycles_and_excessive_nesting() {
        assert!(validate_workflow_path(&["root".to_string()], "root").is_err());
        assert!(validate_workflow_path(&vec!["child".to_string(); 10], "next").is_err());
        assert!(validate_workflow_path(&["root".to_string()], "child").is_ok());
    }

    #[test]
    fn exposes_only_declared_global_outputs() {
        let state = serde_json::from_value(json!({
            "global": { "summary": "done", "inheritedInput": "keep private" },
        }))
        .unwrap();
        assert_eq!(
            extract_outputs(&state, vec!["summary".to_string()]).unwrap(),
            json!({ "summary": "done" }).as_object().unwrap().clone(),
        );
    }

    #[test]
    fn reads_the_child_workflow_trace() {
        let state = serde_json::from_value(json!({
            "workflow": { "workflow.trace": [{ "nodeId": "step", "type": "process" }] },
        }))
        .unwrap();
        assert_eq!(
            workflow_trace(
                &state,
                &HashMap::from([("step".to_string(), "Process data".to_string())])
            ),
            vec![json!({ "nodeId": "step", "type": "process", "nodeName": "Process data" })],
        );
    }
}
