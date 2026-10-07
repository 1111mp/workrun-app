//! Parent operation facts and child checkpoint identities are distinct records.
use super::{
    WorkflowDsl,
    operations::{ExecutionCapabilities, Operation},
};
use anyhow::{Result, anyhow};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::SqlitePool;

const CAPABILITIES: ExecutionCapabilities = ExecutionCapabilities {
    reuse_result: true,
    reconcile_existing: true,
};

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Invocation {
    pub dsl: WorkflowDsl,
    pub input: Value,
    pub thread_id: String,
    pub scope: String,
}

pub(super) struct ChildOperation {
    pub operation: Operation,
    pub invocation: Invocation,
    key: Vec<u8>,
}

fn decrypt<T: serde::de::DeserializeOwned>(ciphertext: &str, key: &[u8]) -> Result<T> {
    let plaintext = crate::config::decrypt_data_with_key(ciphertext, key)
        .map_err(|_| anyhow!("Cannot decrypt subworkflow execution snapshot"))?;
    Ok(serde_json::from_str(&plaintext)?)
}

pub(super) async fn saved_invocation(
    pool: &SqlitePool,
    key: &[u8],
    execution_id: &str,
    path: &str,
) -> Result<Option<Invocation>> {
    let saved: Option<String> = sqlx::query_scalar("SELECT s.snapshot_ciphertext FROM workflow_subworkflow_invocations s JOIN workflow_operations o ON o.id = s.operation_id WHERE o.execution_id = ? AND o.execution_path = ?")
        .bind(execution_id).bind(path).fetch_optional(pool).await?;
    saved.map(|saved| decrypt(&saved, key)).transpose()
}

pub(super) async fn saved_by_thread(pool: &SqlitePool, key: &[u8], thread_id: &str) -> Result<Option<Invocation>> {
    let saved: Option<String> =
        sqlx::query_scalar("SELECT snapshot_ciphertext FROM workflow_subworkflow_invocations WHERE thread_id = ?")
            .bind(thread_id)
            .fetch_optional(pool)
            .await?;
    saved.map(|saved| decrypt(&saved, key)).transpose()
}

