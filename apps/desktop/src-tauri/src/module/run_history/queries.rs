use super::*;
use std::collections::BTreeMap;

// Versions are immutable run metadata, so history lists read them from the
// snapshot rather than the mutable App catalog.
const RUN_RECORD_SUMMARY_COLUMNS: &str = "id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error, json_extract(runtime_json, '$.releaseId') AS release_id, json_extract(runtime_json, '$.releaseVersion') AS release_version, json_extract(target_snapshot_json, '$.version') AS app_version, (SELECT SUM(CASE WHEN total_tokens IS NOT NULL THEN total_tokens WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) END) FROM run_spans WHERE run_id = run_records.id AND kind = 'model_call') AS model_tokens, (SELECT SUM(estimated_cost_microusd) FROM run_spans WHERE run_id = run_records.id AND kind = 'model_call') AS model_estimated_cost_microusd";

impl RunHistoryStore {
    pub async fn list(query: RunHistoryQuery) -> Result<RunHistoryPage> {
        let pool = DBManager::global().pool()?;
        let page_size = query.page_size.unwrap_or(30).clamp(1, 100);
        if let Some(cursor) = &query.cursor
            && (cursor.id.trim().is_empty() || cursor.started_at.trim().is_empty())
        {
            bail!("run history cursor requires an id and started_at");
        }
        let mut sql = QueryBuilder::<Sqlite>::new("SELECT ");
        sql.push(RUN_RECORD_SUMMARY_COLUMNS)
            // Evaluation runs retain a normal run record for trace inspection,
            // but are not production history or runtime-health evidence.
            .push(" FROM run_records WHERE json_extract(runtime_json, '$.evaluationProfile') IS NULL")
            .push(" AND workspace_id = ")
            .push_bind(crate::utils::dirs::active_workspace_id());

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
            .push(" FROM run_records WHERE status IN ('queued', 'running', 'waiting_for_input') AND json_extract(runtime_json, '$.evaluationProfile') IS NULL AND workspace_id = ")
            .push_bind(crate::utils::dirs::active_workspace_id())
            .push(" ORDER BY started_at DESC, id DESC")
            .build()
            .fetch_all(&pool)
            .await?;
        rows.iter().map(summary_from_row).collect()
    }

    pub async fn list_timeline(query: RunHistoryTimelineQuery) -> Result<RunHistoryTimelinePage> {
        let pool = DBManager::global().pool()?;
        list_timeline_from_pool(&pool, query).await
    }

    // Native workers may finish after the UI switches workspaces. The IPC
    // boundary checks ownership; internal reads retain access to their run.
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
        let spans = sqlx::query(
            "SELECT id, run_id, parent_span_id, kind, status, node_id, node_name, provider, model, tool_name, started_at, ended_at, duration_ms, input_tokens, output_tokens, total_tokens, total_tokens_estimated, cache_read_tokens, cache_write_tokens, reasoning_tokens, audio_input_tokens, audio_output_tokens, estimated_cost_microusd, is_byok, error_code, error_message, attributes_json FROM run_spans WHERE run_id = ? ORDER BY started_at ASC, id ASC",
        )
        .bind(id)
        .fetch_all(&pool)
        .await?
        .iter()
        .map(run_span_from_row)
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
            spans,
            execution_history: super::recovery::inspect_history(&pool, id).await?,
        })
    }
}

async fn list_timeline_from_pool(
    pool: &sqlx::SqlitePool,
    query: RunHistoryTimelineQuery,
) -> Result<RunHistoryTimelinePage> {
    list_timeline_for_workspace(pool, query, &crate::utils::dirs::active_workspace_id()).await
}

