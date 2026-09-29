//! Durable, local schedules for top-level executions.

use crate::{
    config::Config,
    core::db::DBManager,
    module::{
        run_manager::{self, ScheduleTrigger, StartAppRun, StartWorkflowRun},
        workflow::WorkflowDsl,
    },
    process::AsyncHandler,
};
use anyhow::{Context, Result, anyhow, bail};
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use croner::Cron;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;
use std::{
    str::FromStr as _,
    sync::{
        OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use uuid::Uuid;

const MAX_SCHEDULE_SLEEP: Duration = Duration::from_secs(60 * 60);
const SCHEDULE_ERROR_RETRY: Duration = Duration::from_secs(5);
static STARTED: AtomicBool = AtomicBool::new(false);
static SCHEDULE_CHANGES: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleTargetType {
    App,
    Workflow,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppScheduleRequest {
    pub id: Option<String>,
    pub name: String,
    pub target_id: String,
    pub target_name: String,
    pub target_snapshot: Value,
    pub cron_expression: String,
    pub timezone: String,
    pub enabled: bool,
    #[serde(default)]
    pub editor_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum WorkflowScheduleSource {
    /// Resolve from the local catalog at dispatch time so scheduled personal
    /// workflows follow the author's latest saved definition.
    LatestLocal,
    /// Team releases are immutable; retain all coordinates needed to replay
    /// the published definition without consulting a mutable draft.
    PublishedRelease {
        dsl: Value,
        release_id: String,
        release_version: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowScheduleRequest {
    pub id: Option<String>,
    pub name: String,
    pub target_id: String,
    pub target_name: String,
    pub target_snapshot: Value,
    pub cron_expression: String,
    pub timezone: String,
    pub enabled: bool,
    pub source: WorkflowScheduleSource,
    #[serde(default = "empty_json_object")]
    pub input: Value,
    #[serde(default = "empty_json_object")]
    pub initial_state: Value,
    #[serde(default)]
    pub editor_mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowExecutionRecipe {
    source: WorkflowScheduleSource,
    input: Value,
    initial_state: Value,
    editor_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSummary {
    pub id: String,
    pub name: String,
    pub target_type: ScheduleTargetType,
    pub target_id: String,
    pub target_name: String,
    pub cron_expression: String,
    pub timezone: String,
    pub enabled: bool,
    pub next_run_at: String,
    pub last_run_at: Option<String>,
    pub editor_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
}

#[derive(Debug)]
struct DueSchedule {
    summary: ScheduleSummary,
    target_snapshot: Value,
    execution_recipe: Value,
}

pub struct ScheduleStore;

impl ScheduleStore {
    pub async fn list_for_app(target_id: &str) -> Result<Vec<ScheduleSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, name, target_type, target_id, target_name, execution_recipe_json, cron_expression, timezone, enabled, next_run_at, last_run_at FROM schedules WHERE target_type = 'app' AND target_id = ? ORDER BY next_run_at ASC, id ASC")
            .bind(target_id)
            .fetch_all(&pool)
            .await?;
        rows.iter().map(schedule_summary).collect()
    }

    pub async fn list_for_workflow(target_id: &str) -> Result<Vec<ScheduleSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, name, target_type, target_id, target_name, execution_recipe_json, cron_expression, timezone, enabled, next_run_at, last_run_at FROM schedules WHERE target_type = 'workflow' AND target_id = ? ORDER BY next_run_at ASC, id ASC")
            .bind(target_id)
            .fetch_all(&pool)
            .await?;
        rows.iter().map(schedule_summary).collect()
    }

    pub async fn save_app(request: AppScheduleRequest) -> Result<ScheduleSummary> {
        validate_app_request(&request)?;
        let next_run_at = next_run(&request.cron_expression, &request.timezone, Utc::now())?;
        let now = Utc::now().to_rfc3339();
        let id = request.id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let pool = DBManager::global().pool()?;
        // Persist the chosen editor mode separately from Cron: `0 9 * * *` may be
        // either a deliberate custom expression or the Daily preset.
        let execution_recipe = json!({ "editorMode": request.editor_mode }).to_string();
        sqlx::query("INSERT INTO schedules (id, name, target_type, target_id, target_name, target_snapshot_json, execution_recipe_json, cron_expression, timezone, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, target_id = excluded.target_id, target_name = excluded.target_name, target_snapshot_json = excluded.target_snapshot_json, execution_recipe_json = excluded.execution_recipe_json, cron_expression = excluded.cron_expression, timezone = excluded.timezone, enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at")
            .bind(&id)
            .bind(&request.name)
            .bind(&request.target_id)
            .bind(&request.target_name)
            .bind(request.target_snapshot.to_string())
            .bind(execution_recipe)
            .bind(&request.cron_expression)
            .bind(&request.timezone)
            .bind(request.enabled)
            .bind(next_run_at.to_rfc3339())
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await?;
        notify_scheduler();
        Ok(ScheduleSummary {
            id,
            name: request.name,
            target_type: ScheduleTargetType::App,
            target_id: request.target_id,
            target_name: request.target_name,
            cron_expression: request.cron_expression,
            timezone: request.timezone,
            enabled: request.enabled,
            next_run_at: next_run_at.to_rfc3339(),
            last_run_at: None,
            editor_mode: request.editor_mode,
            input: None,
        })
    }

    pub async fn save_workflow(request: WorkflowScheduleRequest) -> Result<ScheduleSummary> {
        validate_workflow_request(&request)?;
        let next_run_at = next_run(&request.cron_expression, &request.timezone, Utc::now())?;
        let now = Utc::now().to_rfc3339();
        let id = request.id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
        let recipe = WorkflowExecutionRecipe {
            source: request.source,
            input: request.input,
            initial_state: request.initial_state,
            editor_mode: request.editor_mode.clone(),
        };
        let pool = DBManager::global().pool()?;
        sqlx::query("INSERT INTO schedules (id, name, target_type, target_id, target_name, target_snapshot_json, execution_recipe_json, cron_expression, timezone, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, 'workflow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, target_id = excluded.target_id, target_name = excluded.target_name, target_snapshot_json = excluded.target_snapshot_json, execution_recipe_json = excluded.execution_recipe_json, cron_expression = excluded.cron_expression, timezone = excluded.timezone, enabled = excluded.enabled, next_run_at = excluded.next_run_at, last_error = NULL, updated_at = excluded.updated_at")
            .bind(&id).bind(&request.name).bind(&request.target_id).bind(&request.target_name)
            .bind(request.target_snapshot.to_string()).bind(serde_json::to_string(&recipe)?)
            .bind(&request.cron_expression).bind(&request.timezone).bind(request.enabled)
            .bind(next_run_at.to_rfc3339()).bind(&now).bind(&now).execute(&pool).await?;
        notify_scheduler();
        Ok(ScheduleSummary {
            id,
            name: request.name,
            target_type: ScheduleTargetType::Workflow,
            target_id: request.target_id,
            target_name: request.target_name,
            cron_expression: request.cron_expression,
            timezone: request.timezone,
            enabled: request.enabled,
            next_run_at: next_run_at.to_rfc3339(),
            last_run_at: None,
            editor_mode: request.editor_mode,
            input: Some(recipe.input),
        })
    }

    pub async fn delete(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        sqlx::query("DELETE FROM schedules WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await?;
        notify_scheduler();
        Ok(())
    }

    pub async fn set_enabled(id: &str, enabled: bool) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let next_run_at = if enabled {
            let row = sqlx::query("SELECT cron_expression, timezone FROM schedules WHERE id = ?")
                .bind(id)
                .fetch_optional(&pool)
                .await?
                .ok_or_else(|| anyhow!("schedule was not found"))?;
            let expression: String = row.try_get("cron_expression")?;
            let timezone: String = row.try_get("timezone")?;
            // Resuming starts from now. A paused desktop app should never run a
            // backlog of periods the person explicitly chose not to execute.
            Some(next_run(&expression, &timezone, Utc::now())?.to_rfc3339())
        } else {
            None
        };
        sqlx::query(
            "UPDATE schedules SET enabled = ?, next_run_at = COALESCE(?, next_run_at), updated_at = ? WHERE id = ?",
        )
        .bind(enabled)
        .bind(next_run_at)
        .bind(Utc::now().to_rfc3339())
        .bind(id)
        .execute(&pool)
        .await?;
        notify_scheduler();
        Ok(())
    }
}

/// Starts after database recovery and the RunSupervisor. A schedule only enqueues
/// a normal App Run, so cancellation, limits, and history remain centralized.
pub fn start_scheduler() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let (sender, changes) = tokio::sync::watch::channel(0_u64);
    // Store mutations can occur while the scheduler sleeps until a distant run.
    // A watch channel retains the latest version, so that wake-up cannot be lost.
    let _ = SCHEDULE_CHANGES.set(sender);
    AsyncHandler::spawn(move || async move {
        if let Err(error) = skip_missed_schedules().await {
            log::error!("failed to skip missed scheduled runs during startup: {error:#}");
        }
        run_scheduler(changes).await;
    });
}

fn notify_scheduler() {
    if let Some(sender) = SCHEDULE_CHANGES.get() {
        sender.send_modify(|version| *version = version.wrapping_add(1));
    }
}

async fn run_scheduler(mut changes: tokio::sync::watch::Receiver<u64>) {
    loop {
        if let Err(error) = trigger_due_schedules().await {
            log::error!("failed to process scheduled runs: {error:#}");
            if !wait_for_change_or_timeout(&mut changes, SCHEDULE_ERROR_RETRY).await {
                return;
            }
            continue;
        }

        let next_run_at = match next_enabled_run_at().await {
            Ok(next_run_at) => next_run_at,
            Err(error) => {
                log::error!("failed to find the next scheduled run: {error:#}");
                if !wait_for_change_or_timeout(&mut changes, SCHEDULE_ERROR_RETRY).await {
                    return;
                }
                continue;
            },
        };

        match next_run_at {
            Some(next_run_at) => {
                // Tokio timers use a monotonic clock. Rechecking hourly also bounds
                // the effect of a user changing the wall clock while the app sleeps.
                let wait = next_run_at
                    .signed_duration_since(Utc::now())
                    .to_std()
                    .unwrap_or(Duration::ZERO)
                    .min(MAX_SCHEDULE_SLEEP);
                if !wait_for_change_or_timeout(&mut changes, wait).await {
                    return;
                }
            },
            None => {
                // No enabled schedules means no database polling until a write wakes us.
                if changes.changed().await.is_err() {
                    return;
                }
            },
        }
    }
}

async fn wait_for_change_or_timeout(changes: &mut tokio::sync::watch::Receiver<u64>, timeout: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(timeout) => true,
        changed = changes.changed() => changed.is_ok(),
    }
}

async fn next_enabled_run_at() -> Result<Option<DateTime<Utc>>> {
    let pool = DBManager::global().pool()?;
    let next_run_at: Option<String> = sqlx::query_scalar(
        "SELECT next_run_at FROM schedules WHERE enabled = 1 ORDER BY next_run_at ASC, id ASC LIMIT 1",
    )
    .fetch_optional(&pool)
    .await?;
    next_run_at.map(|value| parse_time(&value)).transpose()
}

async fn skip_missed_schedules() -> Result<()> {
    let pool = DBManager::global().pool()?;
    let now = Utc::now();
    let rows = sqlx::query(
        "SELECT id, cron_expression, timezone, next_run_at FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
    )
    .bind(now.to_rfc3339())
    .fetch_all(&pool)
    .await?;

    for row in rows {
        let id: String = row.try_get("id")?;
        let expression: String = row.try_get("cron_expression")?;
        let timezone: String = row.try_get("timezone")?;
        let scheduled_for: String = row.try_get("next_run_at")?;
        let next_run_at = next_run(&expression, &timezone, now)?;

        // Do not turn desktop downtime into a burst of delayed App or Workflow runs.
        // The conditional update preserves a schedule edited while startup was in flight.
        sqlx::query(
            "UPDATE schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?",
        )
        .bind(next_run_at.to_rfc3339())
        .bind(now.to_rfc3339())
        .bind(id)
        .bind(scheduled_for)
        .execute(&pool)
        .await?;
    }
    Ok(())
}

async fn trigger_due_schedules() -> Result<()> {
    let pool = DBManager::global().pool()?;
    let rows = sqlx::query("SELECT id, name, target_type, target_id, target_name, target_snapshot_json, execution_recipe_json, cron_expression, timezone, enabled, next_run_at, last_run_at FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC")
        .bind(Utc::now().to_rfc3339()).fetch_all(&pool).await?;
    for row in rows {
        let due = DueSchedule {
            summary: schedule_summary(&row)?,
            target_snapshot: serde_json::from_str(row.try_get::<&str, _>("target_snapshot_json")?)
                .context("scheduled target snapshot is invalid")?,
            execution_recipe: serde_json::from_str(row.try_get::<&str, _>("execution_recipe_json")?)
                .context("scheduled execution recipe is invalid")?,
        };
        trigger_due_schedule(&pool, due).await?;
    }
    Ok(())
}

async fn trigger_due_schedule(pool: &sqlx::SqlitePool, due: DueSchedule) -> Result<()> {
    let scheduled_for = due.summary.next_run_at.clone();
    let next = next_run(
        &due.summary.cron_expression,
        &due.summary.timezone,
        parse_time(&scheduled_for)?,
    )?;
    // Advance before enqueueing. Restart recovery intentionally skips missed
    // occurrences, rather than surprising users with a burst of delayed Apps.
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let changed = sqlx::query("UPDATE schedules SET next_run_at = ?, last_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?")
        .bind(next.to_rfc3339()).bind(&scheduled_for).bind(Utc::now().to_rfc3339()).bind(&due.summary.id).bind(&scheduled_for)
        .execute(&mut *tx).await?;
    if changed.rows_affected() == 0 {
        tx.commit().await?;
        return Ok(());
    }
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE target_type = ? AND target_id = ? AND status IN ('queued', 'running', 'waiting_for_input'))")
        .bind(match due.summary.target_type { ScheduleTargetType::App => "app", ScheduleTargetType::Workflow => "workflow" })
        .bind(&due.summary.target_id).fetch_one(&mut *tx).await?;
    let occurrence_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT OR IGNORE INTO schedule_occurrences (id, schedule_id, scheduled_for, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&occurrence_id).bind(&due.summary.id).bind(&scheduled_for)
        .bind(if active { "skipped" } else { "queued" })
        .bind(active.then_some("A run for this target was already queued, running, or waiting for input."))
        .bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    if active {
        return Ok(());
    }
    let run_id = Uuid::new_v4().to_string();
    let trigger = ScheduleTrigger {
        schedule_id: due.summary.id.clone(),
        scheduled_for,
    };
    match due.summary.target_type {
        ScheduleTargetType::App => {
            run_manager::start_app(StartAppRun {
                run_id: run_id.clone(),
                target_id: due.summary.target_id,
                target_name: due.summary.target_name,
                output_view: json!({"isRunning": true, "node": due.target_snapshot}),
                target_snapshot: due.target_snapshot,
                schedule_trigger: Some(trigger),
            })
            .await?
        },
        ScheduleTargetType::Workflow => {
            let recipe: WorkflowExecutionRecipe = serde_json::from_value(due.execution_recipe)?;
            let resolved = async {
                let resolved =
                    resolve_workflow_recipe(&due.summary.target_id, due.target_snapshot, recipe.source).await?;
                validate_scheduled_input(&resolved.0, &recipe.input)?;
                Ok::<_, anyhow::Error>(resolved)
            }
            .await;
            let (dsl, target_snapshot, release_id, release_version) = match resolved {
                Ok(resolved) => resolved,
                Err(error) => {
                    // A local workflow may be deleted or become structurally invalid
                    // after a schedule is saved. Pause once instead of producing an
                    // unbounded stream of failed unattended attempts.
                    let message = error.to_string();
                    sqlx::query("UPDATE schedules SET enabled = 0, last_error = ?, updated_at = ? WHERE id = ?")
                        .bind(&message)
                        .bind(Utc::now().to_rfc3339())
                        .bind(&trigger.schedule_id)
                        .execute(pool)
                        .await?;
                    sqlx::query(
                        "UPDATE schedule_occurrences SET status = 'skipped', reason = ?, error = ? WHERE id = ?",
                    )
                    .bind("Workflow schedule needs attention.")
                    .bind(message)
                    .bind(&occurrence_id)
                    .execute(pool)
                    .await?;
                    return Ok(());
                },
            };
            run_manager::start_workflow(StartWorkflowRun {
                run_id: run_id.clone(),
                target_id: due.summary.target_id,
                target_name: due.summary.target_name,
                input: recipe.input.clone(),
                target_snapshot,
                release_id,
                release_version,
                dsl,
                initial_state: recipe.initial_state,
                thread_id: Uuid::new_v4().to_string(),
                evaluation_profile: None,
                evaluation_result_id: None,
                schedule_trigger: Some(trigger),
            })
            .await?;
        },
    }
    sqlx::query("UPDATE schedule_occurrences SET run_id = ? WHERE id = ?")
        .bind(run_id)
        .bind(occurrence_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn validate_app_request(request: &AppScheduleRequest) -> Result<()> {
    if request.name.trim().is_empty() || request.target_id.trim().is_empty() {
        bail!("schedule name and App are required");
    }
    next_run(&request.cron_expression, &request.timezone, Utc::now()).map(|_| ())
}

fn validate_workflow_request(request: &WorkflowScheduleRequest) -> Result<()> {
    if request.name.trim().is_empty() || request.target_id.trim().is_empty() {
        bail!("schedule name and Workflow are required");
    }
    if !request.input.is_object() || !request.initial_state.is_object() {
        bail!("scheduled Workflow input and initial state must be objects");
    }
    validate_unattended_workflow(&request.target_snapshot)?;
    validate_scheduled_input(&request.target_snapshot, &request.input)?;
    if let WorkflowScheduleSource::PublishedRelease {
        dsl,
        release_id,
        release_version,
    } = &request.source
    {
        if release_id.trim().is_empty() || release_version.trim().is_empty() || !dsl.is_object() {
            bail!("published Workflow schedules require a release and DSL snapshot");
        }
        validate_unattended_workflow(dsl)?;
    }
    next_run(&request.cron_expression, &request.timezone, Utc::now()).map(|_| ())
}

async fn resolve_workflow_recipe(
    workflow_id: &str,
    stored_snapshot: Value,
    source: WorkflowScheduleSource,
) -> Result<(Value, Value, Option<String>, Option<String>)> {
    match source {
        WorkflowScheduleSource::PublishedRelease {
            dsl,
            release_id,
            release_version,
        } => Ok((dsl, stored_snapshot, Some(release_id), Some(release_version))),
        WorkflowScheduleSource::LatestLocal => {
            let workflows = Config::workflows().await.data_arc();
            let workflow = workflows
                .find_workflow(workflow_id)
                .ok_or_else(|| anyhow!("scheduled Workflow no longer exists"))?;
            let dsl = workflow_dsl_from_document(workflow_id, &workflow.document)?;
            Ok((dsl, workflow.document, None, None))
        },
    }
}

fn workflow_dsl_from_document(workflow_id: &str, document: &Value) -> Result<Value> {
    validate_unattended_workflow(document)?;
    let settings = document
        .get("settings")
        .and_then(Value::as_object)
        .ok_or_else(|| anyhow!("saved Workflow has no settings"))?;
    let name = settings
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("saved Workflow has no name"))?;
    let dsl = json!({
        "id": workflow_id,
        "name": name,
        "description": settings.get("description"),
        "mode": settings.get("mode").cloned().unwrap_or_else(|| json!("task")),
        "inputSchema": settings.get("inputSchema").cloned().unwrap_or_else(|| json!({"fields": []})),
        "outputSchema": settings.get("outputSchema").cloned().unwrap_or_else(|| json!({"fields": []})),
        "nodes": document.get("nodes").cloned().unwrap_or_else(|| json!([])),
        "edges": document.get("edges").cloned().unwrap_or_else(|| json!([])),
    });
    serde_json::from_value::<WorkflowDsl>(dsl.clone()).context("saved Workflow cannot run unattended")?;
    Ok(dsl)
}

fn empty_json_object() -> Value {
    json!({})
}

fn validate_unattended_workflow(definition: &Value) -> Result<()> {
    let Some(nodes) = definition.get("nodes").and_then(Value::as_array) else {
        return Ok(());
    };
    if nodes.iter().any(|node| {
        matches!(
            node.get("type").and_then(Value::as_str),
            Some("human_review" | "ask_user_question")
        )
    }) {
        bail!("scheduled Workflows cannot contain Human Review or Ask User Question nodes");
    }
    Ok(())
}

fn validate_scheduled_input(definition: &Value, input: &Value) -> Result<()> {
    let schema = definition.get("inputSchema").or_else(|| {
        definition
            .get("settings")
            .and_then(|settings| settings.get("inputSchema"))
    });
    let Some(fields) = schema.and_then(|schema| schema.get("fields")).and_then(Value::as_array) else {
        return Ok(());
    };
    let values = input
        .as_object()
        .ok_or_else(|| anyhow!("scheduled Workflow input must be an object"))?;
    for field in fields {
        let Some(key) = field.get("key").and_then(Value::as_str) else {
            continue;
        };
        let value = values.get(key);
        if field.get("required").and_then(Value::as_bool) == Some(true) && value.is_none_or(Value::is_null) {
            bail!("scheduled Workflow input is missing required field: {key}");
        }
        match (field.get("type").and_then(Value::as_str), value) {
            (Some("number"), Some(value)) if !value.is_number() => {
                bail!("scheduled Workflow input {key} must be a number")
            },
            (Some("boolean"), Some(value)) if !value.is_boolean() => {
                bail!("scheduled Workflow input {key} must be a boolean")
            },
            _ => {},
        }
    }
    Ok(())
}

fn next_run(expression: &str, timezone: &str, after: DateTime<Utc>) -> Result<DateTime<Utc>> {
    if expression.split_whitespace().count() != 5 {
        bail!("Cron expressions must contain five fields: minute hour day month weekday");
    }
    let timezone = Tz::from_str(timezone).map_err(|_| anyhow!("unknown timezone: {timezone}"))?;
    let cron = Cron::from_str(expression).context("invalid Cron expression")?;
    let local = after.with_timezone(&timezone);
    Ok(cron.find_next_occurrence(&local, false)?.with_timezone(&Utc))
}

fn parse_time(value: &str) -> Result<DateTime<Utc>> {
    Ok(DateTime::parse_from_rfc3339(value)?.with_timezone(&Utc))
}

fn schedule_summary(row: &sqlx::sqlite::SqliteRow) -> Result<ScheduleSummary> {
    let recipe = row
        .try_get::<&str, _>("execution_recipe_json")
        .ok()
        .and_then(|value| serde_json::from_str::<Value>(value).ok());
    Ok(ScheduleSummary {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        target_type: match row.try_get::<&str, _>("target_type")? {
            "app" => ScheduleTargetType::App,
            "workflow" => ScheduleTargetType::Workflow,
            value => bail!("unknown schedule target type: {value}"),
        },
        target_id: row.try_get("target_id")?,
        target_name: row.try_get("target_name")?,
        cron_expression: row.try_get("cron_expression")?,
        timezone: row.try_get("timezone")?,
        enabled: row.try_get("enabled")?,
        next_run_at: row.try_get("next_run_at")?,
        last_run_at: row.try_get("last_run_at")?,
        editor_mode: recipe
            .as_ref()
            .and_then(|value| value.get("editorMode").and_then(Value::as_str).map(ToOwned::to_owned)),
        input: recipe
            .as_ref()
            .and_then(|value| value.get("input"))
            .filter(|value| value.is_object())
            .cloned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calculates_the_next_run_in_the_schedule_timezone() {
        let after = DateTime::parse_from_rfc3339("2026-09-28T00:30:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let next = next_run("0 9 * * 1-5", "Asia/Shanghai", after).unwrap();
        assert_eq!(next.to_rfc3339(), "2026-09-28T01:00:00+00:00");
    }

    #[test]
    fn recovery_advances_an_overdue_schedule_to_a_future_occurrence() {
        let now = DateTime::parse_from_rfc3339("2026-09-28T10:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let next = next_run("*/15 * * * *", "UTC", now).unwrap();

        assert!(next > now);
        assert_eq!(next.to_rfc3339(), "2026-09-28T10:15:00+00:00");
    }

    #[test]
    fn rejects_non_user_facing_cron_shapes() {
        let error = next_run("0 0 9 * * *", "UTC", Utc::now()).unwrap_err();
        assert!(error.to_string().contains("five fields"));
    }

    #[test]
    fn rejects_workflows_that_require_a_person() {
        let error = validate_unattended_workflow(&json!({
            "nodes": [{ "type": "human_review" }],
        }))
        .unwrap_err();
        assert!(error.to_string().contains("cannot contain"));
    }

    #[test]
    fn converts_a_saved_document_to_an_executable_dsl() {
        let dsl = workflow_dsl_from_document("workflow-1", &json!({
            "settings": { "name": "Nightly", "mode": "task", "inputSchema": { "fields": [] }, "outputSchema": { "fields": [] } },
            "nodes": [{ "id": "start", "type": "start", "data": {} }],
            "edges": [],
        }))
        .unwrap();
        assert_eq!(dsl["id"], "workflow-1");
        assert_eq!(dsl["name"], "Nightly");
    }

    #[test]
    fn rejects_missing_required_scheduled_input() {
        let error = validate_scheduled_input(
            &json!({ "inputSchema": { "fields": [{ "key": "recipient", "type": "string", "required": true }] } }),
            &json!({}),
        )
        .unwrap_err();
        assert!(error.to_string().contains("recipient"));
    }

    #[tokio::test]
    async fn schedule_changes_interrupt_a_pending_wait() {
        let (sender, mut changes) = tokio::sync::watch::channel(0_u64);
        sender.send_modify(|version| *version += 1);

        let woke_for_change = wait_for_change_or_timeout(&mut changes, Duration::from_secs(60)).await;

        assert!(woke_for_change);
    }
}
