//! Standard A2A termination: query first, cancel once, then confirm by querying.
use super::{RemoteTaskOperation, remote_tasks};
use anyhow::Result;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::sync::atomic::{AtomicBool, Ordering};

static ACTIVE: AtomicBool = AtomicBool::new(false);
struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) {
        ACTIVE.store(false, Ordering::Release);
    }
}

/// Discover after terminal commit too, closing the crash window before enqueue.
/// Never retrospectively cancel legacy runs or tasks interrupted by app exit.
pub(crate) async fn enqueue(pool: &SqlitePool) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("INSERT OR IGNORE INTO remote_task_lifecycle (remote_record_id,run_id,next_check_at,updated_at) SELECT DISTINCT t.id,r.id,?,? FROM remote_tasks t JOIN run_records r ON (r.id=t.run_id OR EXISTS(SELECT 1 FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id WHERE o.adapter_record_id=t.id AND a.run_id=r.id)) WHERE r.target_type='workflow' AND r.status IN ('failed','cancelled') AND json_extract(r.runtime_json,'$.remoteLifecycleVersion')=1 AND json_extract(r.runtime_json,'$.evaluationProfile') IS NULL AND (t.status IN ('unknown','submitted','working','input_required','auth_required') OR (t.status='completed' AND t.result_json IS NULL)) AND NOT EXISTS(SELECT 1 FROM workflow_operations o WHERE o.adapter_record_id=t.id AND (o.purpose='compensation' OR o.confirmed_no_effect=1)) AND NOT EXISTS(SELECT 1 FROM workflow_operation_reviews v WHERE v.remote_record_id=t.id AND v.decision='no_effect') AND NOT EXISTS(SELECT 1 FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id JOIN run_records active ON active.id=a.run_id WHERE o.adapter_record_id=t.id AND active.status IN ('queued','running','waiting_for_input'))")
        .bind(&now).bind(&now).execute(pool).await?;
    Ok(())
}

pub(crate) async fn dispatch() -> Result<()> {
    let pool = crate::core::db::DBManager::global().pool()?;
    enqueue(&pool).await?;
    if ACTIVE.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    tokio::spawn(async move {
        let _guard = ActiveGuard;
        let result = async {
            let config = crate::config::BaseConfig::workrun().await.data_arc();
            process_next(&pool, |id, action| {
                let config = config.clone();
                async move { super::remote_agent::remote_task_operation(&id, action, &config).await }
            })
            .await
        }
        .await;
        if let Err(error) = result {
            log::warn!("remote task lifecycle: {error:#}");
        }
    });
    Ok(())
}

