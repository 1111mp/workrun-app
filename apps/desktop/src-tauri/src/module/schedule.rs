//! Durable, local schedules for top-level executions.

use crate::{
    core::db::DBManager,
    module::run_manager::{self, ScheduleTrigger, StartAppRun},
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
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use uuid::Uuid;

const SCHEDULE_TICK: Duration = Duration::from_secs(15);
static STARTED: AtomicBool = AtomicBool::new(false);

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
}

#[derive(Debug)]
struct DueSchedule {
    summary: ScheduleSummary,
    target_snapshot: Value,
}

pub struct ScheduleStore;

impl ScheduleStore {
    pub async fn list_for_app(target_id: &str) -> Result<Vec<ScheduleSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, name, target_type, target_id, target_name, cron_expression, timezone, enabled, next_run_at, last_run_at FROM schedules WHERE target_type = 'app' AND target_id = ? ORDER BY next_run_at ASC, id ASC")
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
        sqlx::query("INSERT INTO schedules (id, name, target_type, target_id, target_name, target_snapshot_json, cron_expression, timezone, enabled, next_run_at, created_at, updated_at) VALUES (?, ?, 'app', ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, target_id = excluded.target_id, target_name = excluded.target_name, target_snapshot_json = excluded.target_snapshot_json, cron_expression = excluded.cron_expression, timezone = excluded.timezone, enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at")
            .bind(&id)
            .bind(&request.name)
            .bind(&request.target_id)
            .bind(&request.target_name)
            .bind(request.target_snapshot.to_string())
            .bind(&request.cron_expression)
            .bind(&request.timezone)
            .bind(request.enabled)
            .bind(next_run_at.to_rfc3339())
            .bind(&now)
            .bind(&now)
            .execute(&pool)
            .await?;
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
        })
    }

    pub async fn delete(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        sqlx::query("DELETE FROM schedules WHERE id = ?")
            .bind(id)
            .execute(&pool)
            .await?;
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
        Ok(())
    }
}

/// Starts after database recovery and the RunSupervisor. A schedule only enqueues
/// a normal App Run, so cancellation, limits, and history remain centralized.
pub fn start_scheduler() {
    if STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    AsyncHandler::spawn(|| async {
        loop {
            if let Err(error) = trigger_due_schedules().await {
                log::error!("failed to process scheduled App runs: {error:#}");
            }
            tokio::time::sleep(SCHEDULE_TICK).await;
        }
    });
}

async fn trigger_due_schedules() -> Result<()> {
    let pool = DBManager::global().pool()?;
    let rows = sqlx::query("SELECT id, name, target_type, target_id, target_name, target_snapshot_json, cron_expression, timezone, enabled, next_run_at, last_run_at FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC, id ASC")
        .bind(Utc::now().to_rfc3339()).fetch_all(&pool).await?;
    for row in rows {
        let due = DueSchedule {
            summary: schedule_summary(&row)?,
            target_snapshot: serde_json::from_str(row.try_get::<&str, _>("target_snapshot_json")?)
                .context("scheduled target snapshot is invalid")?,
        };
        trigger_due_schedule(&pool, due).await?;
    }
    Ok(())
}

async fn trigger_due_schedule(pool: &sqlx::SqlitePool, due: DueSchedule) -> Result<()> {
    if !matches!(due.summary.target_type, ScheduleTargetType::App) {
        return Ok(()); // Reserved until Workflow scheduling is enabled.
    }
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
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE target_type = 'app' AND target_id = ? AND status IN ('queued', 'running'))")
        .bind(&due.summary.target_id).fetch_one(&mut *tx).await?;
    let occurrence_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT OR IGNORE INTO schedule_occurrences (id, schedule_id, scheduled_for, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(&occurrence_id).bind(&due.summary.id).bind(&scheduled_for)
        .bind(if active { "skipped" } else { "queued" })
        .bind(active.then_some("An App run was already queued or running."))
        .bind(Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    tx.commit().await?;
    if active {
        return Ok(());
    }
    let run_id = Uuid::new_v4().to_string();
    run_manager::start_app(StartAppRun {
        run_id: run_id.clone(),
        target_id: due.summary.target_id,
        target_name: due.summary.target_name,
        output_view: json!({"isRunning": true, "node": due.target_snapshot}),
        target_snapshot: due.target_snapshot,
        schedule_trigger: Some(ScheduleTrigger {
            schedule_id: due.summary.id,
            scheduled_for,
        }),
    })
    .await?;
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
    fn rejects_non_user_facing_cron_shapes() {
        let error = next_run("0 0 9 * * *", "UTC", Utc::now()).unwrap_err();
        assert!(error.to_string().contains("five fields"));
    }
}