async fn list_timeline_for_workspace(
    pool: &sqlx::SqlitePool,
    query: RunHistoryTimelineQuery,
    workspace_id: &str,
) -> Result<RunHistoryTimelinePage> {
    let page_size = query.page_size.unwrap_or(30).clamp(1, 100);
    if let Some(cursor) = &query.cursor
        && (cursor.id.trim().is_empty() || cursor.kind.trim().is_empty() || cursor.activity_at.trim().is_empty())
    {
        bail!("run history timeline cursor requires id, kind, and activity_at");
    }

    // Keep this union in SQLite so filtering and paging apply to one stable
    // sequence. Pulling all chat sessions into the UI first made page
    // boundaries and cross-mode ordering depend on loaded client state.
    let mut sql = QueryBuilder::<Sqlite>::new(
        "WITH timeline AS (\
             SELECT rr.workspace_id, 'task' AS kind, rr.id, rr.target_type, rr.target_id, rr.target_name, rr.status, rr.started_at AS activity_at, rr.ended_at, rr.duration_ms, rr.error, json_extract(rr.runtime_json, '$.releaseVersion') AS release_version, NULL AS turn_count, NULL AS latest_message \
             FROM run_records rr \
             WHERE json_extract(rr.runtime_json, '$.evaluationProfile') IS NULL \
               AND NOT EXISTS (SELECT 1 FROM chat_turns ct WHERE ct.run_id = rr.id) \
             UNION ALL \
             SELECT cs.workspace_id, 'chat' AS kind, cs.id, 'workflow' AS target_type, cs.workflow_id AS target_id, \
               COALESCE((SELECT rr.target_name FROM chat_turns ct JOIN run_records rr ON rr.id = ct.run_id WHERE ct.session_id = cs.id ORDER BY ct.sequence DESC LIMIT 1), 'Workflow') AS target_name, \
               (SELECT ct.status FROM chat_turns ct WHERE ct.session_id = cs.id ORDER BY ct.sequence DESC LIMIT 1) AS status, \
               COALESCE((SELECT COALESCE(ct.completed_at, ct.created_at) FROM chat_turns ct WHERE ct.session_id = cs.id ORDER BY ct.sequence DESC LIMIT 1), cs.created_at) AS activity_at, \
               NULL AS ended_at, NULL AS duration_ms, NULL AS error, NULL AS release_version, \
               (SELECT COUNT(*) FROM chat_turns ct WHERE ct.session_id = cs.id) AS turn_count, \
               (SELECT ct.user_message FROM chat_turns ct WHERE ct.session_id = cs.id ORDER BY ct.sequence DESC LIMIT 1) AS latest_message \
             FROM chat_sessions cs \
             WHERE EXISTS (SELECT 1 FROM chat_turns ct WHERE ct.session_id = cs.id)\
             ), filtered AS (\
             SELECT kind, id, target_type, target_id, target_name, status, activity_at, ended_at, duration_ms, error, release_version, turn_count, latest_message FROM timeline WHERE workspace_id = ",
    );
    sql.push_bind(workspace_id);
    if let Some(target_type) = query.target_type {
        sql.push(" AND target_type = ").push_bind(target_type.as_str());
    }
    if let Some(target_id) = query.target_id {
        sql.push(" AND target_id = ").push_bind(target_id);
    }
    if let Some(status) = query.status {
        sql.push(" AND status = ").push_bind(status.as_str());
    }
    if let Some(mode) = query.mode {
        sql.push(" AND kind = ").push_bind(mode.as_str());
    }
    if let Some(name_query) = query.query.filter(|value| !value.trim().is_empty()) {
        let like = format!("%{}%", name_query.trim());
        sql.push(" AND (target_name LIKE ")
            .push_bind(like.clone())
            .push(" OR latest_message LIKE ")
            .push_bind(like)
            .push(")");
    }
    sql.push(") , ranked AS (SELECT filtered.*, COUNT(*) OVER () AS total_count, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) OVER () AS completed_count FROM filtered) SELECT * FROM ranked WHERE 1 = 1");
    if let Some(cursor) = query.cursor {
        sql.push(" AND (activity_at < ")
            .push_bind(&cursor.activity_at)
            .push(" OR (activity_at = ")
            .push_bind(&cursor.activity_at)
            .push(" AND (kind < ")
            .push_bind(&cursor.kind)
            .push(" OR (kind = ")
            .push_bind(cursor.kind)
            .push(" AND id < ")
            .push_bind(cursor.id)
            .push("))))");
    }
    sql.push(" ORDER BY activity_at DESC, kind DESC, id DESC LIMIT ")
        .push_bind(page_size + 1);
    let rows = sql.build().fetch_all(pool).await?;
    let summary: Result<Option<(i64, i64)>> = rows
        .first()
        .map(|row| Ok((row.try_get("total_count")?, row.try_get("completed_count")?)))
        .transpose();
    let (total_count, completed_count) = summary?.unwrap_or((0, 0));
    let mut items = rows.iter().map(timeline_item_from_row).collect::<Result<Vec<_>>>()?;
    let next_cursor = if items.len() > page_size as usize {
        items.pop();
        items.last().map(|item| RunHistoryTimelineCursor {
            id: item.id.clone(),
            kind: item.kind.clone(),
            activity_at: item.activity_at.clone(),
        })
    } else {
        None
    };
    Ok(RunHistoryTimelinePage {
        items,
        next_cursor,
        total_count,
        completed_count,
    })
}

