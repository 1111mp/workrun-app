//! Application-wide local IPC transport for SDK and extension processes.

use crate::{
    core::handle,
    logging, singleton,
    utils::{dirs, logging::Type},
};
use anyhow::{Context, Result, bail};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Emitter as _;
use tokio::sync::{Mutex, mpsc};
use uuid::Uuid;

const IPC_EVENT_MESSAGE: &str = "ipc-message";
const MAX_MESSAGE_SIZE: usize = 1_048_576;

#[cfg(unix)]
type IpcWriter = Arc<Mutex<tokio::net::unix::OwnedWriteHalf>>;
#[cfg(windows)]
type IpcWriter = Arc<Mutex<tokio::io::WriteHalf<tokio::net::windows::named_pipe::NamedPipeServer>>>;

/// A capability-scoped connection credential for one locally launched client.
#[derive(Debug)]
pub struct IpcSession {
    pub id: String,
    pub token: String,
    pub endpoint: String,
    receiver: mpsc::Receiver<Value>,
    sessions: Arc<Mutex<HashMap<String, IpcSessionEntry>>>,
    #[cfg(any(unix, windows))]
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
}

#[derive(Debug)]
struct IpcSessionEntry {
    token: String,
    messages: mpsc::Sender<Value>,
}

impl IpcSession {
    pub async fn close(self) {
        self.sessions.lock().await.remove(&self.id);
        #[cfg(any(unix, windows))]
        self.connections.lock().await.remove(&self.id);
    }

    pub fn try_receive(&mut self) -> Option<Value> {
        self.receiver.try_recv().ok()
    }
}

/// An authenticated message received from a local IPC client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IpcMessageEvent {
    session_id: String,
    message: Value,
}

/// Cross-process local transport owned by the desktop application lifecycle.
pub struct IpcServer {
    endpoint: OnceLock<String>,
    sessions: Arc<Mutex<HashMap<String, IpcSessionEntry>>>,
    #[cfg(any(unix, windows))]
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
    started: AtomicBool,
    start_lock: Mutex<()>,
}

singleton!(IpcServer, IPC_SERVER);

impl IpcServer {
    fn new() -> Self {
        Self {
            endpoint: OnceLock::new(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(any(unix, windows))]
            connections: Arc::new(Mutex::new(HashMap::new())),
            started: AtomicBool::new(false),
            start_lock: Mutex::new(()),
        }
    }

    /// Start the shared listener during desktop application initialization.
    #[cfg(unix)]
    pub async fn start(&self) -> Result<()> {
        use tokio::net::UnixListener;

        let _start_guard = self.start_lock.lock().await;
        if self.started.load(Ordering::Acquire) {
            return Ok(());
        }

        let path = dirs::runtime_dir()?.join("ipc.sock");
        if path.exists() {
            tokio::fs::remove_file(&path)
                .await
                .with_context(|| format!("failed to remove stale IPC socket {}", path.display()))?;
        }

        let listener =
            UnixListener::bind(&path).with_context(|| format!("failed to bind IPC socket {}", path.display()))?;
        self.endpoint
            .set(path.to_string_lossy().into_owned())
            .expect("IPC endpoint must only be initialized once");
        let sessions = Arc::clone(&self.sessions);
        let connections = Arc::clone(&self.connections);

        logging!(info, Type::IpcServer, "Listening on {}", path.display());

        tokio::spawn(async move {
            loop {
                let stream = match listener.accept().await {
                    Ok((stream, _)) => stream,
                    Err(error) => {
                        logging!(error, Type::IpcServer, "Listener accept failed: {error}");
                        break;
                    },
                };
                let sessions = Arc::clone(&sessions);
                let connections = Arc::clone(&connections);
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, sessions, connections).await {
                        logging!(warn, Type::IpcServer, "Client connection closed: {error}");
                    }
                });
            }
        });

        self.started.store(true, Ordering::Release);
        Ok(())
    }

    /// Start the Windows named-pipe listener.
    #[cfg(windows)]
    pub async fn start(&self) -> Result<()> {
        use tokio::net::windows::named_pipe::ServerOptions;

        let _start_guard = self.start_lock.lock().await;
        if self.started.load(Ordering::Acquire) {
            return Ok(());
        }

        let pipe_name = format!(r"\\.\pipe\workrun-ipc-{}", std::process::id());
        let mut listener = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .with_context(|| format!("failed to create IPC named pipe {pipe_name}"))?;
        self.endpoint
            .set(pipe_name.clone())
            .expect("IPC endpoint must only be initialized once");
        let sessions = Arc::clone(&self.sessions);
        let connections = Arc::clone(&self.connections);

        logging!(info, Type::IpcServer, "Listening on {pipe_name}");

        tokio::spawn(async move {
            loop {
                if let Err(error) = listener.connect().await {
                    logging!(error, Type::IpcServer, "Listener accept failed: {error}");
                    break;
                }
                let stream = listener;
                listener = match ServerOptions::new().create(&pipe_name) {
                    Ok(listener) => listener,
                    Err(error) => {
                        logging!(error, Type::IpcServer, "Failed to create next pipe instance: {error}");
                        break;
                    },
                };
                let sessions = Arc::clone(&sessions);
                let connections = Arc::clone(&connections);
                tokio::spawn(async move {
                    if let Err(error) = handle_connection(stream, sessions, connections).await {
                        logging!(warn, Type::IpcServer, "Client connection closed: {error}");
                    }
                });
            }
        });

        self.started.store(true, Ordering::Release);
        Ok(())
    }

    /// Allocate credentials for one client before it is launched.
    pub async fn create_session(&self) -> Result<IpcSession> {
        if !self.started.load(Ordering::Acquire) {
            bail!("IPC server has not been started")
        }
        let id = Uuid::new_v4().to_string();
        let token = Uuid::new_v4().to_string();
        let (messages, receiver) = mpsc::channel(16);
        self.sessions.lock().await.insert(
            id.clone(),
            IpcSessionEntry {
                token: token.clone(),
                messages,
            },
        );
        let endpoint = self
            .endpoint
            .get()
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("IPC server started without an endpoint"))?;

        Ok(IpcSession {
            id,
            token,
            endpoint,
            receiver,
            sessions: Arc::clone(&self.sessions),
            #[cfg(any(unix, windows))]
            connections: Arc::clone(&self.connections),
        })
    }

    #[cfg(any(unix, windows))]
    pub async fn send(&self, session_id: &str, message: Value) -> Result<()> {
        let connection = self
            .connections
            .lock()
            .await
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("no active IPC connection for run {session_id}"))?;
        let mut writer = connection.lock().await;
        send_message(&mut *writer, &message).await
    }

    #[cfg(not(any(unix, windows)))]
    pub async fn send(&self, _session_id: &str, _message: Value) -> Result<()> {
        bail!("Windows named-pipe IPC is not available yet")
    }
}

