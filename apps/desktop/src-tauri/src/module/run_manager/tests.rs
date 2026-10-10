#[allow(unused)]
use super::events::terminate_process_tree;
use super::workflow::workflow_session_from_runtime;
use super::{supervisor_deadline_in_pool, workflow_module};

#[cfg(test)]
mod test_cases {
    #[cfg(unix)]
    use super::terminate_process_tree;
    use super::workflow_session_from_runtime;
    use serde_json::json;

    #[tokio::test]
    async fn waiting_compensations_leave_normal_execution_capacity_available() {
        let supervisor = super::super::RunSupervisor::new();
        let mut monitors = Vec::new();
        for _ in 0..super::super::MAX_CONCURRENT_TOP_LEVEL_RUNS {
            monitors.push(supervisor.compensation_permits.clone().try_acquire_owned().unwrap());
        }
        assert!(supervisor.compensation_permits.clone().try_acquire_owned().is_err());
        let execution = supervisor.permits.clone().try_acquire_owned().unwrap();
        drop(execution);
        supervisor.shutdown().await;
        assert!(supervisor.permits.clone().acquire_owned().await.is_err());
        // Shutdown must also wake a supervisor that has not entered its wait yet.
        tokio::time::timeout(std::time::Duration::from_millis(100), supervisor.wake.notified())
            .await
            .unwrap();
    }

    #[test]
    fn rehydrates_a_paused_workflow_session_from_durable_runtime() {
        let session = workflow_session_from_runtime(&json!({
            "kind": "workflow",
            "dsl": { "id": "workflow-1" },
            "threadId": "thread-1",
            "initialState": { "input": "hello" },
        }))
        .unwrap();

        assert_eq!(session.thread_id, "thread-1");
        assert_eq!(session.initial_state, json!({ "input": "hello" }));
    }

    #[test]
    fn rejects_runtime_without_the_state_needed_to_resume() {
        let error = workflow_session_from_runtime(&json!({
            "kind": "workflow",
            "dsl": {},
            "threadId": "thread-1",
        }))
        .unwrap_err();

        assert!(error.to_string().contains("initial state"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_signal_reaches_a_spawned_child_process() {
        use tokio::io::{AsyncBufReadExt as _, BufReader};

        let mut command = tokio::process::Command::new("sh");
        command
            .arg("-c")
            // Keep the shell alive as the group leader while its child is
            // running; this matches an App process that spawns a worker.
            .arg("sleep 30 & echo $!; wait")
            .stdout(std::process::Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setpgid(0, 0) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let mut parent = command.spawn().unwrap();
        let parent_pid = parent.id().unwrap();
        let stdout = parent.stdout.take().unwrap();
        let mut lines = BufReader::new(stdout).lines();
        let child_pid: i32 = lines.next_line().await.unwrap().unwrap().parse().unwrap();

        terminate_process_tree(parent_pid, false);
        let exited = tokio::time::timeout(std::time::Duration::from_secs(3), parent.wait()).await;
        if exited.is_err() {
            terminate_process_tree(parent_pid, true);
        }
        assert!(exited.is_ok(), "parent process did not exit after SIGTERM");

        for _ in 0..30 {
            let alive = unsafe { libc::kill(child_pid, 0) } == 0;
            if !alive {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        panic!("spawned child {child_pid} survived process-group cancellation");
    }
}

#[tokio::test]
async fn supervisor_waits_for_work_and_skips_plans_waiting_for_execution() {
    let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::raw_sql(
        "CREATE TABLE run_records(id TEXT,status TEXT,workspace_id TEXT);
        CREATE TABLE run_recovery_jobs(run_id TEXT,status TEXT,attempts INTEGER,next_check_at TEXT);
        CREATE TABLE workflow_abandonments(run_id TEXT,status TEXT,last_error TEXT,next_check_at TEXT,requested_at TEXT,updated_at TEXT);",
    )
    .execute(&pool)
    .await
    .unwrap();
    assert!(supervisor_deadline_in_pool(&pool, true).await.unwrap().is_none());
    sqlx::raw_sql("INSERT INTO run_records VALUES ('run','running','personal');
        INSERT INTO workflow_abandonments(run_id,status,last_error,next_check_at) VALUES ('run','pending','Waiting for original execution to stop','2000-01-01T00:00:00Z');")
        .execute(&pool).await.unwrap();
    assert!(supervisor_deadline_in_pool(&pool, true).await.unwrap().is_none());
    assert!(workflow_module::saga_scheduler::claim(&pool).await.unwrap().is_none());
    sqlx::query("UPDATE run_records SET status='cancelled'")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        supervisor_deadline_in_pool(&pool, true).await.unwrap().as_deref(),
        Some("2000-01-01T00:00:00Z")
    );
    assert!(supervisor_deadline_in_pool(&pool, false).await.unwrap().is_none());
    sqlx::query("UPDATE workflow_abandonments SET last_error=NULL")
        .execute(&pool)
        .await
        .unwrap();
    assert!(supervisor_deadline_in_pool(&pool, true).await.unwrap().is_some());
}
