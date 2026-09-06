use super::*;

impl RunHistoryStore {
    pub async fn create(record: CreateRunRecord) -> Result<()> {
        validate_create(&record)?;
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO run_records (id, target_type, target_id, target_name, status, started_at, input_json, output_view_json, target_snapshot_json, runtime_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&record.id)
        .bind(record.target_type.as_str())
        .bind(&record.target_id)
        .bind(&record.target_name)
        .bind(record.status.as_str())
        .bind(&record.started_at)
        .bind(record.input.map(|value| value.to_string()))
        .bind(record.output_view.to_string())
        .bind(record.target_snapshot.to_string())
        .bind(record.runtime.to_string())
        .bind(&now)
        .bind(now)
        .execute(&pool)
        .await
        .context("failed to create run record")?;
        Ok(())
    }

    pub async fn append_events(id: &str, request: AppendRunEvents) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        for event in request.events {
            sqlx::query(
                "INSERT OR IGNORE INTO run_events (run_id, sequence, event_json, created_at) VALUES (?, ?, ?, ?)",
            )
            .bind(id)
            .bind(event.sequence)
            .bind(event.event.to_string())
            .bind(event.created_at)
            .execute(&mut *transaction)
            .await?;
        }
        // The cursor makes reconnecting clients independent from their own
        // in-memory projections. It advances only with successfully inserted
        // events inside this transaction.
        sqlx::query(
            "UPDATE run_records SET last_sequence = COALESCE((SELECT MAX(sequence) FROM run_events WHERE run_id = ?), -1), updated_at = ? WHERE id = ?",
        )
        .bind(id)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn finalize(id: &str, record: FinalizeRunRecord) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_records SET status = ?, ended_at = ?, duration_ms = ?, output_view_json = ?, error = ?, updated_at = ? WHERE id = ?",
        )
        .bind(record.status.as_str())
        .bind(record.ended_at)
        .bind(record.duration_ms)
        .bind(record.output_view.to_string())
        .bind(record.error)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("run record was not found: {id}");
        }
        Ok(())
    }

    pub async fn finish_execution(id: &str, status: RunStatus, error: Option<String>) -> Result<()> {
        let pool = DBManager::global().pool()?;
        finish_execution_in_pool(&pool, id, status, error).await
    }

    pub async fn mark_running(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_records SET status = 'running', ended_at = NULL, error = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("run record was not found: {id}");
        }
        Ok(())
    }
}

fn validate_create(record: &CreateRunRecord) -> Result<()> {
    if record.id.trim().is_empty() || record.target_id.trim().is_empty() || record.target_name.trim().is_empty() {
        bail!("run id, target id, and target name are required");
    }
    Ok(())
}
pub(super) async fn finish_execution_in_pool(
    pool: &sqlx::SqlitePool,
    id: &str,
    status: RunStatus,
    error: Option<String>,
) -> Result<()> {
    let finished_at = chrono::Utc::now().to_rfc3339();
    // A terminal run can never consume another user decision. Keep the record
    // and its actions in one transaction so a coordinator cannot claim an
    // action during the transition to failed, cancelled, or interrupted.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let result = sqlx::query(
        "UPDATE run_records SET status = ?, ended_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), error = ?, updated_at = ? WHERE id = ?",
    )
    .bind(status.as_str())
    .bind(&finished_at)
    .bind(&finished_at)
    .bind(error)
    .bind(&finished_at)
    .bind(id)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        bail!("run record was not found: {id}");
    }
    sqlx::query(
        "UPDATE run_pending_actions SET status = 'expired', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
    )
    .bind(&finished_at)
    .bind(id)
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(())
}
