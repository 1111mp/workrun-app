use super::*;

const CAPABILITIES: operations::ExecutionCapabilities = operations::ExecutionCapabilities {
    reuse_result: true,
    reconcile_existing: false,
};

/// A process receipt is committed before State/checkpoint publication. Neither
/// an exit error nor losing the process future proves that it had no effects.
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_durable(
    pool: sqlx::SqlitePool,
    key: &[u8],
    execution_id: &str,
    run_id: &str,
    path: &str,
    input: &Value,
    snapshot: &Value,
    execute: impl std::future::Future<Output = Result<Value>>,
    store: impl FnOnce() -> Result<crate::module::artifact::ArtifactStore>,
) -> Result<Value> {
    let mut op =
        operations::Operation::enter(pool.clone(), execution_id, path, run_id, "process", input, snapshot).await?;
    op.prepare_compensation(key, input, snapshot).await?;
    let action = match op.action(CAPABILITIES) {
        Ok(action) => action,
        Err(error) => {
            op.finish(None, "unknown", Some("Process outcome requires manual reconciliation"))
                .await?;
            return Err(error);
        },
    };
    if action == operations::ExecutionAction::Reuse {
        let saved = op.result.clone().ok_or_else(|| anyhow!("Missing Process result"))?;
        let checked = (|| -> Result<Value> {
            let ciphertext = saved["processResultCiphertext"]
                .as_str()
                .ok_or_else(|| anyhow!("Invalid Process result envelope"))?;
            let plaintext = crate::config::decrypt_data_with_key(ciphertext, key)
                .map_err(|_| anyhow!("Cannot decrypt Process result"))?;
            let receipt: Value = serde_json::from_str(&plaintext)?;
            if !receipt["result"].is_object() {
                bail!("Saved Process result is not an object");
            }
            // Files can disappear or change independently of SQLite. A saved JSON
            // result alone is not evidence that a generated artifact is usable.
            let references = crate::module::artifact::references(&receipt["result"])?;
            if !references.is_empty() {
                let store = store()?;
                for reference in references {
                    store.resolve(&reference)?;
                }
            }
            Ok(receipt)
        })();
        let receipt = match checked {
            Ok(receipt) => receipt,
            Err(error) => {
                op.fail_reuse("Saved Process result or artifact unavailable; restore or reconcile it")
                    .await?;
                return Err(error);
            },
        };
        op.finish(Some(&saved), "succeeded", None).await?;
        return Ok(receipt);
    }
    let encrypted =
        crate::config::encrypt_data_with_key(&json!({"input": input, "snapshot": snapshot}).to_string(), key)
            .map_err(|_| anyhow!("Cannot encrypt Process input"))?;
    sqlx::query("INSERT OR IGNORE INTO workflow_process_inputs (operation_id, input_ciphertext) VALUES (?, ?)")
        .bind(&op.id)
        .bind(encrypted)
        .execute(&pool)
        .await?;
    // Conservative boundary includes runtime preparation. Until the registry
    // exposes a durable pre-spawn hook, preparation failure also needs review.
    op.mark_dispatched().await?;
    match execute.await {
        Ok(receipt) => {
            let ciphertext = crate::config::encrypt_data_with_key(&receipt.to_string(), key)
                .map_err(|_| anyhow!("Cannot encrypt Process result"))?;
            op.finish(Some(&json!({"processResultCiphertext": ciphertext})), "succeeded", None)
                .await?;
            Ok(receipt)
        },
        Err(error) => {
            op.finish(
                None,
                "unknown",
                Some("Process stopped without a durable result; effects require reconciliation"),
            )
            .await?;
            Err(error)
        },
    }
}

pub(crate) async fn validate_recovery(pool: &sqlx::SqlitePool, execution_id: &str, path: &str) -> Result<()> {
    let unsafe_operation: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE execution_id = ? AND execution_path = ? AND (status = 'running' OR (dispatched_at IS NOT NULL AND result_json IS NULL AND confirmed_no_effect=0)))")
        .bind(execution_id).bind(path).fetch_one(pool).await?;
    if unsafe_operation {
        bail!("Process result pending confirmation; this adapter cannot resume or reconcile, restart disabled");
    }
    Ok(())
}

