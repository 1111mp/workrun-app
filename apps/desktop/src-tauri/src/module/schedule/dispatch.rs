//! Claims and recovery share the same terminal state for one-time schedules.
use super::{ScheduleKind, ScheduleSummary, ScheduleTiming, parse_time};
use anyhow::Result;
use chrono::{DateTime, Utc};
use sqlx::{Row, SqlitePool};
use uuid::Uuid;

pub(super) struct ScheduleDispatcher<'a> {
    pool: &'a SqlitePool,
    workspace: &'a str,
}

pub(super) struct ScheduleClaim {
    pub scheduled_for: String,
    pub occurrence_id: String,
    pub skipped: bool,
}

impl<'a> ScheduleDispatcher<'a> {
    pub fn new(pool: &'a SqlitePool, workspace: &'a str) -> Self {
        Self { pool, workspace }
    }

    pub async fn recover_missed(&self, now: DateTime<Utc>) -> Result<()> {
        let rows = sqlx::query("SELECT * FROM schedules WHERE workspace_id=? AND enabled=1 AND next_run_at<=?")
            .bind(self.workspace)
            .bind(now.to_rfc3339())
            .fetch_all(self.pool)
            .await?;
        for row in rows {
            let id: String = row.try_get("id")?;
            let scheduled_for: String = row.try_get("next_run_at")?;
            let timing = ScheduleTiming::from_row(&row)?;
            let once = timing.schedule_kind == ScheduleKind::Once;
            let next = if once {
                scheduled_for.clone()
            } else {
                timing.next_for_save(now, true)?.to_rfc3339()
            };
            let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
            let changed = sqlx::query("UPDATE schedules SET next_run_at=?,updated_at=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,finished_at=CASE WHEN ? THEN ? ELSE finished_at END,finish_reason=CASE WHEN ? THEN 'missed' ELSE finish_reason END WHERE workspace_id=? AND id=? AND enabled=1 AND next_run_at=?")
                .bind(next).bind(now.to_rfc3339()).bind(once).bind(once).bind(now.to_rfc3339()).bind(once).bind(self.workspace).bind(&id).bind(&scheduled_for).execute(&mut *tx).await?;
            if once && changed.rows_affected() == 1 {
                sqlx::query("INSERT OR IGNORE INTO schedule_occurrences(id,schedule_id,scheduled_for,status,reason,created_at) VALUES(?,?,?,'skipped',?,?)")
                    .bind(Uuid::new_v4().to_string()).bind(&id).bind(&scheduled_for).bind("Workrun was closed or this workspace was inactive at the scheduled time.").bind(now.to_rfc3339()).execute(&mut *tx).await?;
            }
            tx.commit().await?;
            if changed.rows_affected() == 1 {
                super::ScheduleEvents::tasks(self.workspace);
            }
        }
        Ok(())
    }