impl RunHistoryStore {
    pub async fn observability(query: RunObservabilityQuery) -> Result<RunObservability> {
        if query.workflow_id.trim().is_empty() {
            bail!("workflow_id is required for observability");
        }
        if query.started_after.as_deref().is_some_and(str::is_empty)
            || query.started_before.as_deref().is_some_and(str::is_empty)
            || query.release_version.as_deref().is_some_and(str::is_empty)
        {
            bail!("observability timestamps cannot be empty");
        }
        let pool = DBManager::global().pool()?;
        let run_rows = observability_run_rows(&pool, &query).await?;
        let span_rows = observability_span_rows(&pool, &query).await?;
        Ok(aggregate_observability(run_rows, span_rows))
    }
}

async fn observability_run_rows(
    pool: &sqlx::SqlitePool,
    query: &RunObservabilityQuery,
) -> Result<Vec<sqlx::sqlite::SqliteRow>> {
    let mut sql = QueryBuilder::<Sqlite>::new(
        "SELECT status, duration_ms, json_extract(runtime_json, '$.releaseVersion') AS release_version FROM run_records WHERE target_type = 'workflow' AND target_id = ",
    );
    sql.push_bind(&query.workflow_id)
        .push(" AND status IN ('completed', 'failed', 'cancelled', 'interrupted') AND json_extract(runtime_json, '$.evaluationProfile') IS NULL");
    sql.push(" AND run_records.workspace_id = ")
        .push_bind(crate::utils::dirs::active_workspace_id());
    append_observability_version_filter(&mut sql, query);
    append_observability_time_filter(&mut sql, query);
    Ok(sql.build().fetch_all(pool).await?)
}

async fn observability_span_rows(
    pool: &sqlx::SqlitePool,
    query: &RunObservabilityQuery,
) -> Result<Vec<sqlx::sqlite::SqliteRow>> {
    let mut sql = QueryBuilder::<Sqlite>::new(
        "SELECT run_spans.kind, run_spans.status, run_spans.node_id, run_spans.provider, run_spans.model, run_spans.tool_name, run_spans.duration_ms, run_spans.input_tokens, run_spans.output_tokens, run_spans.total_tokens, run_spans.cache_read_tokens, run_spans.estimated_cost_microusd, json_extract(run_records.runtime_json, '$.releaseVersion') AS release_version FROM run_spans JOIN run_records ON run_records.id = run_spans.run_id WHERE run_records.target_type = 'workflow' AND run_records.target_id = ",
    );
    sql.push_bind(&query.workflow_id)
        .push(" AND run_records.status IN ('completed', 'failed', 'cancelled', 'interrupted') AND json_extract(run_records.runtime_json, '$.evaluationProfile') IS NULL");
    sql.push(" AND run_records.workspace_id = ")
        .push_bind(crate::utils::dirs::active_workspace_id());
    append_observability_version_filter(&mut sql, query);
    append_observability_time_filter(&mut sql, query);
    Ok(sql.build().fetch_all(pool).await?)
}

fn append_observability_version_filter(sql: &mut QueryBuilder<Sqlite>, query: &RunObservabilityQuery) {
    if let Some(release_version) = &query.release_version {
        sql.push(" AND json_extract(run_records.runtime_json, '$.releaseVersion') = ")
            .push_bind(release_version);
    }
}

fn append_observability_time_filter(sql: &mut QueryBuilder<Sqlite>, query: &RunObservabilityQuery) {
    if let Some(started_after) = &query.started_after {
        sql.push(" AND run_records.started_at >= ").push_bind(started_after);
    }
    if let Some(started_before) = &query.started_before {
        sql.push(" AND run_records.started_at < ").push_bind(started_before);
    }
}