async fn process_next<F, Fut>(pool: &SqlitePool, mut call: F) -> Result<()>
where
    F: FnMut(String, RemoteTaskOperation) -> Fut,
    Fut: std::future::Future<Output = Result<remote_tasks::RemoteTaskRecord>>,
{
    let now = chrono::Utc::now();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT l.*,t.node_id,t.task_id,t.status AS remote_status FROM remote_task_lifecycle l JOIN remote_tasks t ON t.id=l.remote_record_id JOIN run_records r ON r.id=l.run_id WHERE l.status='pending' AND l.next_check_at<=? AND r.status IN ('failed','cancelled') ORDER BY l.next_check_at,l.remote_record_id LIMIT 1")
        .bind(now.to_rfc3339()).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(());
    };
    let id: String = row.get("remote_record_id");
    let run: String = row.get("run_id");
    let node: String = row.get("node_id");
    let cancel_attempted: bool = row.get("cancel_attempted");
    // Lease the network work without keeping a SQLite write transaction open.
    sqlx::query("UPDATE remote_task_lifecycle SET next_check_at=? WHERE remote_record_id=?")
        .bind((now + chrono::Duration::seconds(60)).to_rfc3339())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if row.get::<Option<String>, _>("task_id").is_none() {
        sqlx::query("UPDATE run_recovery_jobs SET status='blocked',last_error='Remote submission result unknown: no task ID; automatic resubmission disabled',updated_at=? WHERE run_id=? AND status='pending'")
            .bind(chrono::Utc::now().to_rfc3339()).bind(&run).execute(pool).await?;
        return message(pool, &run, &node, &id, "unknown", "blocked").await;
    }
    message(pool, &run, &node, &id, "querying", "pending").await?;
    let result = async {
        let mut record = call(id.clone(), RemoteTaskOperation::Query).await?;
        if matches!(
            record.status.as_str(),
            "unknown" | "submitted" | "working" | "input_required" | "auth_required"
        ) && !cancel_attempted
        {
            // Commit BEFORE network dispatch. Lost responses must never cause
            // automatic repeated cancellation; subsequent ticks only GetTask.
            sqlx::query("UPDATE remote_task_lifecycle SET cancel_attempted=1 WHERE remote_record_id=?")
                .bind(&id)
                .execute(pool)
                .await?;
            sqlx::query("UPDATE run_recovery_jobs SET status='blocked',last_error='Remote task termination has started; automatic forward recovery is disabled',updated_at=? WHERE run_id=? AND status='pending'")
                .bind(chrono::Utc::now().to_rfc3339()).bind(&run).execute(pool).await?;
            message(pool, &run, &node, &id, "cancel_requested", "pending").await?;
            record = call(id.clone(), RemoteTaskOperation::Cancel).await?;
        }
        if record.status == "completed" {
            record = call(id.clone(), RemoteTaskOperation::Fetch).await?;
            save_completed(pool, &run, &record).await?;
        }
        Ok::<_, anyhow::Error>(record)
    }
    .await;
    match result {
        Ok(record) => {
            let terminal = matches!(
                record.status.as_str(),
                "completed" | "failed" | "canceled" | "rejected" | "not_found"
            );
            message(
                pool,
                &run,
                &node,
                &id,
                &record.status,
                if terminal { "done" } else { "pending" },
            )
            .await?;
        },
        // Do not put endpoint or credential-bearing server errors in public events.
        Err(_) => message(pool, &run, &node, &id, "awaiting_confirmation", "pending").await?,
    }
    sqlx::query("UPDATE remote_task_lifecycle SET next_check_at=? WHERE remote_record_id=? AND status='pending'")
        .bind((chrono::Utc::now() + chrono::Duration::seconds(30)).to_rfc3339())
        .bind(&id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn save_completed(pool: &SqlitePool, run: &str, record: &remote_tasks::RemoteTaskRecord) -> Result<()> {
    let Some(mut result) = record.result.clone() else {
        anyhow::bail!("Completed remote result unavailable");
    };
    result["remoteTaskId"] = json!(record.task_id);
    result["messages"] = json!([{"role":"assistant","content":result["response"]}]);
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let operation: Option<String> = sqlx::query_scalar("SELECT id FROM workflow_operations WHERE adapter_record_id=? AND purpose='execution' AND status!='running' AND result_json IS NULL")
        .bind(&record.id).fetch_optional(&mut *tx).await?;
    if let Some(operation) = operation {
        let key = crate::utils::dirs::get_encryption_key()?;
        super::saga::capture_outcome(&mut tx, &key, &operation, &result).await?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE workflow_operations SET status='succeeded',result_json=?,updated_at=? WHERE id=?")
            .bind(result.to_string())
            .bind(&now)
            .bind(&operation)
            .execute(&mut *tx)
            .await?;
        sqlx::query("INSERT INTO workflow_operation_attempts (id,operation_id,run_id,sequence,action,status,started_at,ended_at) SELECT ?,?,?,COALESCE(MAX(sequence),0)+1,'reconcile','succeeded',?,? FROM workflow_operation_attempts WHERE operation_id=?")
            .bind(uuid::Uuid::new_v4().to_string()).bind(&operation).bind(run).bind(&now).bind(&now).bind(&operation).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn message(pool: &SqlitePool, run: &str, node: &str, id: &str, status: &str, job_status: &str) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let previous: Option<String> =
        sqlx::query_scalar("SELECT last_message FROM remote_task_lifecycle WHERE remote_record_id=?")
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
    sqlx::query("UPDATE remote_task_lifecycle SET status=?,last_message=?,updated_at=? WHERE remote_record_id=?")
        .bind(job_status)
        .bind(status)
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if previous.as_deref() == Some(status) {
        tx.commit().await?;
        return Ok(());
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
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    async fn fixture(task: bool, status: &str) -> (SqlitePool, String) {
        let pool = remote_tasks::test_pool().await;
        sqlx::query("CREATE TABLE run_events (run_id TEXT,sequence INTEGER,event_json TEXT,created_at TEXT,PRIMARY KEY(run_id,sequence))").execute(&pool).await.unwrap();
        sqlx::query("UPDATE run_records SET status=?,runtime_json='{\"remoteLifecycleVersion\":1}' WHERE id='run-1'")
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        let mut tracker = remote_tasks::RemoteTaskTracker::begin(
            pool.clone(),
            vec![42; 32],
            "run-1",
            "remote",
            "message",
            remote_tasks::RemoteConnection {
                service_url: "https://agent.example".into(),
                endpoint: "https://agent.example/rpc".into(),
                tenant: None,
                authentication: None,
                task_id: None,
            },
        )
        .await
        .unwrap();
        if task {
            tracker
                .observe(Some("task-1"), Some("TASK_STATE_WORKING"), Some("task-1".into()))
                .await
                .unwrap();
        }
        let id = tracker.id.clone();
        drop(tracker);
        tokio::task::yield_now().await;
        (pool, id)
    }

    async fn due(pool: &SqlitePool) {
        sqlx::query("UPDATE remote_task_lifecycle SET next_check_at='2000-01-01T00:00:00Z'")
            .execute(pool)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn cancellation_response_loss_only_queries_after_restart() {
        let (pool, id) = fixture(true, "failed").await;
        enqueue(&pool).await.unwrap();
        let calls = Arc::new(Mutex::new(Vec::new()));
        let record = remote_tasks::list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        process_next(&pool, |_, action| {
            calls.lock().unwrap().push(action);
            let record = record.clone();
            async move {
                if action == RemoteTaskOperation::Cancel {
                    anyhow::bail!("lost response");
                }
                Ok(record)
            }
        })
        .await
        .unwrap();
        due(&pool).await;
        // Re-discovery is idempotent and must retain the persisted cancel fence.
        enqueue(&pool).await.unwrap();
        process_next(&pool, |_, action| {
            calls.lock().unwrap().push(action);
            let mut record = record.clone();
            record.status = "canceled".into();
            async move { Ok(record) }
        })
        .await
        .unwrap();
        {
            let calls = calls.lock().unwrap();
            assert_eq!(calls.iter().filter(|a| **a == RemoteTaskOperation::Cancel).count(), 1);
            assert_eq!(calls.iter().filter(|a| **a == RemoteTaskOperation::Query).count(), 2);
        }
        let row = sqlx::query("SELECT status,cancel_attempted FROM remote_task_lifecycle WHERE remote_record_id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("status"), "done");
        assert_eq!(row.get::<i64, _>("cancel_attempted"), 1);
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM run_records WHERE id='run-1'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "failed"
        );
        let event: String = sqlx::query_scalar("SELECT event_json FROM run_events ORDER BY sequence DESC LIMIT 1")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event).unwrap()["data"]["status"],
            "canceled"
        );
    }

    #[tokio::test]
    async fn unknown_without_task_id_never_sends_and_completed_is_fetched_not_canceled() {
        let (pool, _) = fixture(false, "cancelled").await;
        enqueue(&pool).await.unwrap();
        process_next(&pool, |_, _| async {
            panic!("Unknown submission must not be sent again")
        })
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM remote_task_lifecycle")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "blocked"
        );
        let (pool, _) = fixture(true, "failed").await;
        enqueue(&pool).await.unwrap();
        let mut record = remote_tasks::list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        record.status = "completed".into();
        record.result = Some(json!({"response":"Saved answer","artifacts":[]}));
        let actions = Arc::new(Mutex::new(Vec::new()));
        process_next(&pool, |_, action| {
            actions.lock().unwrap().push(action);
            let record = record.clone();
            async move { Ok(record) }
        })
        .await
        .unwrap();
        {
            let actions = actions.lock().unwrap();
            assert!(actions.as_slice() == [RemoteTaskOperation::Query, RemoteTaskOperation::Fetch]);
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM remote_task_lifecycle")
                .fetch_one(&pool)
                .await
                .unwrap(),
            "done"
        );
    }

    #[tokio::test]
    async fn startup_only_discovers_failed_or_stopped_new_runs() {
        for status in ["failed", "cancelled", "interrupted", "completed", "running"] {
            let (pool, _) = fixture(true, status).await;
            enqueue(&pool).await.unwrap();
            enqueue(&pool).await.unwrap();
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM remote_task_lifecycle")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(count, i64::from(matches!(status, "failed" | "cancelled")));
        }
        let (pool, _) = fixture(true, "failed").await;
        sqlx::query("UPDATE run_records SET runtime_json='{}'")
            .execute(&pool)
            .await
            .unwrap();
        enqueue(&pool).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM remote_task_lifecycle")
                .fetch_one(&pool)
                .await
                .unwrap(),
            0
        );
    }

    #[tokio::test]
    async fn pending_termination_fences_recovery_and_one_unreachable_task_does_not_starve_others() {
        let (pool, _) = fixture(true, "failed").await;
        sqlx::query("INSERT INTO remote_tasks (id,run_id,node_id,message_id,service_origin,connection_ciphertext,task_id,status,created_at,updated_at) SELECT 'remote-2',run_id,node_id,'message-2',service_origin,connection_ciphertext,'task-2',status,created_at,updated_at FROM remote_tasks")
            .execute(&pool).await.unwrap();
        enqueue(&pool).await.unwrap();
        let mut tx = pool.begin().await.unwrap();
        assert!(
            super::super::saga_scheduler::ensure_continuable(&mut tx, "run-1")
                .await
                .is_err()
        );
        tx.rollback().await.unwrap();
        process_next(&pool, |_, _| async { anyhow::bail!("offline") })
            .await
            .unwrap();
        let row = sqlx::query(
            "SELECT status,next_check_at FROM remote_task_lifecycle WHERE last_message='awaiting_confirmation'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>("status"), "pending");
        assert!(row.get::<String, _>("next_check_at") > chrono::Utc::now().to_rfc3339());
        let record = remote_tasks::list_remote_tasks(&pool, "run-1").await.unwrap().remove(0);
        process_next(&pool, |id, action| {
            assert!(action == RemoteTaskOperation::Query);
            let mut record = record.clone();
            record.id = id;
            record.status = "canceled".into();
            async move { Ok(record) }
        })
        .await
        .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM remote_task_lifecycle WHERE status='done'")
                .fetch_one(&pool)
                .await
                .unwrap(),
            1
        );
    }
}
