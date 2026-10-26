//! Only finished, unreferenced history can be deleted; recovery facts stay durable.
use super::*;

impl RunHistoryStore {
    pub async fn delete(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        delete_in_pool(&pool, &crate::utils::dirs::active_workspace_id(), id).await
    }
}

async fn delete_in_pool(pool: &sqlx::SqlitePool, workspace: &str, id: &str) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    // Capture ownership before the run's attempt rows cascade away. Other runs
    // can share an operation after recovery, and must retain its private inputs.
    let operations: Vec<String> =
        sqlx::query_scalar("WITH RECURSIVE owned(id) AS (SELECT operation_id FROM workflow_operation_attempts WHERE run_id=? UNION SELECT d.predecessor_id FROM workflow_operation_dependencies d JOIN owned ON owned.id=d.operation_id) SELECT id FROM owned")
            .bind(id)
            .fetch_all(&mut *tx)
            .await?;
    let thread: Option<String> = sqlx::query_scalar(
        "SELECT json_extract(runtime_json,'$.threadId') FROM run_records WHERE id=? AND workspace_id=?",
    )
    .bind(id)
    .bind(workspace)
    .fetch_optional(&mut *tx)
    .await?
    .flatten();
    // Keep eligibility and deletion in one statement to avoid a check/write race.
    let result = sqlx::query(
        "DELETE FROM run_records WHERE id = ? AND workspace_id = ?
         AND status IN ('completed', 'failed', 'cancelled')
         AND NOT EXISTS (SELECT 1 FROM chat_turns WHERE run_id = run_records.id)
         AND NOT EXISTS (SELECT 1 FROM assistant_sessions s WHERE s.active_run_id = run_records.id
                         )
         AND NOT EXISTS (SELECT 1 FROM assistant_messages m WHERE m.run_id = run_records.id)
         AND NOT EXISTS (SELECT 1 FROM run_recovery_jobs WHERE run_id = run_records.id AND status != 'done')
         AND NOT EXISTS (SELECT 1 FROM workflow_abandonments WHERE run_id = run_records.id AND status != 'completed')
         AND NOT EXISTS (SELECT 1 FROM run_pending_actions WHERE run_id = run_records.id AND status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM workflow_operation_attempts a JOIN workflow_operations o ON o.id = a.operation_id
                         WHERE a.run_id = run_records.id AND o.status IN ('pending', 'running', 'unknown'))
         AND NOT EXISTS (SELECT 1 FROM workflow_operation_attempts a JOIN workflow_compensation_intents c ON c.operation_id=a.operation_id WHERE a.run_id=run_records.id AND c.status IN ('pending','running','failed','blocked'))
         AND NOT EXISTS (SELECT 1 FROM workflow_operation_attempts a JOIN workflow_compensation_approvals p ON p.operation_id=a.operation_id WHERE a.run_id=run_records.id AND p.status IN ('pending','granted'))"
    ).bind(id).bind(workspace).execute(&mut *tx).await?;
    if result.rows_affected() != 1 {
        bail!(
            "This record cannot be deleted: it is active, requires follow-up, belongs to a workflow conversation, or was not found in this workspace"
        );
    }
    let has_checkpoints: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='graph_checkpoints')",
    )
    .fetch_one(&mut *tx)
    .await?;
    let mut threads = thread.into_iter().collect::<Vec<_>>();
    let mut pending = operations;
    loop {
        let mut remaining = Vec::new();
        let mut progress = false;
        for operation in pending {
            let child: Option<String> =
                sqlx::query_scalar("SELECT thread_id FROM workflow_subworkflow_invocations WHERE operation_id=?")
                    .bind(&operation)
                    .fetch_optional(&mut *tx)
                    .await?;
            // Shared attempts and dependencies still needed by a different run pin
            // the operation. Its dependent facts use ON DELETE CASCADE.
            let deleted=sqlx::query("DELETE FROM workflow_operations WHERE id=? AND status IN ('succeeded','failed') AND NOT EXISTS(SELECT 1 FROM workflow_compensation_intents c WHERE c.operation_id=workflow_operations.id AND c.status IN ('pending','running','failed','blocked')) AND NOT EXISTS(SELECT 1 FROM workflow_compensation_approvals p WHERE p.operation_id=workflow_operations.id AND p.status IN ('pending','granted')) AND NOT EXISTS(SELECT 1 FROM workflow_operation_attempts WHERE operation_id=workflow_operations.id) AND NOT EXISTS(SELECT 1 FROM workflow_operation_dependencies d WHERE d.predecessor_id=workflow_operations.id)")
            .bind(&operation).execute(&mut *tx).await?;
            if deleted.rows_affected() > 0 {
                threads.extend(child);
                progress = true;
            } else {
                remaining.push(operation);
            }
        }
        if !progress || remaining.is_empty() {
            break;
        }
        pending = remaining;
    }
    if has_checkpoints {
        for thread in threads {
            sqlx::query("DELETE FROM graph_checkpoints WHERE thread_id=? AND NOT EXISTS(SELECT 1 FROM run_records WHERE json_extract(runtime_json,'$.threadId')=?) AND NOT EXISTS(SELECT 1 FROM workflow_subworkflow_invocations WHERE thread_id=?)")
                .bind(&thread).bind(&thread).bind(&thread).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deletion_preserves_active_linked_and_other_workspace_runs() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE run_records(id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT,runtime_json TEXT DEFAULT '{}');
          CREATE TABLE chat_turns(run_id TEXT);
          CREATE TABLE assistant_sessions(active_run_id TEXT);
          CREATE TABLE assistant_messages(run_id TEXT);
          CREATE TABLE run_recovery_jobs(run_id TEXT, status TEXT);
          CREATE TABLE run_pending_actions(run_id TEXT, status TEXT);
          CREATE TABLE workflow_abandonments(run_id TEXT, status TEXT);
          CREATE TABLE workflow_operation_attempts(run_id TEXT, operation_id TEXT);
          CREATE TABLE workflow_operations(id TEXT, status TEXT);
          CREATE TABLE workflow_compensation_intents(operation_id TEXT,status TEXT);
          CREATE TABLE workflow_compensation_approvals(operation_id TEXT,status TEXT);
          CREATE TABLE workflow_subworkflow_invocations(operation_id TEXT,thread_id TEXT);
          CREATE TABLE workflow_operation_dependencies(operation_id TEXT,predecessor_id TEXT);
          INSERT INTO run_records(id,workspace_id,status) VALUES ('finished','personal','completed'),('busy','personal','running'),
          ('linked','personal','completed'),('recovering','personal','failed'),('other','team','completed'),
          ('receipt','personal','completed'),('compensating','personal','cancelled'),('unknown','personal','failed');
          INSERT INTO assistant_messages VALUES ('receipt');
          INSERT INTO workflow_abandonments VALUES ('compensating','pending');
          INSERT INTO workflow_operations VALUES ('op','unknown');
          INSERT INTO workflow_operation_attempts VALUES ('unknown','op');
          INSERT INTO chat_turns VALUES ('linked');
          INSERT INTO run_recovery_jobs VALUES ('recovering','pending');",
        )
        .execute(&pool)
        .await
        .unwrap();
        for id in [
            "busy",
            "linked",
            "recovering",
            "other",
            "missing",
            "receipt",
            "compensating",
            "unknown",
        ] {
            assert!(delete_in_pool(&pool, "personal", id).await.is_err(), "{id}");
        }
        delete_in_pool(&pool, "personal", "finished").await.unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM run_records")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 7);
    }
    #[tokio::test]
    async fn deleting_runs_collects_private_facts_but_preserves_shared_operations() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for schema in [
            include_str!("../../../resources/migrations/20260904083536_create_run_history.up.sql"),
            include_str!("../../../resources/migrations/20261005100000_remote_tasks.up.sql"),
            include_str!("../../../resources/migrations/20261016100000_assistant_workspace.up.sql"),
        ] {
            sqlx::raw_sql(schema).execute(&pool).await.unwrap();
        }
        for (id, thread) in [("one", "thread-one"), ("two", "thread-two")] {
            sqlx::query("INSERT INTO run_records(id,workspace_id,target_type,target_id,target_name,status,started_at,target_snapshot_json,runtime_json,created_at,updated_at) VALUES(?,'personal','workflow','workflow','Workflow','completed','now','{}',?,'now','now')")
                .bind(id).bind(serde_json::json!({"threadId":thread}).to_string()).execute(&pool).await.unwrap();
        }
        for op in ["exclusive", "private", "shared"] {
            sqlx::query("INSERT INTO workflow_operations(id,execution_id,execution_path,adapter,input_digest,snapshot_digest,status,created_at,updated_at) VALUES(?,'execution',?,'tool','input','snapshot','succeeded','now','now')").bind(op).bind(op).execute(&pool).await.unwrap();
            sqlx::query("INSERT INTO workflow_operation_inputs VALUES(?,'encrypted')")
                .bind(op)
                .execute(&pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO workflow_operation_attempts(id,operation_id,run_id,sequence,action,status,started_at) VALUES(?,?,'one',1,'submit','succeeded','now')").bind(op).bind(op).execute(&pool).await.unwrap();
        }
        sqlx::raw_sql("INSERT INTO workflow_operation_dependencies VALUES('shared','private'); INSERT INTO workflow_operation_attempts VALUES('shared-retry','shared','two',2,'reuse','succeeded',NULL,'now','now'); INSERT INTO workflow_subworkflow_invocations VALUES('shared','child-thread','encrypted-snapshot'); CREATE TABLE graph_checkpoints(id TEXT,thread_id TEXT); INSERT INTO graph_checkpoints VALUES('one','thread-one'),('two','thread-two'),('child','child-thread');").execute(&pool).await.unwrap();
        delete_in_pool(&pool, "personal", "one").await.unwrap();
        let operations: Vec<String> = sqlx::query_scalar("SELECT id FROM workflow_operations ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(operations, vec!["private", "shared"]);
        let inputs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operation_inputs")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(inputs, 2);
        let checkpoints: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM graph_checkpoints")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(checkpoints, 2);
        delete_in_pool(&pool, "personal", "two").await.unwrap();
        for table in [
            "workflow_operations",
            "workflow_operation_inputs",
            "workflow_subworkflow_invocations",
            "graph_checkpoints",
        ] {
            let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new("SELECT COUNT(*) FROM ");
            query.push(table);
            let count: i64 = query.build_query_scalar().fetch_one(&pool).await.unwrap();
            assert_eq!(count, 0, "{table}");
        }
        assert!(
            sqlx::query("PRAGMA foreign_key_check")
                .fetch_all(&pool)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