fn aggregate_observability(
    run_rows: Vec<sqlx::sqlite::SqliteRow>,
    span_rows: Vec<sqlx::sqlite::SqliteRow>,
) -> RunObservability {
    let mut overall = MetricAccumulator::default();
    let mut versions = BTreeMap::<String, MetricAccumulator>::new();
    for row in run_rows {
        let version = release_version(&row);
        let status = row.try_get::<String, _>("status").unwrap_or_default();
        let duration_ms = row.try_get("duration_ms").ok();
        overall.add(&status, duration_ms);
        versions.entry(version).or_default().add(&status, duration_ms);
    }

    let mut spans = BTreeMap::<SpanMetricKey, MetricAccumulator>::new();
    for row in span_rows {
        let version = release_version(&row);
        let usage = SpanUsage::from_row(&row);
        overall.add_usage(&usage);
        versions.entry(version).or_default().add_usage(&usage);
        let key = SpanMetricKey::from_row(&row);
        let status = row.try_get::<String, _>("status").unwrap_or_default();
        let duration_ms = row.try_get("duration_ms").ok();
        spans
            .entry(key)
            .or_default()
            .add_with_usage(&status, duration_ms, &usage);
    }

    RunObservability {
        overall: overall.finish(),
        versions: versions
            .into_iter()
            .map(|(release_version, metrics)| VersionMetricSummary {
                release_version,
                metrics: metrics.finish(),
            })
            .collect(),
        spans: spans
            .into_iter()
            .map(|(key, metrics)| SpanMetricSummary {
                kind: key.kind,
                node_id: key.node_id,
                provider: key.provider,
                model: key.model,
                tool_name: key.tool_name,
                metrics: metrics.finish(),
            })
            .collect(),
    }
}