impl ChildOperation {
    #[allow(clippy::too_many_arguments)]
    pub async fn enter(
        pool: SqlitePool,
        key: Vec<u8>,
        execution_id: &str,
        run_id: &str,
        parent_thread: &str,
        scope: &str,
        node: &str,
        step: usize,
        input: &Value,
        load_dsl: impl std::future::Future<Output = Result<WorkflowDsl>>,
    ) -> Result<Self> {
        let path = json!([scope, node, step, "subworkflow"]).to_string();
        let saved = saved_invocation(&pool, &key, execution_id, &path).await?;
        if saved.is_none() {
            let dispatched: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE execution_id = ? AND execution_path = ? AND dispatched_at IS NOT NULL)")
                .bind(execution_id).bind(&path).fetch_one(&pool).await?;
            if dispatched {
                return Err(anyhow!("Subworkflow invocation snapshot missing; restart disabled"));
            }
            super::recovery::reject_legacy_child(parent_thread, node).await?;
        }
        // Never consult a mutable child recipe during recovery.
        let dsl = match &saved {
            Some(saved) => saved.dsl.clone(),
            None => load_dsl.await?,
        };
        let mut operation = Operation::enter(
            pool.clone(),
            execution_id,
            &path,
            run_id,
            "subworkflow",
            input,
            &json!({"dsl":dsl, "capabilities":CAPABILITIES}),
        )
        .await?;
        operation
            .prepare_compensation(&key, input, &json!({"dsl":dsl, "capabilities":CAPABILITIES}))
            .await?;
        operation.action(CAPABILITIES)?;
        let invocation = match saved {
            Some(saved) => saved,
            None => {
                let invocation = Invocation {
                    dsl,
                    input: input.clone(),
                    thread_id: format!("{parent_thread}/{}", operation.id),
                    scope: json!([scope, node, step]).to_string(),
                };
                let ciphertext = crate::config::encrypt_data_with_key(&serde_json::to_string(&invocation)?, &key)
                    .map_err(|_| anyhow!("Cannot encrypt subworkflow invocation"))?;
                sqlx::query("INSERT INTO workflow_subworkflow_invocations (operation_id, thread_id, snapshot_ciphertext) VALUES (?, ?, ?)")
                    .bind(&operation.id).bind(&invocation.thread_id).bind(ciphertext).execute(&pool).await?;
                invocation
            },
        };
        Ok(Self {
            operation,
            invocation,
            key,
        })
    }

    pub fn receipt(&self) -> Result<Option<Value>> {
        self.operation
            .result
            .as_ref()
            .map(|saved| {
                let ciphertext = saved["subworkflowResultCiphertext"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid saved subworkflow result"))?;
                decrypt(ciphertext, &self.key)
            })
            .transpose()
    }

    pub async fn complete(&mut self, receipt: &Value) -> Result<()> {
        let ciphertext = crate::config::encrypt_data_with_key(&receipt.to_string(), &self.key)
            .map_err(|_| anyhow!("Cannot encrypt subworkflow result"))?;
        self.operation
            .finish(
                Some(&json!({"subworkflowResultCiphertext":ciphertext})),
                "succeeded",
                None,
            )
            .await
    }

    pub async fn suspend(&mut self) -> Result<()> {
        // A failed/paused child is still the same business operation. Its own
        // checkpoint and descendant journals decide what can continue.
        self.operation
            .finish(
                None,
                "unknown",
                Some("Subworkflow unfinished; restore its original checkpoint and reconcile descendants"),
            )
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dsl() -> WorkflowDsl {
        serde_json::from_value(json!({"id":"child", "name":"original", "nodes":[{"id":"start", "type":"start"},{"id":"end", "type":"end"}], "edges":[{"source":"start", "target":"end"}]})).unwrap()
    }

    #[tokio::test]
    async fn child_success_is_reused_before_parent_checkpoint_without_reloading_recipe() {
        let pool = super::super::remote_tasks::test_pool().await;
        let input = json!({"document":"private-input"});
        let mut first = ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "root-thread",
            "root",
            "child-node",
            2,
            &input,
            async { Ok(dsl()) },
        )
        .await
        .unwrap();
        first.operation.mark_dispatched().await.unwrap();
        let thread = first.invocation.thread_id.clone();
        let id = first.operation.id.clone();
        let receipt = json!({"result":{"summary":"done"}, "execution":[], "terminated":false});
        first.complete(&receipt).await.unwrap();
        // Only the child receipt is committed. Parent State/checkpoint is absent.
        let mut resumed = ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "root-thread",
            "root",
            "child-node",
            2,
            &input,
            async { panic!("must not fetch latest child DSL") },
        )
        .await
        .unwrap();
        assert_eq!(resumed.invocation.thread_id, thread);
        assert_eq!(resumed.operation.id, id);
        assert_eq!(resumed.receipt().unwrap(), Some(receipt.clone()));
        resumed.complete(&receipt).await.unwrap();
        let actions: Vec<String> =
            sqlx::query_scalar("SELECT action FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(actions, ["submit", "reuse"]);
        let saved = saved_by_thread(&pool, &[42; 32], &thread).await.unwrap().unwrap();
        assert_eq!(saved.dsl.name, "original");
        let raw: String = sqlx::query_scalar("SELECT snapshot_ciphertext FROM workflow_subworkflow_invocations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!raw.contains("private-input"));
        assert!(!raw.contains("original"));
    }

    #[tokio::test]
    async fn unfinished_child_keeps_thread_snapshot_and_records_reconciliation_attempt() {
        let pool = super::super::remote_tasks::test_pool().await;
        let mut first = ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child-node",
            2,
            &json!({}),
            async { Ok(dsl()) },
        )
        .await
        .unwrap();
        first.operation.mark_dispatched().await.unwrap();
        let thread = first.invocation.thread_id.clone();
        first.suspend().await.unwrap();
        super::super::operations::recover_interrupted(&pool).await.unwrap();
        let mut resumed = ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child-node",
            2,
            &json!({}),
            async { panic!("saved DSL only") },
        )
        .await
        .unwrap();
        assert_eq!(resumed.invocation.thread_id, thread);
        assert!(!resumed.operation.can_submit);
        assert!(resumed.receipt().unwrap().is_none());
        resumed.suspend().await.unwrap();
        let actions: Vec<String> =
            sqlx::query_scalar("SELECT action FROM workflow_operation_attempts ORDER BY sequence")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(actions, ["submit", "reconcile"]);
        let mut next_loop = ChildOperation::enter(
            pool,
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child-node",
            3,
            &json!({}),
            async { Ok(dsl()) },
        )
        .await
        .unwrap();
        assert_ne!(next_loop.invocation.thread_id, thread);
        assert!(next_loop.operation.can_submit);
        next_loop.suspend().await.unwrap();
    }

    #[tokio::test]
    async fn missing_dispatched_child_snapshot_cannot_create_a_new_invocation() {
        let pool = super::super::remote_tasks::test_pool().await;
        let mut first = ChildOperation::enter(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "run-1",
            "thread",
            "root",
            "child-node",
            2,
            &json!({}),
            async { Ok(dsl()) },
        )
        .await
        .unwrap();
        first.operation.mark_dispatched().await.unwrap();
        first.suspend().await.unwrap();
        sqlx::query("DELETE FROM workflow_subworkflow_invocations")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            ChildOperation::enter(
                pool,
                vec![42; 32],
                "run-1",
                "run-1",
                "thread",
                "root",
                "child-node",
                2,
                &json!({}),
                async { panic!("must not fetch a new recipe") }
            )
            .await
            .is_err()
        );
    }
}
