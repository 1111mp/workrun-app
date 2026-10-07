//! Validate all pending branches before rescheduling a business task.
use super::*;

pub(super) async fn reject_legacy_child(parent_thread: &str, node: &str) -> Result<()> {
    let checkpointer = SqliteCheckpointer::new(&workflow_checkpointer_db_url().await?).await?;
    if checkpointer.load(&format!("{parent_thread}/{node}")).await?.is_some() {
        bail!("Legacy subworkflow checkpoint has no stable invocation binding; reconcile before continuing");
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn validate_frontier<'a>(
    compiled: &'a CompiledWorkflow,
    dsl: &'a WorkflowDsl,
    pool: &'a sqlx::SqlitePool,
    key: &'a [u8],
    execution_id: &'a str,
    run_id: &'a str,
    scope: &'a str,
    thread_id: &'a str,
    config: &'a IWorkrun,
    workflow_path: Vec<String>,
    automatic: bool,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + 'a>> {
    Box::pin(async move {
        let (step, frontier) = compiled.recovery_frontier(thread_id).await?;
        for node in frontier {
            let definition = dsl
                .nodes
                .iter()
                .find(|n| n.id == node)
                .context("Checkpoint node is missing from the execution snapshot")?;
            if automatic && definition.kind != "remote_agent" {
                bail!(
                    "This checkpoint requires manual recovery; automatic recovery currently supports Remote Agent only"
                );
            }
            match definition.kind.as_str() {
                "remote_agent" => {
                    let path = json!([scope, node, step, "remote"]).to_string();
                    let unbound: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM remote_tasks t WHERE t.run_id = ? AND t.node_id = ? AND NOT EXISTS(SELECT 1 FROM workflow_operations o WHERE o.adapter_record_id = t.id) AND NOT EXISTS(SELECT 1 FROM workflow_operation_reviews v WHERE v.remote_record_id=t.id)) AND NOT EXISTS(SELECT 1 FROM workflow_operations WHERE execution_id = ? AND execution_path = ?)")
                        .bind(run_id).bind(&node).bind(execution_id).bind(&path).fetch_one(pool).await?;
                    if unbound {
                        bail!(
                            "Legacy remote task has no stable operation binding; reconcile it manually before starting a new execution"
                        );
                    }
                    operations::validate_recovery(pool, execution_id, &path, automatic).await?;
                },
                "agent" => tool_journal::validate_recovery(pool, execution_id, scope, &node, step).await?,
                "process" => {
                    process::validate_recovery(pool, execution_id, &json!([scope, node, step, "process"]).to_string())
                        .await?
                },
                "codeact_agent" => bail!(
                    "CodeAct checkpoint has no durable execution contract; automatic or manual business resubmission is not enabled"
                ),
                "subworkflow" => {
                    let path = json!([scope, node, step, "subworkflow"]).to_string();
                    let record: Option<(String, Option<String>, Option<String>)> = sqlx::query_as("SELECT status, result_json, dispatched_at FROM workflow_operations WHERE execution_id = ? AND execution_path = ?")
                        .bind(execution_id).bind(&path).fetch_optional(pool).await?;
                    if record.as_ref().is_some_and(|r| r.0 == "running") {
                        bail!("Subworkflow is still executing");
                    }
                    let invocation = subworkflow_journal::saved_invocation(pool, key, execution_id, &path).await?;
                    if record.as_ref().is_some_and(|r| r.1.is_some()) {
                        if invocation.is_none() {
                            bail!("Subworkflow result has no invocation snapshot");
                        }
                        continue;
                    }
                    let dispatched = record.as_ref().is_some_and(|r| r.2.is_some());
                    if !dispatched {
                        if invocation.is_none() {
                            reject_legacy_child(thread_id, &node).await?;
                        }
                        continue;
                    }
                    let invocation =
                        invocation.context("Unfinished subworkflow has no saved invocation; restart disabled")?;
                    let mut child_dsl = invocation.dsl;
                    subworkflow::validate_workflow_path(&workflow_path, &child_dsl.id)?;
                    subworkflow::inject_workflow_context(&mut child_dsl, &invocation.thread_id, &node);
                    let mut child_path = workflow_path.clone();
                    child_path.push(child_dsl.id.clone());
                    let child = compile_with_path(
                        child_dsl.clone(),
                        config,
                        None,
                        child_path.clone(),
                        WorkflowExecutionProfile::Production,
                    )
                    .await?;
                    validate_frontier(
                        &child,
                        &child_dsl,
                        pool,
                        key,
                        execution_id,
                        run_id,
                        &invocation.scope,
                        &invocation.thread_id,
                        config,
                        child_path,
                        false,
                    )
                    .await?;
                },
                _ => {},
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::graph::Checkpoint;
    use std::sync::atomic::{AtomicU32, Ordering};

    async fn mixed_operations(pool: &sqlx::SqlitePool, scope: &str, calls: &[AtomicU32; 3]) {
        process::execute_durable(
            pool.clone(),
            &[42; 32],
            "run-1",
            "run-1",
            &json!([scope, "generate", 0, "process"]).to_string(),
            &json!({}),
            &json!({"version":1}),
            async {
                calls[0].fetch_add(1, Ordering::SeqCst);
                Ok(json!({"result":{"fileId":"fixture-file"}}))
            },
            || bail!("no artifact references"),
        )
        .await
        .unwrap();
        let journal = tool_journal::ToolJournal::new(pool.clone(), vec![42; 32], "run-1", "run-1", scope, "upload", 1)
            .await
            .unwrap();
        let mut upload = journal
            .enter(&json!({"fileId":"fixture-file"}), &json!({"tool":"upload"}))
            .await
            .unwrap();
        let uploaded = match &upload.result {
            Some(saved) => journal.decode(saved).unwrap(),
            None => {
                upload.mark_dispatched().await.unwrap();
                calls[1].fetch_add(1, Ordering::SeqCst);
                json!({"resourceId":"fixture-upload"})
            },
        };
        upload
            .finish(Some(&journal.encode(&uploaded).unwrap()), "succeeded", None)
            .await
            .unwrap();
        journal.check(true).unwrap();
        let mut remote = operations::Operation::enter(
            pool.clone(),
            "run-1",
            &json!([scope, "publish", 2, "remote"]).to_string(),
            "run-1",
            "remote_agent",
            &uploaded,
            &json!({"service":"fixture"}),
        )
        .await
        .unwrap();
        let published = match &remote.result {
            Some(saved) => saved.clone(),
            None => {
                assert!(remote.can_submit);
                remote.mark_dispatched().await.unwrap();
                calls[2].fetch_add(1, Ordering::SeqCst);
                json!({"publicationId":"fixture-publication"})
            },
        };
        remote.finish(Some(&published), "succeeded", None).await.unwrap();
    }

    #[tokio::test]
    async fn mixed_descendant_journals_reuse_results_under_one_child_invocation() {
        let pool = remote_tasks::test_pool().await;
        let child_dsl: WorkflowDsl = serde_json::from_value(json!({"id":"child", "nodes":[{"id":"start","type":"start"},{"id":"end","type":"end"}],"edges":[{"source":"start","target":"end"}]})).unwrap();
        let calls = [AtomicU32::new(0), AtomicU32::new(0), AtomicU32::new(0)];
        let mut child = subworkflow_journal::ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child",
            2,
            &json!({}),
            async { Ok(child_dsl) },
        )
        .await
        .unwrap();
        let scope = child.invocation.scope.clone();
        child.operation.mark_dispatched().await.unwrap();
        mixed_operations(&pool, &scope, &calls).await;
        // Model an unfinished child after all three external facts committed.
        child.suspend().await.unwrap();
        operations::recover_interrupted(&pool).await.unwrap();
        let mut resumed = subworkflow_journal::ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child",
            2,
            &json!({}),
            async { panic!("original snapshot only") },
        )
        .await
        .unwrap();
        assert_eq!(resumed.invocation.scope, scope);
        mixed_operations(&pool, &resumed.invocation.scope, &calls).await;
        assert_eq!(calls.map(|count| count.load(Ordering::SeqCst)), [1, 1, 1]);
        resumed
            .complete(&json!({"result":{},"execution":[],"terminated":false}))
            .await
            .unwrap();
        let mut parent_retry = subworkflow_journal::ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child",
            2,
            &json!({}),
            async { panic!("must reuse child receipt") },
        )
        .await
        .unwrap();
        let receipt = parent_retry.receipt().unwrap().unwrap();
        parent_retry.complete(&receipt).await.unwrap();
        let history: Vec<(String,String)> = sqlx::query_as("SELECT o.adapter,a.action FROM workflow_operation_attempts a JOIN workflow_operations o ON o.id=a.operation_id WHERE o.adapter != 'subworkflow' ORDER BY o.adapter,a.sequence").fetch_all(&pool).await.unwrap();
        assert_eq!(
            history,
            vec![
                ("process".into(), "submit".into()),
                ("process".into(), "reuse".into()),
                ("remote_agent".into(), "submit".into()),
                ("remote_agent".into(), "reuse".into()),
                ("tool".into(), "submit".into()),
                ("tool".into(), "reuse".into())
            ]
        );
    }

    #[tokio::test]
    async fn mixed_frontier_requires_manual_recovery_and_blocks_unknown_remote_results() {
        let pool = remote_tasks::test_pool().await;
        let dsl: WorkflowDsl = serde_json::from_value(json!({"id":"mixed",
            "nodes":[{"id":"start","type":"start"},{"id":"process","type":"process","data":{"processNodeId":"generator"}},
                {"id":"remote","type":"remote_agent","data":{"url":"http://127.0.0.1:9999"}},{"id":"end","type":"end"}],
            "edges":[{"source":"start","target":"process"},{"source":"start","target":"remote"},{"source":"process","target":"end"},{"source":"remote","target":"end"}]
        })).unwrap();
        let config = IWorkrun::default();
        let compiled = compile(dsl.clone(), &config, None).await.unwrap();
        compiled
            .state_checkpointer
            .save(&Checkpoint::new(
                "thread",
                compiled.graph.schema().initialize_state(),
                2,
                vec!["process".into(), "remote".into()],
            ))
            .await
            .unwrap();
        validate_frontier(
            &compiled,
            &dsl,
            &pool,
            &[42; 32],
            "run-1",
            "run-1",
            "root",
            "thread",
            &config,
            vec!["mixed".into()],
            false,
        )
        .await
        .unwrap();
        assert!(
            validate_frontier(
                &compiled,
                &dsl,
                &pool,
                &[42; 32],
                "run-1",
                "run-1",
                "root",
                "thread",
                &config,
                vec!["mixed".into()],
                true
            )
            .await
            .is_err()
        );
        let mut op = operations::Operation::enter(
            pool.clone(),
            "run-1",
            &json!(["root", "remote", 2, "remote"]).to_string(),
            "run-1",
            "remote_agent",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        op.mark_dispatched().await.unwrap();
        op.finish(None, "unknown", None).await.unwrap();
        assert!(
            validate_frontier(
                &compiled,
                &dsl,
                &pool,
                &[42; 32],
                "run-1",
                "run-1",
                "root",
                "thread",
                &config,
                vec!["mixed".into()],
                false
            )
            .await
            .is_err()
        );
    }

    #[tokio::test]
    async fn unfinished_child_without_checkpoint_blocks_parent_recovery() {
        let pool = remote_tasks::test_pool().await;
        let dsl: WorkflowDsl = serde_json::from_value(json!({"id":"parent",
            "nodes":[{"id":"start","type":"start"},{"id":"child","type":"subworkflow","data":{"workflowId":"child-recipe"}},{"id":"end","type":"end"}],
            "edges":[{"source":"start","target":"child"},{"source":"child","target":"end"}]
        })).unwrap();
        let config = IWorkrun::default();
        let compiled = compile(dsl.clone(), &config, None).await.unwrap();
        compiled
            .state_checkpointer
            .save(&Checkpoint::new(
                "thread",
                compiled.graph.schema().initialize_state(),
                2,
                vec!["child".into()],
            ))
            .await
            .unwrap();
        let child_dsl = serde_json::from_value(json!({"id":"child-recipe", "nodes":[{"id":"start","type":"start"},{"id":"end","type":"end"}],"edges":[{"source":"start","target":"end"}]})).unwrap();
        let mut child = subworkflow_journal::ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child",
            2,
            &json!({}),
            async { Ok(child_dsl) },
        )
        .await
        .unwrap();
        child.operation.mark_dispatched().await.unwrap();
        child.suspend().await.unwrap();
        assert!(
            validate_frontier(
                &compiled,
                &dsl,
                &pool,
                &[42; 32],
                "run-1",
                "run-1",
                "root",
                "thread",
                &config,
                vec!["parent".into()],
                false
            )
            .await
            .is_err()
        );
        // Completed child receipt no longer needs a child graph checkpoint.
        let mut child = subworkflow_journal::ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child",
            2,
            &json!({}),
            async { panic!("saved snapshot") },
        )
        .await
        .unwrap();
        child
            .complete(&json!({"result":{},"execution":[],"terminated":false}))
            .await
            .unwrap();
        validate_frontier(
            &compiled,
            &dsl,
            &pool,
            &[42; 32],
            "run-1",
            "run-1",
            "root",
            "thread",
            &config,
            vec!["parent".into()],
            false,
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn unknown_remote_in_child_blocks_parent_until_original_result_is_reconciled() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("checkpoint.sqlite");
        std::fs::write(&file, []).unwrap();
        TEST_CHECKPOINT_DB.scope(format!("sqlite://{}", file.display()), async {
            let pool = remote_tasks::test_pool().await;
            let config = IWorkrun::default();
            let parent_dsl: WorkflowDsl = serde_json::from_value(json!({"id":"parent",
                "nodes":[{"id":"start","type":"start"},{"id":"child","type":"subworkflow","data":{"workflowId":"child-recipe"}},{"id":"end","type":"end"}],
                "edges":[{"source":"start","target":"child"},{"source":"child","target":"end"}]
            })).unwrap();
            let parent = compile(parent_dsl.clone(), &config, None).await.unwrap();
            parent.state_checkpointer.save(&Checkpoint::new("thread", parent.graph.schema().initialize_state(), 2, vec!["child".into()])).await.unwrap();
            let child_dsl: WorkflowDsl = serde_json::from_value(json!({"id":"child-recipe",
                "nodes":[{"id":"start","type":"start"},{"id":"remote","type":"remote_agent","data":{"url":"http://127.0.0.1:9999"}},{"id":"end","type":"end"}],
                "edges":[{"source":"start","target":"remote"},{"source":"remote","target":"end"}]
            })).unwrap();
            let mut invocation = subworkflow_journal::ChildOperation::enter(pool.clone(), vec![42;32], "run-1", "run-1", "thread", "root", "child", 2, &json!({}), async { Ok(child_dsl) }).await.unwrap();
            invocation.operation.mark_dispatched().await.unwrap();
            invocation.suspend().await.unwrap();
            let mut child_dsl = invocation.invocation.dsl.clone();
            subworkflow::inject_workflow_context(&mut child_dsl, &invocation.invocation.thread_id, "child");
            let child = compile_with_path(child_dsl, &config, None, vec!["parent".into(),"child-recipe".into()], WorkflowExecutionProfile::Production).await.unwrap();
            child.state_checkpointer.save(&Checkpoint::new(&invocation.invocation.thread_id, child.graph.schema().initialize_state(), 1, vec!["remote".into()])).await.unwrap();
            let mut remote = operations::Operation::enter(pool.clone(), "run-1", &json!([invocation.invocation.scope,"remote",1,"remote"]).to_string(), "run-1", "remote_agent", &json!({}), &json!({})).await.unwrap();
            remote.mark_dispatched().await.unwrap();
            remote.finish(None, "unknown", None).await.unwrap();
            let error = validate_frontier(&parent, &parent_dsl, &pool, &[42;32], "run-1", "run-1", "root", "thread", &config, vec!["parent".into()], false).await.unwrap_err();
            assert!(error.to_string().contains("pending confirmation"), "{error}");
            // Model an externally reconciled success. Validation itself never
            // claims an operation or submits a remote request.
            sqlx::query("UPDATE workflow_operations SET status='succeeded', result_json='{}' WHERE id=?").bind(&remote.id).execute(&pool).await.unwrap();
            validate_frontier(&parent, &parent_dsl, &pool, &[42;32], "run-1", "run-1", "root", "thread", &config, vec!["parent".into()], false).await.unwrap();
            let attempts: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operation_attempts").fetch_one(&pool).await.unwrap();
            assert_eq!(attempts, 2);
        }).await;
    }
}
