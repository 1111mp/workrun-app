//! Conservative tool replay: ordinal identity plus exact input/config matching.
//! Provider call IDs and argument hashes alone cannot identify repeated calls.
use super::operations::{ExecutionAction, ExecutionCapabilities, Operation};
use anyhow::{Result, bail};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::sync::{Arc, Mutex};

pub(super) const CAPABILITIES: ExecutionCapabilities = ExecutionCapabilities {
    reuse_result: true,
    reconcile_existing: false,
};

tokio::task_local! {
    pub(super) static CURRENT: Arc<ToolJournal>;
}

pub(super) struct ToolJournal {
    pool: SqlitePool,
    key: Vec<u8>,
    execution_id: String,
    run_id: String,
    prefix: Value,
    state: Mutex<(usize, Option<String>)>,
    existing: usize,
}

impl ToolJournal {
    pub async fn new(
        pool: SqlitePool,
        key: Vec<u8>,
        execution_id: &str,
        run_id: &str,
        scope: &str,
        node: &str,
        step: usize,
    ) -> Result<Self> {
        let prefix = json!([scope, node, step, "tool"]);
        let existing: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operations WHERE execution_id = ? AND adapter = 'tool' AND json_extract(execution_path, '$[0]') = ? AND json_extract(execution_path, '$[1]') = ? AND json_extract(execution_path, '$[2]') = ?")
            .bind(execution_id).bind(scope).bind(node).bind(step as i64).fetch_one(&pool).await?;
        Ok(Self {
            pool,
            key,
            execution_id: execution_id.into(),
            run_id: run_id.into(),
            prefix,
            state: Mutex::new((0, None)),
            existing: existing as usize,
        })
    }

    pub fn fail(&self, error: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.1.get_or_insert_with(|| error.to_owned());
        }
    }

    pub fn check(&self, complete: bool) -> Result<()> {
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow::anyhow!("Tool journal lock unavailable"))?;
        if let Some(error) = &state.1 {
            bail!("{error}");
        }
        // A changed model response that skips an old call is not proof that its
        // side effect disappeared. Do not silently complete a divergent replay.
        if complete && state.0 < self.existing {
            bail!("Agent recovery skipped recorded tool calls; manual reconciliation required");
        }
        Ok(())
    }

    pub async fn enter(&self, input: &Value, snapshot: &Value) -> Result<Operation> {
        self.check(false)?;
        let ordinal = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| anyhow::anyhow!("Tool journal lock unavailable"))?;
            let ordinal = state.0;
            state.0 += 1;
            ordinal
        };
        let mut path = self.prefix.clone();
        path.as_array_mut().unwrap().push(json!(ordinal));
        let mut operation = Operation::enter(
            self.pool.clone(),
            &self.execution_id,
            &path.to_string(),
            &self.run_id,
            "tool",
            input,
            snapshot,
        )
        .await?;
        operation.prepare_compensation(&self.key, input, snapshot).await?;
        let action = match operation.action(CAPABILITIES) {
            Ok(action) => action,
            Err(error) => {
                operation
                    .finish(None, "unknown", Some("Tool adapter cannot reconcile this operation"))
                    .await?;
                return Err(error);
            },
        };
        if action == ExecutionAction::Submit {
            let encrypted = crate::config::encrypt_data_with_key(&input.to_string(), &self.key)
                .map_err(|_| anyhow::anyhow!("Cannot encrypt tool execution input"))?;
            sqlx::query("INSERT OR IGNORE INTO workflow_tool_inputs (operation_id, input_ciphertext) VALUES (?, ?)")
                .bind(&operation.id)
                .bind(encrypted)
                .execute(&self.pool)
                .await?;
        }
        Ok(operation)
    }

    pub fn encode(&self, result: &Value) -> Result<Value> {
        let encrypted = crate::config::encrypt_data_with_key(&result.to_string(), &self.key)
            .map_err(|_| anyhow::anyhow!("Cannot encrypt tool result"))?;
        Ok(json!({"toolResultCiphertext": encrypted}))
    }

    pub fn decode(&self, result: &Value) -> Result<Value> {
        let encrypted = result["toolResultCiphertext"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid saved tool result"))?;
        let decrypted = crate::config::decrypt_data_with_key(encrypted, &self.key)
            .map_err(|_| anyhow::anyhow!("Cannot decrypt tool result"))?;
        Ok(serde_json::from_str(&decrypted)?)
    }
}

