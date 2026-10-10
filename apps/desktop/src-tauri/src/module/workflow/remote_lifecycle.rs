//! One best-effort A2A cancellation when a workflow fails or is stopped.
use super::{RemoteTaskOperation, remote_tasks};
use anyhow::Result;
use serde_json::{Value, json};
use sqlx::SqlitePool;

pub(crate) fn cancel_for_run(run_id: &str) {
    let run_id = run_id.to_owned();
    tokio::spawn(async move {
        let result = async {
            let pool = crate::core::db::DBManager::global().pool()?;
            let config = crate::config::BaseConfig::workrun().await.data_arc();
            cancel_in_pool(&pool, &run_id, |id| {
                    let config = config.clone();
                    async move {
                        super::remote_agent::remote_task_operation(&id, RemoteTaskOperation::Cancel, &config).await
                    }
                })
                .await
        }
        .await;
        if let Err(error) = result {
            log::warn!("remote task cancellation: {error:#}");
        }
    });
}

pub(super) async fn cancel_in_pool<F, Fut>(pool: &SqlitePool, run: &str, mut cancel: F) -> Result<()>
where
    F: FnMut(String) -> Fut,
    Fut: std::future::Future<Output = Result<remote_tasks::RemoteTaskRecord>>,
{
    let eligible: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_records WHERE id=? AND target_type='workflow' AND status IN ('failed','cancelled') AND json_extract(runtime_json,'$.evaluationProfile') IS NULL)")
        .bind(run).fetch_one(pool).await?;
    if !eligible {
        return Ok(());
    }
    for record in remote_tasks::list_remote_tasks(pool, run).await? {
        if !matches!(
            record.status.as_str(),
            "unknown" | "submitted" | "working" | "input_required" | "auth_required"
        ) {
            continue;
        }
        let excluded: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE adapter_record_id=? AND (purpose='compensation' OR confirmed_no_effect=1)) OR EXISTS(SELECT 1 FROM workflow_operation_reviews WHERE remote_record_id=? AND decision='no_effect')")
            .bind(&record.id).bind(&record.id).fetch_one(pool).await?;
        if excluded {
            continue;
        }
        // The persisted start message also prevents duplicate finish callbacks
        // from issuing another cancellation. No scheduler resumes this on exit.
        if !message(
            pool,
            run,
            &record.node_id,
            &record.id,
            if record.task_id.is_some() {
                "cancel_requested"
            } else {
                "unknown"
            },
        )
        .await?
        {
            continue;
        }
        if record.task_id.is_none() {
            continue;
        }
        let status = match cancel(record.id.clone()).await {
            Ok(updated) => updated.status,
            // Hide credential-bearing server errors; timeout is not cancellation.
            Err(_) => "awaiting_confirmation".to_owned(),
        };
        message(pool, run, &record.node_id, &record.id, &status).await?;
    }
    Ok(())
}

