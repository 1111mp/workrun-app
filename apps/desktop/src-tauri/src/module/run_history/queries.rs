use super::*;

// Every query that is converted into a RunRecordSummary must include these
// derived fields: they are stored inside runtime_json rather than as columns.
const RUN_RECORD_SUMMARY_COLUMNS: &str = "id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error, json_extract(runtime_json, '$.releaseId') AS release_id, json_extract(runtime_json, '$.releaseVersion') AS release_version";

impl RunHistoryStore {
    pub async fn list(query: RunHistoryQuery) -> Result<RunHistoryPage> {
        let pool = DBManager::global().pool()?;
        let page_size = query.page_size.unwrap_or(30).clamp(1, 100);
        if let Some(cursor) = &query.cursor {
            if cursor.id.trim().is_empty() || cursor.started_at.trim().is_empty() {
                bail!("run history cursor requires an id and started_at");
            }
        }
        let mut sql = QueryBuilder::<Sqlite>::new("SELECT ");
        sql.push(RUN_RECORD_SUMMARY_COLUMNS)
            .push(" FROM run_records WHERE 1 = 1");

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
        let mut sql = QueryBuilder::<Sqlite>::new("SELECT ");
        let rows = sql
            .push(RUN_RECORD_SUMMARY_COLUMNS)
            .push(" FROM run_records WHERE status IN ('queued', 'running', 'waiting_for_input') ORDER BY started_at DESC, id DESC")
            .build()
            .fetch_all(&pool)
            .await?;
        rows.iter().map(summary_from_row).collect()
    }
    pub async fn inspect(id: &str) -> Result<RunRecord> {
        let pool = DBManager::global().pool()?;
        let mut sql = QueryBuilder::<Sqlite>::new("SELECT ");
        let row = sql
            .push(RUN_RECORD_SUMMARY_COLUMNS)
            .push(", input_json, output_view_json, target_snapshot_json, runtime_json FROM run_records WHERE id = ")
            .push_bind(id)
            .build()
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
        release_id: row.try_get("release_id")?,
        release_version: row.try_get("release_version")?,
    })
}

fn json_column(value: String) -> Result<Value> {
    serde_json::from_str(&value).context("stored run history contains invalid JSON")
}

#[cfg(test)]
mod tests {
    use super::{RUN_RECORD_SUMMARY_COLUMNS, summary_from_row};
    use sqlx::{QueryBuilder, Sqlite, sqlite::SqlitePoolOptions};

    #[tokio::test]
    async fn summary_projection_includes_release_fields_from_runtime_json() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let mut sql = QueryBuilder::<Sqlite>::new("SELECT ");
        let row = sql
            .push(RUN_RECORD_SUMMARY_COLUMNS)
            .push(" FROM (SELECT 'run-1' AS id, 'workflow' AS target_type, 'workflow-1' AS target_id, 'Workflow' AS target_name, 'running' AS status, '2026-09-11T00:00:00Z' AS started_at, NULL AS ended_at, NULL AS duration_ms, NULL AS error, '{\"releaseId\":\"release-1\",\"releaseVersion\":\"1.2.3\"}' AS runtime_json)")
            .build()
            .fetch_one(&pool)
            .await
            .unwrap();

        let summary = summary_from_row(&row).unwrap();
        assert_eq!(summary.release_id.as_deref(), Some("release-1"));
        assert_eq!(summary.release_version.as_deref(), Some("1.2.3"));
    }
}