fn release_version(row: &sqlx::sqlite::SqliteRow) -> String {
    row.try_get::<Option<String>, _>("release_version")
        .ok()
        .flatten()
        .filter(|version| !version.is_empty())
        .unwrap_or_else(|| "draft".to_string())
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct SpanMetricKey {
    kind: String,
    node_id: Option<String>,
    provider: Option<String>,
    model: Option<String>,
    tool_name: Option<String>,
}

impl SpanMetricKey {
    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Self {
        Self {
            kind: row.try_get("kind").unwrap_or_default(),
            node_id: row.try_get::<Option<String>, _>("node_id").ok().flatten(),
            provider: row.try_get::<Option<String>, _>("provider").ok().flatten(),
            model: row.try_get::<Option<String>, _>("model").ok().flatten(),
            tool_name: row.try_get::<Option<String>, _>("tool_name").ok().flatten(),
        }
    }
}

#[derive(Default)]
struct SpanUsage {
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    cache_read_tokens: i64,
    estimated_cost_microusd: i64,
}

impl SpanUsage {
    fn from_row(row: &sqlx::sqlite::SqliteRow) -> Self {
        Self {
            input_tokens: optional_i64(row, "input_tokens"),
            output_tokens: optional_i64(row, "output_tokens"),
            total_tokens: optional_i64(row, "total_tokens"),
            cache_read_tokens: optional_i64(row, "cache_read_tokens"),
            estimated_cost_microusd: optional_i64(row, "estimated_cost_microusd"),
        }
    }
}

fn optional_i64(row: &sqlx::sqlite::SqliteRow, column: &str) -> i64 {
    row.try_get::<Option<i64>, _>(column).ok().flatten().unwrap_or_default()
}

#[derive(Default)]
struct MetricAccumulator {
    count: i64,
    completed_count: i64,
    failed_count: i64,
    cancelled_count: i64,
    durations: Vec<i64>,
    usage: SpanUsage,
}

impl MetricAccumulator {
    fn add(&mut self, status: &str, duration_ms: Option<i64>) {
        self.count += 1;
        match status {
            "completed" => self.completed_count += 1,
            "failed" => self.failed_count += 1,
            "cancelled" | "interrupted" => self.cancelled_count += 1,
            _ => {},
        }
        if let Some(duration_ms) = duration_ms.filter(|duration| *duration >= 0) {
            self.durations.push(duration_ms);
        }
    }

    fn add_usage(&mut self, usage: &SpanUsage) {
        self.usage.input_tokens = self.usage.input_tokens.saturating_add(usage.input_tokens);
        self.usage.output_tokens = self.usage.output_tokens.saturating_add(usage.output_tokens);
        self.usage.total_tokens = self.usage.total_tokens.saturating_add(usage.total_tokens);
        self.usage.cache_read_tokens = self.usage.cache_read_tokens.saturating_add(usage.cache_read_tokens);
        self.usage.estimated_cost_microusd = self
            .usage
            .estimated_cost_microusd
            .saturating_add(usage.estimated_cost_microusd);
    }

    fn add_with_usage(&mut self, status: &str, duration_ms: Option<i64>, usage: &SpanUsage) {
        self.add(status, duration_ms);
        self.add_usage(usage);
    }

    fn finish(mut self) -> MetricSummary {
        self.durations.sort_unstable();
        let denominator = self.completed_count + self.failed_count;
        let average_duration_ms = (!self.durations.is_empty())
            .then(|| self.durations.iter().sum::<i64>() / i64::try_from(self.durations.len()).unwrap_or(1));
        MetricSummary {
            count: self.count,
            completed_count: self.completed_count,
            failed_count: self.failed_count,
            cancelled_count: self.cancelled_count,
            success_rate: (denominator > 0).then(|| self.completed_count as f64 / denominator as f64),
            average_duration_ms,
            p50_duration_ms: percentile(&self.durations, 50),
            p95_duration_ms: percentile(&self.durations, 95),
            input_tokens: self.usage.input_tokens,
            output_tokens: self.usage.output_tokens,
            total_tokens: self.usage.total_tokens,
            cache_read_tokens: self.usage.cache_read_tokens,
            estimated_cost_microusd: self.usage.estimated_cost_microusd,
        }
    }
}

fn percentile(values: &[i64], percentile: usize) -> Option<i64> {
    if values.is_empty() {
        return None;
    }
    // Nearest-rank is deterministic and does not depend on a SQLite extension.
    let rank = (values.len() * percentile).div_ceil(100).max(1);
    values.get(rank - 1).copied()
}

fn run_span_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<RunSpan> {
    Ok(RunSpan {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        parent_span_id: row.try_get("parent_span_id")?,
        kind: row.try_get("kind")?,
        status: row.try_get("status")?,
        node_id: row.try_get("node_id")?,
        node_name: row.try_get("node_name")?,
        provider: row.try_get("provider")?,
        model: row.try_get("model")?,
        tool_name: row.try_get("tool_name")?,
        started_at: row.try_get("started_at")?,
        ended_at: row.try_get("ended_at")?,
        duration_ms: row.try_get("duration_ms")?,
        input_tokens: row.try_get("input_tokens")?,
        output_tokens: row.try_get("output_tokens")?,
        total_tokens: row.try_get("total_tokens")?,
        total_tokens_estimated: row.try_get("total_tokens_estimated")?,
        cache_read_tokens: row.try_get("cache_read_tokens")?,
        cache_write_tokens: row.try_get("cache_write_tokens")?,
        reasoning_tokens: row.try_get("reasoning_tokens")?,
        audio_input_tokens: row.try_get("audio_input_tokens")?,
        audio_output_tokens: row.try_get("audio_output_tokens")?,
        estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
        is_byok: row.try_get("is_byok")?,
        error_code: row.try_get("error_code")?,
        error_message: row.try_get("error_message")?,
        attributes: json_column(row.try_get("attributes_json")?)?,
    })
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
        app_version: row.try_get("app_version")?,
        model_tokens: row.try_get("model_tokens")?,
        model_estimated_cost_microusd: row.try_get("model_estimated_cost_microusd")?,
    })
}

