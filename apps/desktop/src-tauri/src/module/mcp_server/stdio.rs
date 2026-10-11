//! Stdio lifecycle driven by transport closure rather than periodic health queries.
use super::{McpServerRuntimeStore, notify_changed, stdio_restart_policy};
use crate::config::IMcpServer;
use adk_rust::{
    ReadonlyContext,
    tool::{
        Tool, Toolset,
        mcp::{
            AdkClientHandler, AutoDeclineElicitationHandler, McpToolset, ServerStatus,
            rmcp::{
                self,
                service::{RxJsonRpcMessage, TxJsonRpcMessage},
                transport::{TokioChildProcess, Transport},
            },
        },
    },
};
use anyhow::{Context, Result};
use std::{sync::Arc, time::Duration};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;

type StdioToolset = McpToolset<AdkClientHandler>;

struct ObservedTransport {
    inner: TokioChildProcess,
    closed: CancellationToken,
}

impl Drop for ObservedTransport {
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

impl Transport<rmcp::RoleClient> for ObservedTransport {
    type Error = std::io::Error;
    fn send(
        &mut self,
        item: TxJsonRpcMessage<rmcp::RoleClient>,
    ) -> impl Future<Output = std::io::Result<()>> + Send + 'static {
        self.inner.send(item)
    }
    async fn receive(&mut self) -> Option<RxJsonRpcMessage<rmcp::RoleClient>> {
        let message = self.inner.receive().await;
        if message.is_none() {
            self.closed.cancel();
        }
        message
    }
    async fn close(&mut self) -> std::io::Result<()> {
        self.closed.cancel();
        self.inner.close().await
    }
}

pub(super) struct StdioRuntime {
    definition: IMcpServer,
    state: RwLock<(ServerStatus, Option<Arc<StdioToolset>>)>,
    lifecycle: Mutex<()>,
    stop: CancellationToken,
}

impl StdioRuntime {
    pub(super) fn new(definition: IMcpServer) -> Arc<Self> {
        Arc::new(Self {
            definition,
            state: RwLock::new((ServerStatus::Stopped, None)),
            lifecycle: Mutex::new(()),
            stop: CancellationToken::new(),
        })
    }

    async fn connect(&self) -> Result<(Arc<StdioToolset>, CancellationToken)> {
        let mut command = tokio::process::Command::new(&self.definition.command);
        command.args(&self.definition.args).envs(&self.definition.env);
        let closed = CancellationToken::new();
        let transport = ObservedTransport {
            inner: TokioChildProcess::new(command)?,
            closed: closed.clone(),
        };
        let toolset = tokio::time::timeout(
            Duration::from_secs(30),
            McpToolset::with_elicitation_handler(transport, Arc::new(AutoDeclineElicitationHandler)),
        )
        .await
        .context("MCP connection timed out after 30 seconds")??;
        Ok((Arc::new(toolset), closed))
    }

    async fn connected(&self, toolset: Arc<StdioToolset>) {
        *self.state.write().await = (ServerStatus::Running, Some(toolset));
        McpServerRuntimeStore::global().record_health_success(&self.definition.id, None);
    }

    pub(super) async fn start(self: &Arc<Self>) -> Result<()> {
        let _guard = self.lifecycle.lock().await;
        if self.status().await == ServerStatus::Running {
            return Ok(());
        }
        anyhow::ensure!(
            !matches!(self.status().await, ServerStatus::Crashed | ServerStatus::Restarting),
            "MCP server is reconnecting"
        );
        anyhow::ensure!(!self.stop.is_cancelled(), "MCP runtime has been stopped");
        let (toolset, closed) = match self.connect().await {
            Ok(connection) => connection,
            Err(error) => {
                self.state.write().await.0 = ServerStatus::FailedToStart;
                notify_changed();
                return Err(error);
            },
        };
        if self.stop.is_cancelled() {
            toolset.cancellation_token().await.cancel();
            anyhow::bail!("MCP runtime has been stopped");
        }
        self.connected(toolset).await;
        let runtime = Arc::clone(self);
        tokio::spawn(async move {
            runtime.monitor(closed).await;
        });
        Ok(())
    }

