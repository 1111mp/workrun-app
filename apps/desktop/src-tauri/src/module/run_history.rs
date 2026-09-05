//! Local, append-only execution history for Workflow and App runs.

use crate::core::db::DBManager;
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{QueryBuilder, Row, Sqlite};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunRecord {
    pub id: String,
    pub target_type: RunTargetType,
    pub target_id: String,
    pub target_name: String,
    pub status: RunStatus,
    pub started_at: String,
    pub input: Option<Value>,
    pub output_view: Value,
    pub target_snapshot: Value,
    #[serde(default)]
    pub runtime: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeRunRecord {
    pub status: RunStatus,
    pub ended_at: String,
    pub duration_ms: i64,
    pub output_view: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendRunEvents {
    pub events: Vec<NewRunEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRunEvent {
    pub sequence: i64,
    pub event: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryQuery {
    pub target_type: Option<RunTargetType>,
    pub target_id: Option<String>,
    pub status: Option<RunStatus>,
    pub query: Option<String>,
    pub page_size: Option<i64>,
    pub cursor: Option<RunHistoryCursor>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryCursor {
    pub id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryPage {
    pub items: Vec<RunRecordSummary>,
    pub next_cursor: Option<RunHistoryCursor>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTargetType {
    Workflow,
    App,
}

impl RunTargetType {
    fn as_str(self) -> &'static str {
        match self {
            Self::Workflow => "workflow",
            Self::App => "app",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingForInput,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingForInput => "waiting_for_input",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordSummary {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_name: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingActionKind {
    ToolApproval,
    HumanReview,
    AskUserQuestion,
}

impl PendingActionKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::ToolApproval => "tool_approval",
            Self::HumanReview => "human_review",
            Self::AskUserQuestion => "ask_user_question",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePendingAction {
    pub id: String,
    pub run_id: String,
    pub kind: PendingActionKind,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub payload: Value,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    #[serde(flatten)]
    pub summary: RunRecordSummary,
    pub input: Option<Value>,
    pub output_view: Value,
    pub target_snapshot: Value,
    pub runtime: Value,
    pub events: Vec<StoredRunEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRunEvent {
    pub sequence: i64,
    pub event: Value,
    pub created_at: String,
}

pub struct RunHistoryStore;

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

    pub async fn list(query: RunHistoryQuery) -> Result<RunHistoryPage> {
        let pool = DBManager::global().pool()?;
        let page_size = query.page_size.unwrap_or(30).clamp(1, 100);
        if let Some(cursor) = &query.cursor {
            if cursor.id.trim().is_empty() || cursor.started_at.trim().is_empty() {
                bail!("run history cursor requires an id and started_at");
            }
        }
        let mut sql = QueryBuilder::<Sqlite>::new(
            "SELECT id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error FROM run_records WHERE 1 = 1",
        );

        if let Some(target_type) = query.target_type {
            sql.push(" AND target_type = ").push_bind(target_type.as_str());
        }
        if let Some(target_id) = query.target_id {
            sql.push(" AND target_id = ").push_bind(target_id);
        }
        if let Some(status) = query.status {
            sql.push(" AND status = ").push_bind(status.as_str());
        }
        if let Some(name_query) = query.query.filter(|value| !value.trim().is_empty()) {
            sql.push(" AND target_name LIKE ")
                .push_bind(format!("%{}%", name_query.trim()));
        }
        if let Some(cursor) = query.cursor {
            // The ID tie-breaker makes pagination stable when several runs share a timestamp.
            sql.push(" AND (started_at < ")
                .push_bind(&cursor.started_at)
                .push(" OR (started_at = ")
                .push_bind(cursor.started_at)
                .push(" AND id < ")
                .push_bind(cursor.id)
                .push("))");
        }

        sql.push(" ORDER BY started_at DESC, id DESC LIMIT ")
            .push_bind(page_size + 1);
        let rows = sql.build().fetch_all(&pool).await?;
        let mut items = rows
            .into_iter()
            .map(|row| summary_from_row(&row))
            .collect::<Result<Vec<_>>>()?;
        let next_cursor = if items.len() > page_size as usize {
            items.pop();
            items.last().map(|item| RunHistoryCursor {
                id: item.id.clone(),
                started_at: item.started_at.clone(),
            })
        } else {
            None
        };
        Ok(RunHistoryPage { items, next_cursor })
    }

    pub async fn list_active() -> Result<Vec<RunRecordSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query(
            "SELECT id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error FROM run_records WHERE status IN ('queued', 'running', 'waiting_for_input') ORDER BY started_at DESC, id DESC",
        )
        .fetch_all(&pool)
        .await?;
        rows.iter().map(summary_from_row).collect()
    }

    pub async fn create_pending_action(action: CreatePendingAction) -> Result<()> {
        if action.id.trim().is_empty() || action.run_id.trim().is_empty() {
            bail!("pending action id and run id are required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "INSERT INTO run_pending_actions (id, run_id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        )
        .bind(&action.id)
        .bind(&action.run_id)
        .bind(action.kind.as_str())
        .bind(action.payload.to_string())
        .bind(&action.created_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE run_records SET status = 'waiting_for_input', updated_at = ? WHERE id = ?")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&action.run_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_pending_actions() -> Result<Vec<PendingAction>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at FROM run_pending_actions WHERE status = 'pending' ORDER BY created_at ASC, id ASC",
        )
        .fetch_all(&pool)
        .await?;
        rows.into_iter()
            .map(|row| {
                Ok(PendingAction {
                    id: row.try_get("id")?,
                    run_id: row.try_get("run_id")?,
                    kind: row.try_get("kind")?,
                    payload: json_column(row.try_get("payload_json")?)?,
                    status: row.try_get("status")?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }

    /// Atomically reserve the oldest unclaimed action for one UI coordinator.
    /// A transaction is necessary because multiple webviews may observe the
    /// same queue before either has rendered its Drawer.
    pub async fn claim_next_pending_action(claimant_id: &str) -> Result<Option<PendingAction>> {
        let pool = DBManager::global().pool()?;
        claim_next_pending_action_from_pool(&pool, claimant_id).await
    }

    pub async fn release_pending_action(id: &str, claimant_id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let result = sqlx::query(
            "UPDATE run_pending_actions SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(id)
        .bind(claimant_id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("pending action is no longer claimed by this coordinator: {id}");
        }
        Ok(())
    }

    pub async fn inspect_pending_action(id: &str, claimant_id: &str) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        let row = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at FROM run_pending_actions WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(id)
        .bind(claimant_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("pending action is no longer claimed by this coordinator: {id}"))?;
        pending_action_from_row(&row)
    }

    pub async fn resolve_pending_action(
        id: &str,
        claimant_id: Option<&str>,
        resolution: Value,
    ) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        // A claimed action may only be resolved by its owner. The unclaimed
        // branch preserves the existing command's compatibility for callers
        // that do not render a global approval surface.
        let mut query =
            QueryBuilder::<Sqlite>::new("UPDATE run_pending_actions SET status = 'resolved', resolved_at = ");
        query
            .push_bind(chrono::Utc::now().to_rfc3339())
            .push(", resolution_json = ")
            .push_bind(resolution.to_string())
            .push(" WHERE id = ")
            .push_bind(id)
            .push(" AND status = 'pending'");
        if let Some(claimant_id) = claimant_id {
            query.push(" AND claimed_by = ").push_bind(claimant_id);
        } else {
            query.push(" AND claimed_by IS NULL");
        }
        let result = query.build().execute(&mut *transaction).await?;
        if result.rows_affected() == 0 {
            bail!("pending action is no longer available: {id}");
        }
        let row = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at FROM run_pending_actions WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
        let action = pending_action_from_row(&row)?;
        transaction.commit().await?;
        Ok(action)
    }

    /// Resolve a claimed workflow action and transition its run back to
    /// `running` in the same SQLite transaction. Spawning the native task
    /// happens immediately afterwards and cannot be claimed by another UI.
    pub async fn resolve_claimed_action_and_mark_running(
        id: &str,
        claimant_id: &str,
        resolution: Value,
    ) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        let result = sqlx::query(
            "UPDATE run_pending_actions SET status = 'resolved', resolved_at = ?, resolution_json = ? WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(resolution.to_string())
        .bind(id)
        .bind(claimant_id)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            bail!("pending action is no longer available: {id}");
        }
        let row = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at FROM run_pending_actions WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
        let action = pending_action_from_row(&row)?;
        let result = sqlx::query(
            "UPDATE run_records SET status = 'running', ended_at = NULL, error = NULL, updated_at = ? WHERE id = ? AND status = 'waiting_for_input'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&action.run_id)
        .execute(&mut *transaction)
        .await?;
        if result.rows_affected() == 0 {
            bail!("workflow is no longer waiting for input: {}", action.run_id);
        }
        transaction.commit().await?;
        Ok(action)
    }

    /// Cancelling is only used for a paused run, so every unresolved prompt
    /// belonging to that run must become unavailable before it can be resumed.
    pub async fn cancel_pending_actions(run_id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        sqlx::query(
            "UPDATE run_pending_actions SET status = 'cancelled', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(run_id)
        .execute(&pool)
        .await?;
        Ok(())
    }

    pub async fn inspect(id: &str) -> Result<RunRecord> {
        let pool = DBManager::global().pool()?;
        let row = sqlx::query("SELECT id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error, input_json, output_view_json, target_snapshot_json, runtime_json FROM run_records WHERE id = ?")
            .bind(id)
            .fetch_optional(&pool)
            .await?
            .ok_or_else(|| anyhow::anyhow!("run record was not found: {id}"))?;
        let summary = summary_from_row(&row)?;
        let events =
            sqlx::query("SELECT sequence, event_json, created_at FROM run_events WHERE run_id = ? ORDER BY sequence")
                .bind(id)
                .fetch_all(&pool)
                .await?
                .into_iter()
                .map(|event| {
                    Ok(StoredRunEvent {
                        sequence: event.try_get("sequence")?,
                        event: json_column(event.try_get("event_json")?)?,
                        created_at: event.try_get("created_at")?,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
        Ok(RunRecord {
            summary,
            input: row
                .try_get::<Option<String>, _>("input_json")?
                .map(json_column)
                .transpose()?,
            output_view: json_column(row.try_get("output_view_json")?)?,
            target_snapshot: json_column(row.try_get("target_snapshot_json")?)?,
            runtime: json_column(row.try_get("runtime_json")?)?,
            events,
        })
    }
}

async fn finish_execution_in_pool(
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

fn pending_action_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<PendingAction> {
    Ok(PendingAction {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        kind: row.try_get("kind")?,
        payload: json_column(row.try_get("payload_json")?)?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
    })
}

async fn claim_next_pending_action_from_pool(
    pool: &sqlx::SqlitePool,
    claimant_id: &str,
) -> Result<Option<PendingAction>> {
    if claimant_id.trim().is_empty() {
        bail!("pending action claimant is required");
    }
    // This read-then-write operation must reserve SQLite's single writer at
    // the start. A deferred transaction can read while the event writer owns
    // the write lock, then fail immediately when upgrading to UPDATE.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    // Renderer reloads retain their session claimant ID. Return its existing
    // reservation first, because the previous page may have been destroyed
    // before its asynchronous release command reached the native process.
    if let Some(row) = sqlx::query(
        "SELECT a.id, a.run_id, a.kind, a.payload_json, a.status, a.created_at FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.status = 'pending' AND a.claimed_by = ? AND r.status = 'waiting_for_input' ORDER BY a.created_at ASC, a.id ASC LIMIT 1",
    )
    .bind(claimant_id)
    .fetch_optional(&mut *transaction)
    .await?
    {
        transaction.commit().await?;
        return Ok(Some(pending_action_from_row(&row)?));
    }
    let claimed_at = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE run_pending_actions SET claimed_by = ?, claimed_at = ? WHERE id = (SELECT a.id FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.status = 'pending' AND a.claimed_by IS NULL AND r.status = 'waiting_for_input' ORDER BY a.created_at ASC, a.id ASC LIMIT 1) AND status = 'pending' AND claimed_by IS NULL",
    )
    .bind(claimant_id)
    .bind(&claimed_at)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        transaction.commit().await?;
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT a.id, a.run_id, a.kind, a.payload_json, a.status, a.created_at FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.claimed_by = ? AND a.claimed_at = ? AND r.status = 'waiting_for_input'",
    )
    .bind(claimant_id)
    .bind(&claimed_at)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(pending_action_from_row(&row)?))
}

fn validate_create(record: &CreateRunRecord) -> Result<()> {
    if record.id.trim().is_empty() || record.target_id.trim().is_empty() || record.target_name.trim().is_empty() {
        bail!("run id, target id, and target name are required");
    }
    Ok(())
}

fn summary_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<RunRecordSummary> {
    Ok(RunRecordSummary {
        id: row.try_get("id")?,
        target_type: row.try_get("target_type")?,
        target_id: row.try_get("target_id")?,
        target_name: row.try_get("target_name")?,
        status: row.try_get("status")?,
        started_at: row.try_get("started_at")?,
        ended_at: row.try_get("ended_at")?,
        duration_ms: row.try_get("duration_ms")?,
        error: row.try_get("error")?,
    })
}

fn json_column(value: String) -> Result<Value> {
    serde_json::from_str(&value).context("stored run history contains invalid JSON")
}

#[cfg(test)]
mod tests {
    use super::{RunStatus, claim_next_pending_action_from_pool, finish_execution_in_pool};
    use sqlx::{Row, SqlitePool, sqlite::SqlitePoolOptions};

    async fn pending_action_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            // An in-memory SQLite database belongs to one connection. Keeping
            // it single-connection still exercises the transaction boundary
            // while avoiding a second, empty in-memory database.
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT, resolved_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, status, started_at) VALUES ('run-1', 'waiting_for_input', '2026-09-05T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        for (id, created_at) in [
            ("action-1", "2026-09-05T00:00:01Z"),
            ("action-2", "2026-09-05T00:00:02Z"),
        ] {
            sqlx::query(
                "INSERT INTO run_pending_actions (id, run_id, kind, payload_json, status, created_at) VALUES (?, 'run-1', 'tool_approval', '{}', 'pending', ?)",
            )
            .bind(id)
            .bind(created_at)
            .execute(&pool)
            .await
            .unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn concurrent_coordinators_claim_distinct_oldest_actions() {
        let pool = pending_action_pool().await;
        let (first, second) = tokio::join!(
            claim_next_pending_action_from_pool(&pool, "drawer-a"),
            claim_next_pending_action_from_pool(&pool, "drawer-b"),
        );
        let mut claimed = [first.unwrap().unwrap().id, second.unwrap().unwrap().id];
        claimed.sort();
        assert_eq!(claimed, ["action-1", "action-2"]);
    }

    #[tokio::test]
    async fn reclaims_the_action_already_owned_by_the_reloaded_coordinator() {
        let pool = pending_action_pool().await;
        assert_eq!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .unwrap()
                .id,
            "action-1"
        );

        assert_eq!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .unwrap()
                .id,
            "action-1"
        );
    }

    #[tokio::test]
    async fn terminal_run_actions_are_expired_and_cannot_be_claimed() {
        let pool = pending_action_pool().await;

        finish_execution_in_pool(
            &pool,
            "run-1",
            RunStatus::Failed,
            Some("event persistence failed".to_string()),
        )
        .await
        .unwrap();

        assert!(
            claim_next_pending_action_from_pool(&pool, "drawer-a")
                .await
                .unwrap()
                .is_none()
        );
        let expired: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_pending_actions WHERE run_id = 'run-1' AND status = 'expired'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(expired, 2);
    }

    #[tokio::test]
    async fn finishing_a_run_updates_the_requested_record() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL, resolved_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, status, started_at) VALUES ('run-1', 'running', '2026-09-05T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();

        finish_execution_in_pool(&pool, "run-1", RunStatus::Completed, None)
            .await
            .unwrap();

        let row = sqlx::query("SELECT status, ended_at FROM run_records WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("status"), "completed");
        assert!(row.get::<Option<String>, _>("ended_at").is_some());
    }
}
