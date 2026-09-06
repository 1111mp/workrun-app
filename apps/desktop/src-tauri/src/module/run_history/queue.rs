use super::*;

impl RunHistoryStore {
    pub async fn claim_next_queued_run(include_apps: bool) -> Result<Option<String>> {
        let pool = DBManager::global().pool()?;
        claim_next_queued_run_from_pool(&pool, include_apps).await
    }

    pub async fn enqueue_workflow_resume(id: &str, runtime: Value) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_records SET status = 'queued', ended_at = NULL, error = NULL, runtime_json = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_input'",
        )
        .bind(runtime.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("workflow is no longer waiting for input: {id}");
        }
        Ok(())
    }

    pub async fn cancel_queued_run(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_records SET status = 'cancelled', ended_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), error = ?, updated_at = ? WHERE id = ? AND status = 'queued'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind("Cancelled by user")
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("run is no longer queued: {id}");
        }
        Ok(())
    }

    pub async fn last_sequence(id: &str) -> Result<i64> {
        let pool = DBManager::global().pool()?;
        Ok(
            sqlx::query_scalar::<_, i64>("SELECT last_sequence FROM run_records WHERE id = ?")
                .bind(id)
                .fetch_optional(&pool)
                .await?
                .ok_or_else(|| anyhow::anyhow!("run record was not found: {id}"))?,
        )
    }
}

pub(super) async fn claim_next_queued_run_from_pool(
    pool: &sqlx::SqlitePool,
    include_apps: bool,
) -> Result<Option<String>> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let id = sqlx::query_scalar::<_, String>(
        "SELECT id FROM run_records WHERE status = 'queued' AND (target_type = 'workflow' OR ?) ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .bind(include_apps)
    .fetch_optional(&mut *transaction)
    .await?;
    let Some(id) = id else {
        transaction.commit().await?;
        return Ok(None);
    };
    let result = sqlx::query(
        "UPDATE run_records SET status = 'running', ended_at = NULL, error = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
    )
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(&id)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        bail!("queued run was no longer available: {id}");
    }
    transaction.commit().await?;
    Ok(Some(id))
}