    async fn monitor(self: Arc<Self>, mut closed: CancellationToken) {
        let policy = stdio_restart_policy();
        let mut attempts = 0;
        let mut connected_at = tokio::time::Instant::now();
        loop {
            tokio::select! {
                _ = self.stop.cancelled() => return,
                _ = closed.cancelled() => {},
            }
            let guard = self.lifecycle.lock().await;
            if self.stop.is_cancelled() {
                return;
            }
            *self.state.write().await = (ServerStatus::Crashed, None);
            McpServerRuntimeStore::global().record_health_error(
                &self.definition.id,
                "MCP connection closed; automatic restart is pending".into(),
            );
            drop(guard);
            if connected_at.elapsed() >= Duration::from_secs(10) {
                attempts = 0;
            }
            let mut connection = None;
            while attempts < policy.max_restart_attempts {
                let attempt = attempts;
                attempts += 1;
                let delay = (policy.initial_delay_ms as f64 * policy.backoff_multiplier.powi(attempt as i32))
                    .min(policy.max_delay_ms as f64);
                self.state.write().await.0 = ServerStatus::Restarting;
                notify_changed();
                // Backoff runs only after a disconnect; no idle status checks.
                tokio::select! {
                    _ = self.stop.cancelled() => return,
                    _ = tokio::time::sleep(Duration::from_millis(delay as u64)) => {},
                }
                let _guard = self.lifecycle.lock().await;
                let result = tokio::select! {
                    _ = self.stop.cancelled() => return,
                    result = self.connect() => result,
                };
                match result {
                    Ok((toolset, next_closed)) => {
                        // Publish while holding the lifecycle lock, so shutdown
                        // cannot be overwritten by a late successful reconnect.
                        if self.stop.is_cancelled() {
                            toolset.cancellation_token().await.cancel();
                            return;
                        }
                        self.connected(toolset).await;
                        connection = Some(next_closed);
                        break;
                    },
                    Err(error) => {
                        McpServerRuntimeStore::global().record_health_error(&self.definition.id, error.to_string())
                    },
                }
            }
            if let Some(next_closed) = connection {
                closed = next_closed;
                connected_at = tokio::time::Instant::now();
            } else {
                let _guard = self.lifecycle.lock().await;
                if self.stop.is_cancelled() {
                    return;
                }
                self.state.write().await.0 = ServerStatus::FailedToStart;
                notify_changed();
                return;
            }
        }
    }

    pub(super) async fn status(&self) -> ServerStatus {
        self.state.read().await.0
    }

    pub(super) async fn tools(&self, context: Arc<dyn ReadonlyContext>) -> Result<Vec<Arc<dyn Tool>>> {
        let toolset = self.state.read().await.1.clone().context("MCP server is not running")?;
        Ok(toolset.tools(context).await?)
    }

    pub(super) async fn shutdown(&self) {
        self.stop.cancel();
        let _guard = self.lifecycle.lock().await;
        let toolset = self.state.write().await.1.take();
        if let Some(toolset) = toolset {
            toolset.cancellation_token().await.cancel();
        }
        self.state.write().await.0 = ServerStatus::Stopped;
        notify_changed();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    // A real stdio peer verifies RMCP closure reaches the lifecycle monitor,
    // rather than testing the transport token in isolation.
    #[tokio::test]
    async fn process_disconnect_restarts_and_shutdown_stops_reconnects() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("server.py");
        let starts = dir.path().join("starts");
        std::fs::write(&script, r#"
import json, os, pathlib, sys
starts = pathlib.Path(sys.argv[1])
count = int(starts.read_text()) + 1 if starts.exists() else 1
starts.write_text(str(count))
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {'protocolVersion': request['params']['protocolVersion'], 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'lifecycle-test', 'version': '1'}}
    elif method == 'tools/list':
        if count == 1:
            os._exit(1)
        result = {'tools': []}
    else:
        raise RuntimeError('Unexpected request: ' + method)
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': result}), flush=True)
"#).unwrap();
        let definition = IMcpServer {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Lifecycle test".into(),
            description: String::new(),
            transport: super::super::McpServerTransport::Stdio,
            command: "python3".into(),
            args: vec![
                "-u".into(),
                script.to_string_lossy().into(),
                starts.to_string_lossy().into(),
            ],
            env: Default::default(),
            url: String::new(),
            auth: super::super::McpServerAuth::None,
            bearer_token: None,
            oauth_credentials: None,
            enabled: true,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let runtime = StdioRuntime::new(definition);
        runtime.start().await.unwrap();
        assert_eq!(runtime.status().await, ServerStatus::Running);
        let context: Arc<dyn ReadonlyContext> = Arc::new(adk_rust::tool::SimpleToolContext::new("lifecycle-test"));
        assert!(runtime.tools(context.clone()).await.is_err());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if runtime.status().await == ServerStatus::Restarting {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(
            McpServerRuntimeStore::global()
                .health(&runtime.definition.id)
                .last_error
                .is_some()
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if runtime.status().await == ServerStatus::Running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(runtime.tools(context).await.unwrap().is_empty());
        assert!(
            McpServerRuntimeStore::global()
                .health(&runtime.definition.id)
                .last_error
                .is_none()
        );
        assert_eq!(std::fs::read_to_string(&starts).unwrap(), "2");
        runtime.shutdown().await;
        tokio::time::sleep(Duration::from_millis(2200)).await;
        assert_eq!(runtime.status().await, ServerStatus::Stopped);
        assert_eq!(std::fs::read_to_string(&starts).unwrap(), "2");
    }

    #[tokio::test]
    async fn transport_eof_and_drop_signal_disconnection() {
        let closed = CancellationToken::new();
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "exit 0"]);
        let mut transport = ObservedTransport {
            inner: TokioChildProcess::new(command).unwrap(),
            closed: closed.clone(),
        };
        assert!(
            tokio::time::timeout(Duration::from_secs(2), transport.receive())
                .await
                .unwrap()
                .is_none()
        );
        assert!(closed.is_cancelled());
        let closed = CancellationToken::new();
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "cat"]);
        let transport = ObservedTransport {
            inner: TokioChildProcess::new(command).unwrap(),
            closed: closed.clone(),
        };
        drop(transport);
        assert!(closed.is_cancelled());
    }
}
