use adk_rust::tool::mcp::{McpToolset, rmcp};
use std::time::Duration;

pub(super) async fn shutdown_toolset<S>(toolset: &McpToolset<S>)
where
    S: rmcp::service::Service<rmcp::RoleClient> + Send + Sync + 'static,
{
    shutdown_with_timeout(toolset, Duration::from_secs(5)).await;
}

async fn shutdown_with_timeout<S>(toolset: &McpToolset<S>, grace: Duration)
where
    S: rmcp::service::Service<rmcp::RoleClient> + Send + Sync + 'static,
{
    // Remote cancellation needs the session alive; never let an unresponsive
    // server prevent shutdown, and never report an unconfirmed cancel as success.
    match tokio::time::timeout(grace, toolset.cancel_pending_tasks()).await {
        Ok(Ok(())) => {},
        Ok(Err(_)) => log::warn!("MCP remote task cancellation was not confirmed before closing the session"),
        Err(_) => log::warn!("MCP remote task cleanup timed out before closing the session"),
    }
    toolset.cancellation_token().await.cancel();
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::tool::mcp::McpTaskConfig;
    use rmcp::{RoleServer, ServerHandler, ServiceExt, model::*, service::RequestContext};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;

    struct TaskClient;
    impl rmcp::ClientHandler for TaskClient {
        fn get_info(&self) -> ClientConfig {
            ClientConfig::new(
                ClientCapabilities::builder().enable_tasks().build(),
                Implementation::new("shutdown-test", "1"),
            )
            .with_protocol_version(ProtocolVersion::V_2026_07_28)
        }
    }

    #[derive(Clone, Default)]
    struct TaskServer {
        polled: Arc<Notify>,
        cancels: Arc<AtomicUsize>,
        hang: bool,
    }

    impl ServerHandler for TaskServer {
        fn get_info(&self) -> ServerConfig {
            ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_tasks().build())
                .with_protocol_version(ProtocolVersion::V_2026_07_28)
        }
        async fn call_tool(
            &self,
            _: CallToolRequestParams,
            _: RequestContext<RoleServer>,
        ) -> Result<CallToolResponse, ErrorData> {
            let task = Task::new(
                "remote-task",
                TaskStatus::Working,
                "2026-10-12T00:00:00Z",
                "2026-10-12T00:00:00Z",
            );
            Ok(CreateTaskResult::new(task).into())
        }
        async fn get_task(
            &self,
            params: GetTaskParams,
            _: RequestContext<RoleServer>,
        ) -> Result<GetTaskResult, ErrorData> {
            self.polled.notify_one();
            if self.cancels.load(Ordering::SeqCst) > 0 && !self.hang {
                return Err(ErrorData::invalid_params("unknown task", None));
            }
            let task = Task::new(
                params.task_id,
                TaskStatus::Working,
                "2026-10-12T00:00:00Z",
                "2026-10-12T00:00:00Z",
            );
            Ok(GetTaskResult::new(DetailedTask::new(task, TaskPayload::Working {})))
        }
        async fn cancel_task(&self, _: CancelTaskParams, _: RequestContext<RoleServer>) -> Result<(), ErrorData> {
            self.cancels.fetch_add(1, Ordering::SeqCst);
            if self.hang {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
    }

    #[tokio::test]
    async fn shutdown_cancels_dropped_remote_calls_and_bounds_unresponsive_servers() {
        for hang in [false, true] {
            let server = TaskServer {
                hang,
                ..Default::default()
            };
            let (server_io, client_io) = tokio::io::duplex(4096);
            let peer = server.clone();
            let server_job = tokio::spawn(async move {
                let running = peer.serve(server_io).await.unwrap();
                let _ = running.waiting().await;
            });
            let client = TaskClient.serve(client_io).await.unwrap();
            let toolset = Arc::new(
                McpToolset::new(client)
                    .with_task_support(McpTaskConfig::enabled().poll_interval(Duration::from_millis(1))),
            );
            let caller = toolset.clone();
            let mut call = tokio::spawn(async move { caller.call_tool_value("work", Default::default()).await });
            tokio::select! {
                _ = server.polled.notified() => {},
                result = &mut call => panic!("task call ended before polling: {result:?}"),
                _ = tokio::time::sleep(Duration::from_secs(2)) => panic!("remote task was not polled"),
            }
            call.abort();
            let _ = call.await;
            tokio::time::timeout(
                Duration::from_secs(2),
                shutdown_with_timeout(&toolset, Duration::from_millis(50)),
            )
            .await
            .unwrap();
            tokio::time::timeout(Duration::from_secs(2), async {
                while !toolset.is_closed().await {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .unwrap();
            assert_eq!(server.cancels.load(Ordering::SeqCst), 1);
            server_job.abort();
        }
    }
}