    pub async fn failed(&self, id: &str, occurrence: &str, message: &str) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("UPDATE schedule_occurrences SET status='skipped',reason='The scheduled execution could not start.',error=? WHERE id=?")
            .bind(message).bind(occurrence).execute(&mut *tx).await?;
        // A concurrent reschedule must retain its fresh timing and state.
        sqlx::query("UPDATE schedules SET last_error=?,finish_reason=CASE WHEN schedule_kind='once' THEN 'failed' ELSE finish_reason END WHERE workspace_id=? AND id=? AND last_run_at=(SELECT scheduled_for FROM schedule_occurrences WHERE id=?) AND (schedule_kind='recurring' OR finished_at IS NOT NULL)")
            .bind(message).bind(self.workspace).bind(id).bind(occurrence).execute(&mut *tx).await?;
        tx.commit().await?;
        super::ScheduleEvents::tasks(self.workspace);
        Ok(())
    }

    pub async fn claim(&self, summary: &ScheduleSummary, now: DateTime<Utc>) -> Result<Option<ScheduleClaim>> {
        let scheduled_for = summary.next_run_at.clone();
        if parse_time(&scheduled_for)? > now {
            return Ok(None);
        }
        let once = summary.timing.schedule_kind == ScheduleKind::Once;
        let next = if once {
            scheduled_for.clone()
        } else {
            summary
                .timing
                .next_for_save(parse_time(&scheduled_for)?, true)?
                .to_rfc3339()
        };
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        let changed = sqlx::query("UPDATE schedules SET next_run_at=?,last_run_at=?,updated_at=?,enabled=CASE WHEN ? THEN 0 ELSE enabled END,finished_at=CASE WHEN ? THEN ? ELSE finished_at END,finish_reason=CASE WHEN ? THEN 'triggered' ELSE finish_reason END WHERE workspace_id=? AND id=? AND enabled=1 AND next_run_at=?")
            .bind(next).bind(&scheduled_for).bind(now.to_rfc3339()).bind(once).bind(once).bind(now.to_rfc3339()).bind(once).bind(self.workspace).bind(&summary.id).bind(&scheduled_for).execute(&mut *tx).await?;
        if changed.rows_affected() == 0 {
            tx.commit().await?;
            return Ok(None);
        }
        let skipped: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE workspace_id=? AND target_type=? AND target_id=? AND status IN ('queued','running','waiting_for_input'))")
            .bind(self.workspace).bind(match summary.target_type {super::ScheduleTargetType::App=>"app",super::ScheduleTargetType::Workflow=>"workflow"}).bind(&summary.target_id).fetch_one(&mut *tx).await?;
        if once && skipped {
            sqlx::query("UPDATE schedules SET finish_reason='skipped' WHERE workspace_id=? AND id=?")
                .bind(self.workspace)
                .bind(&summary.id)
                .execute(&mut *tx)
                .await?;
        }
        let occurrence_id = Uuid::new_v4().to_string();
        sqlx::query("INSERT OR IGNORE INTO schedule_occurrences(id,schedule_id,scheduled_for,status,reason,created_at) VALUES(?,?,?,?,?,?)")
            .bind(&occurrence_id).bind(&summary.id).bind(&scheduled_for).bind(if skipped {"skipped"}else{"queued"})
            .bind(skipped.then_some("A run for this target was already queued, running, or waiting for input.")).bind(now.to_rfc3339()).execute(&mut *tx).await?;
        tx.commit().await?;
        super::ScheduleEvents::tasks(self.workspace);
        Ok(Some(ScheduleClaim {
            scheduled_for,
            occurrence_id,
            skipped,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn fixture() -> (SqlitePool, ScheduleSummary) {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        for migration in [
            include_str!("../../../resources/migrations/20260904083536_create_run_history.up.sql"),
            include_str!("../../../resources/migrations/20261005100000_remote_tasks.up.sql"),
            include_str!("../../../resources/migrations/20261104110000_one_time_schedules.up.sql"),
        ] {
            sqlx::raw_sql(migration).execute(&pool).await.unwrap();
        }
        sqlx::query("INSERT INTO schedules(id,workspace_id,name,target_type,target_id,target_name,target_snapshot_json,execution_recipe_json,cron_expression,timezone,enabled,next_run_at,created_at,updated_at,schedule_kind,run_at) VALUES('once','personal','Weather','app','app','Weather','{}','{}','','Asia/Shanghai',1,'2026-11-05T02:00:00+00:00','now','v1','once','2026-11-05T02:00:00+00:00')").execute(&pool).await.unwrap();
        let row = sqlx::query("SELECT * FROM schedules").fetch_one(&pool).await.unwrap();
        let summary = super::super::schedule_summary(&row).unwrap();
        assert_eq!(serde_json::to_value(&summary).unwrap()["scheduleKind"], json!("once"));
        (pool, summary)
    }

    #[tokio::test]
    async fn due_once_is_claimed_exactly_once_and_failure_is_visible() {
        let (pool, summary) = fixture().await;
        let dispatcher = ScheduleDispatcher::new(&pool, "personal");
        let due = parse_time(&summary.next_run_at).unwrap();
        assert!(
            dispatcher
                .claim(&summary, due - chrono::Duration::seconds(1))
                .await
                .unwrap()
                .is_none()
        );
        let claim = dispatcher.claim(&summary, due).await.unwrap().unwrap();
        assert!(!claim.skipped);
        assert!(
            dispatcher
                .claim(&summary, due + chrono::Duration::days(365))
                .await
                .unwrap()
                .is_none()
        );
        dispatcher
            .failed(&summary.id, &claim.occurrence_id, "dispatch failed")
            .await
            .unwrap();
        let row = sqlx::query("SELECT * FROM schedules").fetch_one(&pool).await.unwrap();
        assert!(!row.get::<bool, _>("enabled"));
        assert_eq!(row.get::<String, _>("finish_reason"), "failed");
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schedule_occurrences")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn reopening_marks_once_missed_without_replaying() {
        let (pool, summary) = fixture().await;
        let dispatcher = ScheduleDispatcher::new(&pool, "personal");
        let later = parse_time(&summary.next_run_at).unwrap() + chrono::Duration::hours(2);
        ScheduleDispatcher::new(&pool, "other")
            .recover_missed(later)
            .await
            .unwrap();
        assert!(
            sqlx::query_scalar::<_, bool>("SELECT enabled FROM schedules")
                .fetch_one(&pool)
                .await
                .unwrap()
        );
        dispatcher.recover_missed(later).await.unwrap();
        dispatcher.recover_missed(later).await.unwrap();
        assert!(dispatcher.claim(&summary, later).await.unwrap().is_none());
        let row = sqlx::query("SELECT * FROM schedules").fetch_one(&pool).await.unwrap();
        assert_eq!(row.get::<String, _>("finish_reason"), "missed");
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM schedule_occurrences WHERE status='skipped'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}
