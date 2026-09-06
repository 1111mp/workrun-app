use super::events::terminate_process_tree;
use super::workflow::workflow_session_from_runtime;

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::terminate_process_tree;
    use super::workflow_session_from_runtime;
    use serde_json::json;

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
