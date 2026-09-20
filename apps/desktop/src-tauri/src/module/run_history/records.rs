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

    pub async fn create_span(span: CreateRunSpan) -> Result<()> {
        validate_span_create(&span)?;
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT OR IGNORE INTO run_spans (id, run_id, parent_span_id, kind, status, node_id, node_name, provider, model, tool_name, started_at, attributes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(span.id)
        .bind(span.run_id)
        .bind(span.parent_span_id)
        .bind(span.kind.as_str())
        .bind(span.status.as_str())
        .bind(span.node_id)
        .bind(span.node_name)
        .bind(span.provider)
        .bind(span.model)
        .bind(span.tool_name)
        .bind(span.started_at)
        .bind(span.attributes.to_string())
        .bind(&now)
        .bind(now)
        .execute(&pool)
        .await
        .context("failed to create run telemetry span")?;
        Ok(())
    }

    pub async fn finish_span(id: &str, span: FinishRunSpan) -> Result<()> {
        if id.trim().is_empty() || span.duration_ms.is_some_and(|duration| duration < 0) || !span.attributes.is_object()
        {
            bail!("run span id is required, duration cannot be negative, and attributes must be an object");
        }
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_spans SET status = ?, ended_at = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?, total_tokens = ?, total_tokens_estimated = ?, cache_read_tokens = ?, cache_write_tokens = ?, reasoning_tokens = ?, audio_input_tokens = ?, audio_output_tokens = ?, estimated_cost_microusd = ?, is_byok = ?, error_code = ?, error_message = ?, attributes_json = ?, updated_at = ? WHERE id = ?",
        )
        .bind(span.status.as_str())
        .bind(span.ended_at)
        .bind(span.duration_ms)
        .bind(span.input_tokens)
        .bind(span.output_tokens)
        .bind(span.total_tokens)
        .bind(span.total_tokens_estimated)
        .bind(span.cache_read_tokens)
        .bind(span.cache_write_tokens)
        .bind(span.reasoning_tokens)
        .bind(span.audio_input_tokens)
        .bind(span.audio_output_tokens)
        .bind(span.estimated_cost_microusd)
        .bind(span.is_byok)
        .bind(span.error_code)
        .bind(span.error_message)
        .bind(span.attributes.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("run telemetry span was not found: {id}");
        }
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

fn validate_span_create(span: &CreateRunSpan) -> Result<()> {
    if span.id.trim().is_empty() || span.run_id.trim().is_empty() || span.started_at.trim().is_empty() {
        bail!("run span id, run id, and started at are required");
    }
    if !span.attributes.is_object() {
        bail!("run span attributes must be a JSON object");
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