fn timeline_item_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<RunHistoryTimelineItem> {
    let target_type = match row.try_get::<String, _>("target_type")?.as_str() {
        "workflow" => RunTargetType::Workflow,
        "app" => RunTargetType::App,
        value => bail!("stored run history contains unknown target type: {value}"),
    };
    let status = match row.try_get::<String, _>("status")?.as_str() {
        "queued" => RunStatus::Queued,
        "running" => RunStatus::Running,
        "waiting_for_input" => RunStatus::WaitingForInput,
        "completed" => RunStatus::Completed,
        "failed" => RunStatus::Failed,
        "cancelled" => RunStatus::Cancelled,
        "interrupted" => RunStatus::Interrupted,
        value => bail!("stored run history contains unknown status: {value}"),
    };
    Ok(RunHistoryTimelineItem {
        kind: row.try_get("kind")?,
        id: row.try_get("id")?,
        target_type,
        target_id: row.try_get("target_id")?,
        target_name: row.try_get("target_name")?,
        status,
        activity_at: row.try_get("activity_at")?,
        ended_at: row.try_get("ended_at")?,
        duration_ms: row.try_get("duration_ms")?,
        error: row.try_get("error")?,
        release_version: row.try_get("release_version")?,
        turn_count: row.try_get("turn_count")?,
        latest_message: row.try_get("latest_message")?,
    })
}

fn json_column(value: String) -> Result<Value> {
    serde_json::from_str(&value).context("stored run history contains invalid JSON")
}

#[cfg(test)]
mod tests {
    use super::{
        MetricAccumulator, RUN_RECORD_SUMMARY_COLUMNS, RunObservabilityQuery, SpanUsage, aggregate_observability,
        list_timeline_from_pool, observability_run_rows, observability_span_rows, summary_from_row,
    };
    use crate::module::run_history::{RunHistoryMode, RunHistoryTimelineQuery, RunStatus, RunTargetType};
    use sqlx::{QueryBuilder, Sqlite, sqlite::SqlitePoolOptions};

    #[tokio::test]
    async fn summary_projection_includes_release_and_app_versions() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let mut sql = QueryBuilder::<Sqlite>::new("");
        let row = sql
            .push("WITH run_spans(run_id, kind, total_tokens, input_tokens, output_tokens, estimated_cost_microusd) AS (VALUES ('run-1', 'model_call', NULL, 12, 8, 123), ('run-1', 'tool_call', 99, NULL, NULL, 999)) SELECT ")
            .push(RUN_RECORD_SUMMARY_COLUMNS)
            .push(" FROM (SELECT 'run-1' AS id, 'app' AS target_type, 'app-1' AS target_id, 'App' AS target_name, 'running' AS status, '2026-09-11T00:00:00Z' AS started_at, NULL AS ended_at, NULL AS duration_ms, NULL AS error, '{\"releaseId\":\"release-1\",\"releaseVersion\":\"1.2.3\"}' AS runtime_json, '{\"version\":\"2.0.0\"}' AS target_snapshot_json) AS run_records")
            .build()
            .fetch_one(&pool)
            .await
            .unwrap();

