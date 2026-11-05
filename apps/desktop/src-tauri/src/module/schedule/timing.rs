//! Explicit one-time instants are separate from recurring Cron rules.
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::Row;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScheduleKind {
    #[default]
    Recurring,
    Once,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleTiming {
    #[serde(default)]
    pub schedule_kind: ScheduleKind,
    #[serde(default, skip_serializing)]
    pub cron_expression: String,
    #[serde(skip_serializing)]
    pub timezone: String,
    pub run_at: Option<String>,
    pub finished_at: Option<String>,
    pub finish_reason: Option<String>,
}

impl ScheduleTiming {
    pub fn from_row(row: &sqlx::sqlite::SqliteRow) -> Result<Self> {
        Ok(Self {
            schedule_kind: serde_json::from_value(json!(row.try_get::<String, _>("schedule_kind")?))?,
            cron_expression: row.try_get("cron_expression")?,
            timezone: row.try_get("timezone")?,
            run_at: row.try_get("run_at")?,
            finished_at: row.try_get("finished_at")?,
            finish_reason: row.try_get("finish_reason")?,
        })
    }

    pub fn from_value(value: &Value) -> Result<Self> {
        Ok(serde_json::from_value(value.clone())?)
    }

    pub fn once_at(&self) -> Result<DateTime<Utc>> {
        let zone = self.timezone.parse::<Tz>().context("Choose a valid timezone")?;
        let value = self
            .run_at
            .as_deref()
            .context("Choose a date and time for this one-time task")?;
        if let Ok(instant) = DateTime::parse_from_rfc3339(value) {
            return Ok(instant.with_timezone(&Utc));
        }
        // The date editor submits local wall time; DST gaps and overlaps need an explicit offset.
        let local = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M").context("Use a complete date and time")?;
        Ok(zone
            .from_local_datetime(&local)
            .single()
            .context(
                "This local time is ambiguous or does not exist. Choose another time or include a timezone offset",
            )?
            .with_timezone(&Utc))
    }

    pub fn next_for_save(&self, now: DateTime<Utc>, require_future: bool) -> Result<DateTime<Utc>> {
        match self.schedule_kind {
            ScheduleKind::Recurring => super::next_run(&self.cron_expression, &self.timezone, now),
            ScheduleKind::Once => {
                let instant = self.once_at()?;
                ensure!(
                    !require_future || instant > now,
                    "Choose a future date and time for this one-time task"
                );
                Ok(instant)
            },
        }
    }

    pub fn patch(value: &mut Value, args: &Value, now: DateTime<Utc>) -> Result<()> {
        let old_kind = value["scheduleKind"].as_str().unwrap_or("recurring").to_owned();
        let old_run_at = value["runAt"].clone();
        for field in ["scheduleKind", "cronExpression", "runAt", "timezone"] {
            if let Some(input) = args.get(field) {
                value[field] = input.clone();
            }
        }
        if value["scheduleKind"].is_null() {
            value["scheduleKind"] = json!("recurring");
        }
        if args["runAt"].is_string() && args.get("scheduleKind").is_none() {
            value["scheduleKind"] = json!("once");
        }
        let mut timing = Self::from_value(value)?;
        if timing.schedule_kind == ScheduleKind::Once {
            ensure!(
                args["cronExpression"]
                    .as_str()
                    .is_none_or(|expression| expression.trim().is_empty()),
                "Choose either a one-time date or a recurring time rule"
            );
            timing.cron_expression.clear();
            timing.run_at = Some(timing.once_at()?.to_rfc3339());
        } else {
            ensure!(
                args["runAt"].is_null(),
                "Recurring tasks use a time rule instead of a one-time date"
            );
            timing.run_at = None;
        }
        let rescheduled = old_kind != serde_json::to_value(timing.schedule_kind)?.as_str().unwrap()
            || (args.get("runAt").is_some() && old_run_at != json!(timing.run_at));
        if rescheduled {
            if timing.finished_at.is_some() {
                value["enabled"] = json!(true);
            }
            timing.finished_at = None;
            timing.finish_reason = None;
        }
        let operation = args["operation"].as_str().unwrap_or("update");
        ensure!(
            !matches!(operation, "pause" | "resume") || timing.finished_at.is_none(),
            "This one-time task has ended. Choose a future time to schedule it again"
        );
        let next = timing.next_for_save(now, operation != "pause" && timing.finished_at.is_none())?;
        for (key, field) in serde_json::to_value(&timing)?.as_object().unwrap() {
            value[key] = field.clone();
        }
        value["cronExpression"] = json!(timing.cron_expression);
        value["timezone"] = json!(timing.timezone);
        value["nextRunAt"] = json!(next.to_rfc3339());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn once_resolves_absolute_and_local_time_without_annual_cron() {
        let now = DateTime::parse_from_rfc3339("2026-11-04T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut task = json!({"timezone":"Asia/Shanghai","enabled":true});
        ScheduleTiming::patch(
            &mut task,
            &json!({"operation":"create","runAt":"2026-11-05T10:00:00+08:00"}),
            now,
        )
        .unwrap();
        assert_eq!(task["scheduleKind"], "once");
        assert_eq!(task["cronExpression"], "");
        assert_eq!(task["nextRunAt"], "2026-11-05T02:00:00+00:00");
        let mut local = json!({"timezone":"Asia/Shanghai","enabled":true});
        ScheduleTiming::patch(&mut local, &json!({"runAt":"2026-11-05T10:00"}), now).unwrap();
        assert_eq!(task["runAt"], local["runAt"]);
        assert!(ScheduleTiming::patch(&mut local, &json!({"runAt":"2026-11-03T10:00"}), now).is_err());
    }

    #[test]
    fn metadata_edits_preserve_finished_once_precision_and_state() {
        let now = DateTime::parse_from_rfc3339("2026-11-05T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let mut task = json!({"scheduleKind":"once","runAt":"2026-11-04T02:00:37.123+00:00","cronExpression":"","timezone":"Asia/Shanghai","enabled":false,"finishedAt":"2026-11-04T03:00:00Z","finishReason":"triggered"});
        let original = task.clone();
        ScheduleTiming::patch(
            &mut task,
            &json!({"operation":"update","scheduleKind":"once","timezone":"Asia/Shanghai","name":"Renamed"}),
            now,
        )
        .unwrap();
        for field in ["runAt", "finishedAt", "finishReason", "enabled"] {
            assert_eq!(task[field], original[field]);
        }
    }

    #[test]
    fn terminal_tasks_require_rescheduling_and_timezone_gaps_are_rejected() {
        let now = DateTime::parse_from_rfc3339("2026-11-04T02:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let task = json!({"scheduleKind":"once","runAt":"2026-11-03T02:00:00Z","cronExpression":"","timezone":"Asia/Shanghai","enabled":false,"finishedAt":"2026-11-03T03:00:00Z","finishReason":"missed"});
        assert!(ScheduleTiming::patch(&mut task.clone(), &json!({"operation":"resume"}), now).is_err());
        let mut edited = task.clone();
        ScheduleTiming::patch(&mut edited, &json!({"operation":"update"}), now).unwrap();
        assert_eq!(edited["finishReason"], "missed");
        ScheduleTiming::patch(&mut edited, &json!({"runAt":"2026-11-05T10:00"}), now).unwrap();
        assert_eq!(edited["enabled"], true);
        assert!(edited["finishedAt"].is_null());
        ScheduleTiming::patch(
            &mut edited,
            &json!({"scheduleKind":"recurring","cronExpression":"0 10 * * *"}),
            now,
        )
        .unwrap();
        assert!(edited["runAt"].is_null());
        for time in ["2027-03-14T02:30", "2026-11-01T01:30"] {
            let timing =
                ScheduleTiming::from_value(&json!({"scheduleKind":"once","timezone":"America/New_York","runAt":time}))
                    .unwrap();
            assert!(timing.once_at().is_err());
        }
    }
}