pub(super) fn add_process_node(
    graph: StateGraph,
    node: &WorkflowNode,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> StateGraph {
    graph.add_node(ProcessWorkflowNode {
        id: node.id.clone(),
        process_node_id: string_data(node, "processNodeId").unwrap_or_default(),
        compensation: node.data.get("compensation").cloned(),
        display_name: string_data(node, "name").unwrap_or_else(|| node.id.clone()),
        on_event,
        state,
        global_keys: state_config.global_keys,
        sensitive_fields: state_config.sensitive_fields,
    })
}

struct ProcessWorkflowNode {
    id: String,
    process_node_id: String,
    compensation: Option<Value>,
    display_name: String,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    global_keys: BTreeSet<String>,
    sensitive_fields: BTreeSet<String>,
}

#[async_trait::async_trait]
impl Node for ProcessWorkflowNode {
    fn name(&self) -> &str {
        &self.id
    }

    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        if self.process_node_id.trim().is_empty() {
            return Err(graph_node_error(&self.id, "process node needs data.processNodeId"));
        }
        // `node_input` clones the authorized snapshot, so this guard is dropped
        // before the potentially long-running process invocation below.
        let input = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .node_input(&self.id)
            .map_err(|error| graph_node_error(&self.id, error))?;
        let definition = crate::feat::get_process_node(&self.process_node_id)
            .await
            .map_err(|error| graph_node_error(&self.id, error))?;
        let execute = async {
            // Resolve once: the invoked catalog contract must match the journal.
            let run = crate::module::process_node::ProcessNodeRegistry::run_for_workflow(
                definition.clone(),
                &input,
                Arc::new(|_| {}),
            )
            .await?;
            Ok(json!({
                "processName": run.definition.name, "stdout": run.stdout,
                "stderr": run.stderr, "exitCode": run.execution.exit_code,
                "result": run.result,
            }))
        };
        let mut snapshot = json!({"definition": definition, "capabilities": CAPABILITIES});
        if let Some(compensation) = &self.compensation {
            snapshot["compensation"] = compensation.clone();
        }
        let receipt = if let Some(run_id) = context.config.metadata.get("workrun.run_id").and_then(Value::as_str) {
            let pool = crate::core::db::DBManager::global()
                .pool()
                .map_err(|error| graph_node_error(&self.id, error))?;
            let key = crate::utils::dirs::get_encryption_key().map_err(|error| graph_node_error(&self.id, error))?;
            let execution_id = context
                .config
                .metadata
                .get("workrun.execution_id")
                .and_then(Value::as_str)
                .unwrap_or(run_id);
            let scope = context
                .config
                .metadata
                .get("workrun.execution_path")
                .and_then(Value::as_str)
                .unwrap_or("root");
            let path = serde_json::to_string(&json!([scope, self.id, context.step, "process"]))
                .map_err(|error| graph_node_error(&self.id, error))?;
            execute_durable(
                pool,
                &key,
                execution_id,
                run_id,
                &path,
                &input,
                &snapshot,
                execute,
                crate::module::artifact::ArtifactStore::active,
            )
            .await
        } else {
            execute.await
        };
        let receipt = receipt.map_err(|error| graph_node_error(&self.id, error))?;
        if let Some(on_event) = &self.on_event {
            for (stream, data) in [("stdout", &receipt["stdout"]), ("stderr", &receipt["stderr"])] {
                if data.as_str().is_some_and(|data| !data.is_empty()) {
                    send_guarded_event(
                        on_event,
                        StreamEvent::custom(
                            &self.id,
                            "process.output",
                            json!({ "name": self.display_name, "stream": stream, "data": data }),
                        ),
                    );
                }
            }
        }
        // Result keys are private by default; only this node's configured
        // `globalKeys` are promoted by the bridge.
        let update = crate::module::state::NodeStateUpdate::from_object(
            receipt["result"]
                .as_object()
                .ok_or_else(|| graph_node_error(&self.id, "Saved Process result is not an object"))?
                .clone(),
        );
        let global_updates = self
            .state
            .lock()
            .map_err(|_| graph_node_error(&self.id, "workflow state lock is poisoned"))?
            .apply_node_update_with_sensitive_fields(&self.id, update, &self.global_keys, &self.sensitive_fields)
            .map_err(|error| graph_node_error(&self.id, error))?;
        let event = redact_json(&json!({
            "nodeId": self.id,
            "type": "process",
            "processNodeId": self.process_node_id,
            "processName": receipt["processName"],
            "stdout": receipt["stdout"],
            "stderr": receipt["stderr"],
            "exitCode": receipt["exitCode"],
            "result": receipt["result"],
        }));
        if let Some(on_event) = &self.on_event {
            send_guarded_event(
                on_event,
                StreamEvent::custom(&self.id, "workflow.node_result", event.clone()),
            );
        }
        let output = NodeOutput::new()
            .with_update("workflow.last_node", json!(self.id))
            .with_update("workflow.node", event.clone())
            .with_update("workflow.trace", event)
            .with_updates(global_updates);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::artifact::ArtifactStore;
    use std::sync::atomic::{AtomicU32, Ordering};

    const PATH: &str = "[\"root\",\"generate\",2,\"process\"]";

    #[tokio::test]
    async fn saved_process_result_survives_missing_checkpoint_without_restarting_process() {
        let pool = remote_tasks::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path().to_path_buf());
        let calls = AtomicU32::new(0);
        let input = json!({"document":"private-input"});
        let snapshot = json!({"app":"generate", "version":"1"});
        let receipt = execute_durable(pool.clone(), &[42; 32], "run-1", "run-1", PATH, &input, &snapshot, async {
            calls.fetch_add(1, Ordering::SeqCst);
            let file = store.save_bytes("generated.txt", b"generated-once")?;
            Ok(json!({"processName":"Generator", "stdout":"generated", "stderr":"", "exitCode":0, "result":{"file":file}}))
        }, || Ok(store.clone())).await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        // No State/checkpoint publication occurs before recovery. Only SQLite
        // and the durable artifact are carried into the second invocation.
        operations::recover_interrupted(&pool).await.unwrap();
        let reused = execute_durable(
            pool.clone(),
            &[42; 32],
            "run-1",
            "run-1",
            PATH,
            &input,
            &snapshot,
            async {
                calls.fetch_add(1, Ordering::SeqCst);
                bail!("process must not restart")
            },
            || Ok(store.clone()),
        )
        .await
        .unwrap();
        assert_eq!(receipt, reused);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT id FROM workflow_operations")
                .fetch_one(&pool)
                .await
                .unwrap(),
            id
        );
        let actions: Vec<String> =
            sqlx::query_scalar("SELECT action FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(actions, ["submit", "reuse"]);
        let raw: String = sqlx::query_scalar("SELECT result_json FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!raw.contains("generated.txt"));
        let raw: String = sqlx::query_scalar("SELECT input_ciphertext FROM workflow_process_inputs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!raw.contains("private-input"));
    }

    #[tokio::test]
    async fn changed_artifact_blocks_reuse_and_preserves_original_success() {
        let pool = remote_tasks::test_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(dir.path().to_path_buf());
        let file = store.save_bytes("generated.txt", b"original").unwrap();
        execute_durable(
            pool.clone(),
            &[42; 32],
            "run-1",
            "run-1",
            PATH,
            &json!({}),
            &json!({}),
            async { Ok(json!({"result":{"file":file}})) },
            || Ok(store.clone()),
        )
        .await
        .unwrap();
        let path = store.resolve(&file).unwrap();
        std::fs::write(&path, b"tampered").unwrap();
        let result = execute_durable(
            pool.clone(),
            &[42; 32],
            "run-1",
            "run-1",
            PATH,
            &json!({}),
            &json!({}),
            async { panic!("must not regenerate a missing/corrupt artifact") },
            || Ok(store.clone()),
        )
        .await;
        assert!(result.is_err());
        let statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(statuses, ["succeeded", "failed"]);
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "succeeded");
        // Restoring the original file enables reuse, without another execution.
        std::fs::write(&path, b"original").unwrap();
        execute_durable(
            pool,
            &[42; 32],
            "run-1",
            "run-1",
            PATH,
            &json!({}),
            &json!({}),
            async { panic!("must reuse after restoring the artifact") },
            || Ok(store.clone()),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn failed_or_interrupted_process_never_restarts_an_unknown_operation() {
        let pool = remote_tasks::test_pool().await;
        let calls = AtomicU32::new(0);
        assert!(
            execute_durable(
                pool.clone(),
                &[42; 32],
                "run-1",
                "run-1",
                PATH,
                &json!({}),
                &json!({}),
                async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    bail!("effect happened but process result was lost")
                },
                || bail!("no artifacts")
            )
            .await
            .is_err()
        );
        operations::recover_interrupted(&pool).await.unwrap();
        assert!(validate_recovery(&pool, "run-1", PATH).await.is_err());
        assert!(
            execute_durable(
                pool.clone(),
                &[42; 32],
                "run-1",
                "run-1",
                PATH,
                &json!({}),
                &json!({}),
                async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"result":{}}))
                },
                || bail!("no artifacts")
            )
            .await
            .is_err()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
    }
}