/// Recovery never promotes risk-level metadata into an idempotency promise.
pub(crate) async fn validate_recovery(
    pool: &SqlitePool,
    execution_id: &str,
    scope: &str,
    node: &str,
    step: usize,
) -> Result<()> {
    let unsafe_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operations WHERE execution_id = ? AND adapter = 'tool' AND json_extract(execution_path, '$[0]') = ? AND json_extract(execution_path, '$[1]') = ? AND json_extract(execution_path, '$[2]') = ? AND (status = 'running' OR (dispatched_at IS NOT NULL AND result_json IS NULL AND confirmed_no_effect=0))")
        .bind(execution_id).bind(scope).bind(node).bind(step as i64).fetch_one(pool).await?;
    if unsafe_count > 0 {
        bail!("Tool result pending confirmation; this adapter has no reconciliation contract, resubmission disabled");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn repeated_identical_calls_and_loop_invocations_have_distinct_identities() {
        let pool = super::super::remote_tasks::test_pool().await;
        let input = json!({"file":"same"});
        let snapshot = json!({"tool":"upload"});
        let journal = ToolJournal::new(pool.clone(), vec![42; 32], "run-1", "run-1", "root", "agent", 2)
            .await
            .unwrap();
        let mut ids = Vec::new();
        for _ in 0..2 {
            let mut op = journal.enter(&input, &snapshot).await.unwrap();
            op.mark_dispatched().await.unwrap();
            op.finish(Some(&journal.encode(&json!({"id":op.id})).unwrap()), "succeeded", None)
                .await
                .unwrap();
            ids.push(op.id.clone());
        }
        assert_ne!(ids[0], ids[1]);
        let resumed = ToolJournal::new(pool.clone(), vec![42; 32], "run-1", "run-1", "root", "agent", 2)
            .await
            .unwrap();
        for id in ids {
            let mut op = resumed.enter(&input, &snapshot).await.unwrap();
            assert_eq!(op.id, id);
            let result = op.result.clone().unwrap();
            assert_eq!(resumed.decode(&result).unwrap()["id"], id);
            op.finish(Some(&result), "succeeded", None).await.unwrap();
        }
        resumed.check(true).unwrap();
        let next = ToolJournal::new(pool, vec![42; 32], "run-1", "run-1", "root", "agent", 3)
            .await
            .unwrap();
        let mut op = next.enter(&input, &snapshot).await.unwrap();
        assert!(op.can_submit);
        op.finish(None, "failed", Some("preflight")).await.unwrap();
    }

    #[tokio::test]
    async fn startup_keeps_dispatched_tool_without_saved_result_unknown() {
        let pool = super::super::remote_tasks::test_pool().await;
        let journal = ToolJournal::new(pool.clone(), vec![42; 32], "run-1", "run-1", "root", "agent", 2)
            .await
            .unwrap();
        let mut op = journal.enter(&json!({}), &json!({})).await.unwrap();
        op.mark_dispatched().await.unwrap();
        // Simulate hard exit rather than Drop's best-effort cleanup.
        op.committed();
        super::super::operations::recover_interrupted(&pool).await.unwrap();
        assert!(validate_recovery(&pool, "run-1", "root", "agent", 2).await.is_err());
        let resumed = ToolJournal::new(pool.clone(), vec![42; 32], "run-1", "run-1", "root", "agent", 2)
            .await
            .unwrap();
        assert!(resumed.enter(&json!({}), &json!({})).await.is_err());
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
    }
}
