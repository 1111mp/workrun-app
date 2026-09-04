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
    Running,
    Completed,
    Failed,
    Interrupted,
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    #[serde(flatten)]
    pub summary: RunRecordSummary,
    pub input: Option<Value>,
    pub output_view: Value,
    pub target_snapshot: Value,
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
            "INSERT INTO run_records (id, target_type, target_id, target_name, status, started_at, input_json, output_view_json, target_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

    pub async fn inspect(id: &str) -> Result<RunRecord> {
        let pool = DBManager::global().pool()?;
        let row = sqlx::query("SELECT id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error, input_json, output_view_json, target_snapshot_json FROM run_records WHERE id = ?")
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
            events,
        })
    }
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