        let summary = summary_from_row(&row).unwrap();
        assert_eq!(summary.release_id.as_deref(), Some("release-1"));
        assert_eq!(summary.release_version.as_deref(), Some("1.2.3"));
        assert_eq!(summary.app_version.as_deref(), Some("2.0.0"));
        assert_eq!(summary.model_tokens, Some(20));
        assert_eq!(summary.model_estimated_cost_microusd, Some(123));
    }

    #[test]
    fn metrics_use_terminal_success_rate_and_nearest_rank_percentiles() {
        let mut metrics = MetricAccumulator::default();
        metrics.add("completed", Some(10));
        metrics.add("failed", Some(20));
        metrics.add("completed", Some(100));
        metrics.add("cancelled", Some(1_000));
        metrics.add_usage(&SpanUsage {
            input_tokens: 12,
            output_tokens: 8,
            total_tokens: 20,
            cache_read_tokens: 3,
            estimated_cost_microusd: 42,
        });

        let summary = metrics.finish();
        assert_eq!(summary.count, 4);
        assert_eq!(summary.success_rate, Some(2.0 / 3.0));
        assert_eq!(summary.average_duration_ms, Some(282));
        assert_eq!(summary.p50_duration_ms, Some(20));
        assert_eq!(summary.p95_duration_ms, Some(1_000));
        assert_eq!(summary.total_tokens, 20);
        assert_eq!(summary.estimated_cost_microusd, 42);
    }

    #[tokio::test]
    async fn aggregates_only_terminal_runs_for_the_requested_workflow() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (workspace_id TEXT NOT NULL DEFAULT 'personal', id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, status TEXT, duration_ms INTEGER, runtime_json TEXT, started_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_spans (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, status TEXT, node_id TEXT, provider TEXT, model TEXT, tool_name TEXT, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, total_tokens INTEGER, cache_read_tokens INTEGER, estimated_cost_microusd INTEGER)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_records (id, target_type, target_id, status, duration_ms, runtime_json, started_at) VALUES ('completed', 'workflow', 'workflow-1', 'completed', 100, '{\"releaseVersion\":\"1.0.0\"}', '2026-09-01T00:00:00Z'), ('failed', 'workflow', 'workflow-1', 'failed', 200, '{\"releaseVersion\":\"1.0.0\"}', '2026-09-02T00:00:00Z'), ('running', 'workflow', 'workflow-1', 'running', NULL, '{}', '2026-09-03T00:00:00Z'), ('other', 'workflow', 'workflow-2', 'completed', 50, '{}', '2026-09-01T00:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO run_spans VALUES ('span-1', 'completed', 'model_call', 'completed', 'agent-1', 'openai', 'gpt-5', NULL, NULL, 10, 5, 15, 2, 25), ('span-2', 'failed', 'tool_call', 'failed', 'agent-1', NULL, NULL, 'search', 40, NULL, NULL, NULL, NULL, NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query("INSERT INTO run_records (workspace_id, id, target_type, target_id, status, duration_ms, runtime_json, started_at) VALUES ('team:default', 'team-completed', 'workflow', 'workflow-1', 'completed', 999, '{\"releaseVersion\":\"1.0.0\"}', '2026-09-01T00:00:00Z')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO run_spans (id, run_id, kind, status, total_tokens) VALUES ('team-span', 'team-completed', 'model_call', 'completed', 999)").execute(&pool).await.unwrap();

        let query = RunObservabilityQuery {
            workflow_id: "workflow-1".into(),
            release_version: None,
            started_after: None,
            started_before: None,
        };
        let summary = aggregate_observability(
            observability_run_rows(&pool, &query).await.unwrap(),
            observability_span_rows(&pool, &query).await.unwrap(),
        );

        assert_eq!(summary.overall.count, 2);
        assert_eq!(summary.overall.success_rate, Some(0.5));
        assert_eq!(summary.overall.total_tokens, 15);
        assert_eq!(summary.versions[0].release_version, "1.0.0");
        assert_eq!(summary.spans.len(), 2);

        let no_match = RunObservabilityQuery {
            release_version: Some("2.0.0".into()),
            ..query
        };
        let summary = aggregate_observability(
            observability_run_rows(&pool, &no_match).await.unwrap(),
            observability_span_rows(&pool, &no_match).await.unwrap(),
        );
        assert_eq!(summary.overall.count, 0);
        assert!(summary.spans.is_empty());
    }

    async fn timeline_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (workspace_id TEXT NOT NULL DEFAULT 'personal', id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, target_name TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, runtime_json TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE chat_sessions (workspace_id TEXT NOT NULL DEFAULT 'personal', id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, created_at TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE chat_turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, sequence INTEGER NOT NULL, user_message TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO run_records (id, target_type, target_id, target_name, status, started_at, ended_at, duration_ms, error, runtime_json) VALUES
             ('task-latest', 'workflow', 'workflow-1', 'Standalone task', 'completed', '2026-09-30T05:00:00Z', NULL, 100, NULL, '{}'),
             ('task-old', 'app', 'app-1', 'Old app task', 'failed', '2026-09-30T01:00:00Z', NULL, 200, 'failed', '{}'),
             ('chat-a-1', 'workflow', 'workflow-1', 'Chat workflow', 'completed', '2026-09-30T02:00:00Z', NULL, 100, NULL, '{}'),
             ('chat-a-2', 'workflow', 'workflow-1', 'Chat workflow', 'completed', '2026-09-30T06:00:00Z', NULL, 100, NULL, '{}'),
             ('chat-b-1', 'workflow', 'workflow-2', 'Other chat workflow', 'failed', '2026-09-30T04:00:00Z', NULL, 100, 'failed', '{}')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chat_sessions (id, workflow_id, created_at) VALUES
             ('chat-a', 'workflow-1', '2026-09-30T02:00:00Z'),
             ('chat-b', 'workflow-2', '2026-09-30T04:00:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO chat_turns VALUES
             ('turn-a-1', 'chat-a', 'chat-a-1', 0, 'first chat prompt', 'completed', '2026-09-30T02:00:00Z', '2026-09-30T02:10:00Z'),
             ('turn-a-2', 'chat-a', 'chat-a-2', 1, 'latest chat prompt', 'completed', '2026-09-30T05:30:00Z', '2026-09-30T06:00:00Z'),
             ('turn-b-1', 'chat-b', 'chat-b-1', 0, 'failed chat prompt', 'failed', '2026-09-30T04:00:00Z', '2026-09-30T04:10:00Z')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO run_records (workspace_id, id, target_type, target_id, target_name, status, started_at, runtime_json) VALUES ('team:default', 'team-standalone', 'workflow', 'workflow-1', 'Team standalone', 'completed', '2026-10-08T00:00:00Z', '{}'), ('team:default', 'team-task', 'workflow', 'workflow-1', 'Team task', 'completed', '2026-10-09T00:00:00Z', '{}')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chat_sessions (workspace_id, id, workflow_id, created_at) VALUES ('team:default', 'team-chat', 'workflow-1', '2026-10-09T00:00:00Z')").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO chat_turns (id, session_id, run_id, sequence, user_message, status, created_at) VALUES ('team-turn', 'team-chat', 'team-task', 0, 'team private prompt', 'completed', '2026-10-09T00:00:00Z')").execute(&pool).await.unwrap();
        pool
    }

    #[tokio::test]
    async fn timeline_isolates_tasks_chats_and_counts_in_both_workspaces() {
        let pool = timeline_pool().await;
        let query = || RunHistoryTimelineQuery {
            target_type: None,
            target_id: None,
            status: None,
            query: None,
            mode: None,
            page_size: Some(30),
            cursor: None,
        };
        let personal = super::list_timeline_for_workspace(&pool, query(), "personal")
            .await
            .unwrap();
        let team = super::list_timeline_for_workspace(&pool, query(), "team:default")
            .await
            .unwrap();
        assert_eq!(personal.total_count, 4);
        assert!(personal.items.iter().all(|item| !item.id.starts_with("team-")));
        assert_eq!(team.total_count, 2);
        assert_eq!(team.completed_count, 2);
        assert_eq!(
            team.items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["team-chat", "team-standalone"]
        );
        assert_eq!(
            super::list_timeline_for_workspace(&pool, query(), "personal")
                .await
                .unwrap()
                .total_count,
            4
        );
    }

    #[tokio::test]
    async fn timeline_mixes_sessions_and_tasks_without_exposing_chat_turn_runs() {
        let pool = timeline_pool().await;
        let first_page = list_timeline_from_pool(
            &pool,
            RunHistoryTimelineQuery {
                target_type: None,
                target_id: None,
                status: None,
                query: None,
                mode: None,
                page_size: Some(2),
                cursor: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            first_page.items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(),
            ["chat-a", "task-latest"],
        );
        assert_eq!(first_page.items[0].turn_count, Some(2));
        assert_eq!(
            first_page.items[0].latest_message.as_deref(),
            Some("latest chat prompt")
        );
        assert_eq!(first_page.total_count, 4);
        assert_eq!(first_page.completed_count, 2);

        let second_page = list_timeline_from_pool(
            &pool,
            RunHistoryTimelineQuery {
                cursor: first_page.next_cursor,
                page_size: Some(2),
                target_type: None,
                target_id: None,
                status: None,
                query: None,
                mode: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            second_page
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["chat-b", "task-old"],
        );
        assert!(second_page.next_cursor.is_none());
        // Summary values cover the complete filtered timeline rather than
        // only this cursor page's remaining slice.
        assert_eq!(second_page.total_count, 4);
        assert_eq!(second_page.completed_count, 2);
    }

    #[tokio::test]
    async fn timeline_filters_chat_sessions_by_mode_target_status_and_message() {
        let pool = timeline_pool().await;
        let page = list_timeline_from_pool(
            &pool,
            RunHistoryTimelineQuery {
                target_type: Some(RunTargetType::Workflow),
                target_id: Some("workflow-1".into()),
                status: Some(RunStatus::Completed),
                query: Some("latest chat".into()),
                mode: Some(RunHistoryMode::Chat),
                page_size: None,
                cursor: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "chat-a");
        assert_eq!(page.items[0].kind, "chat");
    }
}
