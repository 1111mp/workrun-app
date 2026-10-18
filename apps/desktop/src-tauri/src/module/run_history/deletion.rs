//! Only finished, unreferenced history can be deleted; recovery facts stay durable.
use super::*;

impl RunHistoryStore {
    pub async fn delete(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        delete_in_pool(&pool, &crate::utils::dirs::active_workspace_id(), id).await
    }
}

async fn delete_in_pool(pool: &sqlx::SqlitePool, workspace: &str, id: &str) -> Result<()> {
    // Keep eligibility and deletion in one statement to avoid a check/write race.
    let result = sqlx::query(
        "DELETE FROM run_records WHERE id = ? AND workspace_id = ?
         AND status IN ('completed', 'failed', 'cancelled')
         AND NOT EXISTS (SELECT 1 FROM chat_turns WHERE run_id = run_records.id)
         AND NOT EXISTS (SELECT 1 FROM assistant_sessions s WHERE json_extract(s.session_json, '$.activeCall.runId') = run_records.id
                         OR EXISTS (SELECT 1 FROM json_each(s.session_json, '$.messages') m WHERE json_extract(m.value, '$.runId') = run_records.id))
         AND NOT EXISTS (SELECT 1 FROM run_recovery_jobs WHERE run_id = run_records.id AND status != 'done')
         AND NOT EXISTS (SELECT 1 FROM workflow_abandonments WHERE run_id = run_records.id AND status != 'completed')
         AND NOT EXISTS (SELECT 1 FROM run_pending_actions WHERE run_id = run_records.id AND status = 'pending')
         AND NOT EXISTS (SELECT 1 FROM workflow_operation_attempts a JOIN workflow_operations o ON o.id = a.operation_id
                         WHERE a.run_id = run_records.id AND o.status IN ('pending', 'running', 'unknown'))"
    ).bind(id).bind(workspace).execute(pool).await?;
    if result.rows_affected() != 1 {
        bail!(
            "This record cannot be deleted: it is active, requires follow-up, belongs to a workflow conversation, or was not found in this workspace"
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn deletion_preserves_active_linked_and_other_workspace_runs() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE run_records(id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT);
          CREATE TABLE chat_turns(run_id TEXT);
          CREATE TABLE assistant_sessions(session_json TEXT);
          CREATE TABLE run_recovery_jobs(run_id TEXT, status TEXT);
          CREATE TABLE run_pending_actions(run_id TEXT, status TEXT);
          CREATE TABLE workflow_abandonments(run_id TEXT, status TEXT);
          CREATE TABLE workflow_operation_attempts(run_id TEXT, operation_id TEXT);
          CREATE TABLE workflow_operations(id TEXT, status TEXT);
          INSERT INTO run_records VALUES ('finished','personal','completed'),('busy','personal','running'),
          ('linked','personal','completed'),('recovering','personal','failed'),('other','team','completed'),
          ('receipt','personal','completed'),('compensating','personal','cancelled'),('unknown','personal','failed');
          INSERT INTO assistant_sessions VALUES ('{\"messages\":[{\"runId\":\"receipt\"}]}');
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
}