async fn message(pool: &SqlitePool, run: &str, node: &str, id: &str, status: &str) -> Result<bool> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    if matches!(status, "cancel_requested" | "unknown") {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_events WHERE run_id=? AND json_extract(event_json,'$.event_type')='remote.lifecycle' AND json_extract(event_json,'$.data.remoteRecordId')=?)")
            .bind(run).bind(id).fetch_one(&mut *tx).await?;
        if exists {
            tx.commit().await?;
            return Ok(false);
        }
    }
    let path: Option<String> =
        sqlx::query_scalar("SELECT execution_path FROM workflow_operations WHERE adapter_record_id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let mut node = node.to_owned();
    let mut step = Value::Null;
    if let Some(path) = path.and_then(|p| serde_json::from_str::<Value>(&p).ok()) {
        node = path[1].as_str().unwrap_or(&node).to_owned();
        step = path[2].clone();
        let mut scope = path[0].as_str().unwrap_or("root").to_owned();
        while let Ok(parent) = serde_json::from_str::<Value>(&scope) {
            let Some(parent_node) = parent[1].as_str() else {
                break;
            };
            node = parent_node.to_owned();
            step = parent[2].clone();
            scope = parent[0].as_str().unwrap_or("root").to_owned();
        }
    }
    let event = json!({"type":"custom","node":node,"event_type":"remote.lifecycle","data":{"remoteRecordId":id,"ownerStep":step,"status":status}});
    let sequence: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(sequence),-1)+1 FROM run_events WHERE run_id=?")
        .bind(run)
        .fetch_one(&mut *tx)
        .await?;
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT INTO run_events (run_id,sequence,event_json,created_at) VALUES (?,?,?,?)")
        .bind(run)
        .bind(sequence)
        .bind(event.to_string())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE run_records SET last_sequence=?,updated_at=? WHERE id=?")
        .bind(sequence)
        .bind(&now)
        .bind(run)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::module::run_manager::emit_cleanup_event(run, sequence, event);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn fixture(status: &str) -> SqlitePool {
        let pool = remote_tasks::test_pool().await;
        sqlx::query("CREATE TABLE run_events (run_id TEXT,sequence INTEGER,event_json TEXT,created_at TEXT,PRIMARY KEY(run_id,sequence))").execute(&pool).await.unwrap();
        sqlx::query("UPDATE run_records SET status=? WHERE id='run-1'")
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        for (id, remote_status, task) in [
            ("working", "working", Some("task-1")),
            ("no-id", "unknown", None),
            ("completed", "completed", Some("task-2")),
            ("failed", "failed", Some("task-3")),
            ("input", "input_required", Some("task-4")),
        ] {
            sqlx::query("INSERT INTO remote_tasks (id,run_id,node_id,message_id,service_origin,connection_ciphertext,task_id,status,created_at,updated_at) VALUES (?,'run-1','remote',?,'https://agent.example','private',?,?,?,?)")
                .bind(id).bind(id).bind(task).bind(remote_status).bind(id).bind(id).execute(&pool).await.unwrap();
        }
        pool
    }

    #[tokio::test]
    async fn cancels_once_without_querying_and_skips_terminal_or_missing_identity() {
        let pool = fixture("failed").await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let record = remote_tasks::list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        for _ in 0..2 {
            cancel_in_pool(&pool, "run-1", |id| {
                calls.lock().unwrap().push(id.clone());
                let mut record = record.clone();
                record.id = id;
                record.status = "canceled".into();
                async move { Ok(record) }
            })
            .await
            .unwrap();
        }
        assert_eq!(*calls.lock().unwrap(), vec!["input", "working"]);
        let unknown: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE json_extract(event_json,'$.data.status')='unknown'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(unknown, 1);
        let cancelled: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_events WHERE json_extract(event_json,'$.data.status')='canceled'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(cancelled, 2);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM run_records WHERE id='run-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "failed"
        );
    }

    #[tokio::test]
    async fn timeout_is_unconfirmed_does_not_retry_or_block_other_calls_or_continuation() {
        let pool = fixture("cancelled").await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        for _ in 0..2 {
            cancel_in_pool(&pool, "run-1", |id| {
                calls.lock().unwrap().push(id);
                async { anyhow::bail!("request timed out with private credential") }
            })
            .await
            .unwrap();
        }
        assert_eq!(calls.lock().unwrap().len(), 2);
        let events: Vec<String> = sqlx::query_scalar("SELECT event_json FROM run_events ORDER BY sequence")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.contains("awaiting_confirmation"))
                .count(),
            2
        );
        assert!(!events.iter().any(|event| event.contains("private credential")));
        let mut tx = pool.begin().await.unwrap();
        super::super::saga_scheduler::ensure_continuable(&mut tx, "run-1")
            .await
            .unwrap();
        tx.rollback().await.unwrap();
    }

    #[tokio::test]
    async fn completion_app_exit_interruption_and_evaluation_do_not_cancel() {
        for status in ["completed", "interrupted", "running", "waiting_for_input"] {
            let pool = fixture(status).await;
            cancel_in_pool(&pool, "run-1", |_| async { panic!("Must not cancel") })
                .await
                .unwrap();
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM run_events")
                    .fetch_one(&pool)
                    .await
                    .unwrap(),
                0
            );
        }
        let pool = fixture("failed").await;
        sqlx::query("UPDATE run_records SET runtime_json='{\"evaluationProfile\":{}}'")
            .execute(&pool)
            .await
            .unwrap();
        cancel_in_pool(&pool, "run-1", |_| async { panic!("Must not cancel fixtures") })
            .await
            .unwrap();
    }
    #[tokio::test]
    async fn stopping_queued_recovery_cancels_its_existing_remote_calls_once() {
        let pool = fixture("queued").await;
        let calls = Arc::new(Mutex::new(Vec::new()));
        let record = remote_tasks::list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        crate::module::run_history::cancel_queued_run_in_pool(&pool, "run-1")
            .await
            .unwrap();
        for _ in 0..2 {
            cancel_in_pool(&pool, "run-1", |id| {
                calls.lock().unwrap().push(id.clone());
                let mut record = record.clone();
                record.id = id;
                record.status = "canceled".into();
                async move { Ok(record) }
            })
            .await
            .unwrap();
        }
        assert_eq!(*calls.lock().unwrap(), vec!["input", "working"]);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM run_records WHERE id='run-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "cancelled"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT COUNT(*) FROM run_events WHERE json_extract(event_json,'$.data.status')='canceled'"
            )
            .fetch_one(&pool)
            .await
            .unwrap(),
            2
        );
        // If the queue worker already owns execution, Stop must use its active
        // cancellation token instead of overwriting that running record.
        sqlx::query("UPDATE run_records SET status='running' WHERE id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            crate::module::run_history::cancel_queued_run_in_pool(&pool, "run-1")
                .await
                .is_err()
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM run_records WHERE id='run-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "running"
        );
    }
}