#[cfg(windows)]
async fn handle_connection(
    mut stream: tokio::net::windows::named_pipe::NamedPipeServer,
    sessions: Arc<Mutex<HashMap<String, IpcSessionEntry>>>,
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
) -> Result<()> {
    let hello = receive_message(&mut stream).await?;
    let (session_id, message_sender) = authenticate_hello(&hello, &sessions).await?;
    let (reader, writer) = tokio::io::split(stream);
    connections
        .lock()
        .await
        .insert(session_id.clone(), Arc::new(Mutex::new(writer)));
    handle_messages(reader, session_id, message_sender, connections).await
}

#[cfg(unix)]
async fn handle_connection(
    mut stream: tokio::net::UnixStream,
    sessions: Arc<Mutex<HashMap<String, IpcSessionEntry>>>,
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
) -> Result<()> {
    let hello = receive_message(&mut stream).await?;
    let (session_id, message_sender) = authenticate_hello(&hello, &sessions).await?;

    let (mut reader, writer) = stream.into_split();
    connections
        .lock()
        .await
        .insert(session_id.clone(), Arc::new(Mutex::new(writer)));

    handle_messages(&mut reader, session_id, message_sender, connections).await
}

#[cfg(any(unix, windows))]
async fn authenticate_hello(
    hello: &Value,
    sessions: &Arc<Mutex<HashMap<String, IpcSessionEntry>>>,
) -> Result<(String, mpsc::Sender<Value>)> {
    let session_id = required_string(hello, "runId")?;
    let token = required_string(hello, "token")?;
    if hello.get("type") != Some(&Value::String("hello".into())) {
        bail!("first IPC message must be hello");
    }
    let message_sender = sessions
        .lock()
        .await
        .get(&session_id)
        .filter(|entry| entry.token == token)
        .map(|entry| entry.messages.clone())
        .ok_or_else(|| anyhow::anyhow!("IPC hello did not match an active session"))?;
    Ok((session_id, message_sender))
}

#[cfg(any(unix, windows))]
async fn handle_messages<R>(
    mut reader: R,
    session_id: String,
    message_sender: mpsc::Sender<Value>,
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let app_handle = handle::Handle::app_handle();
    while let Ok(message) = receive_message(&mut reader).await {
        // A run owner can await structured messages (such as process.result)
        // while the webview continues to receive the same event for UI work.
        let _ = message_sender.try_send(message.clone());
        if message.get("type").and_then(Value::as_str) == Some("process.result") {
            let id = required_string(&message, "id")?;
            IpcServer::global()
                .send(
                    &session_id,
                    serde_json::json!({ "id": id, "type": "process.result.accepted" }),
                )
                .await?;
        }
        app_handle
            .emit(
                IPC_EVENT_MESSAGE,
                IpcMessageEvent {
                    session_id: session_id.clone(),
                    message,
                },
            )
            .context("failed to emit IPC message")?;
    }
    connections.lock().await.remove(&session_id);
    Ok(())
}

#[cfg(any(unix, windows))]
async fn receive_message<R>(stream: &mut R) -> Result<Value>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt as _;

    let size = stream.read_u32().await? as usize;
    if size > MAX_MESSAGE_SIZE {
        bail!("IPC message exceeds {MAX_MESSAGE_SIZE} bytes");
    }
    let mut payload = vec![0_u8; size];
    stream.read_exact(&mut payload).await?;
    serde_json::from_slice(&payload).context("IPC peer sent invalid JSON")
}

#[cfg(any(unix, windows))]
async fn send_message<W>(stream: &mut W, message: &Value) -> Result<()>
where
    W: tokio::io::AsyncWrite + Unpin,
{
    use tokio::io::AsyncWriteExt as _;

    let payload = serde_json::to_vec(message).context("IPC message is not JSON serializable")?;
    if payload.len() > MAX_MESSAGE_SIZE {
        bail!("IPC message exceeds {MAX_MESSAGE_SIZE} bytes");
    }
    stream.write_u32(payload.len() as u32).await?;
    stream.write_all(&payload).await?;
    stream.flush().await?;
    Ok(())
}

#[cfg(any(unix, windows))]
fn required_string(message: &Value, field: &str) -> Result<String> {
    message
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("IPC message is missing string field {field}"))
}
