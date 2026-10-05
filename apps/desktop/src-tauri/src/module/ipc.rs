//! Application-wide local IPC transport for SDK and extension processes.

#[cfg(unix)]
use crate::utils::dirs;
use crate::{core::handle, logging, singleton, utils::logging::Type};
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
    closed: bool,
}

#[derive(Debug)]
struct IpcSessionEntry {
    token: String,
    messages: mpsc::Sender<Value>,
    artifacts: Option<ArtifactAccess>,
}

#[derive(Debug, Clone)]
struct ArtifactAccess {
    store: crate::module::artifact::ArtifactStore,
    references: Vec<crate::module::artifact::ArtifactRef>,
    copies: Arc<tempfile::TempDir>,
}

impl ArtifactAccess {
    fn allows(&self, reference: &crate::module::artifact::ArtifactRef) -> bool {
        self.references.iter().any(|allowed| {
            allowed.id == reference.id
                && allowed.version == reference.version
                && allowed.size == reference.size
                && allowed.mime_type == reference.mime_type
                && allowed.kind == reference.kind
        })
    }
}

impl IpcSession {
    pub async fn grant_artifacts(&self, input: &Value) -> Result<()> {
        let access = ArtifactAccess {
            store: crate::module::artifact::ArtifactStore::active()?,
            references: crate::module::artifact::references(input)?,
            copies: Arc::new(tempfile::tempdir()?),
        };
        self.sessions
            .lock()
            .await
            .get_mut(&self.id)
            .context("IPC session has closed")?
            .artifacts = Some(access);
        Ok(())
    }

    pub async fn validate_artifact_result(&self, value: &Value) -> Result<()> {
        let references = crate::module::artifact::references(value)?;
        let sessions = self.sessions.lock().await;
        let access = sessions
            .get(&self.id)
            .and_then(|entry| entry.artifacts.as_ref())
            .context("IPC resource access is missing")?;
        for reference in references {
            if !access.allows(&reference) {
                bail!("Process returned an unauthorized resource");
            }
        }
        Ok(())
    }

    pub async fn close(mut self) {
        self.sessions.lock().await.remove(&self.id);
        #[cfg(any(unix, windows))]
        self.connections.lock().await.remove(&self.id);
        self.closed = true;
        publish_session_closed(self.id.clone());
    }

    pub fn try_receive(&mut self) -> Option<Value> {
        self.receiver.try_recv().ok()
    }
}

impl Drop for IpcSession {
    fn drop(&mut self) {
        if self.closed {
            return;
        }
        // Workflow cancellation drops its App future without reaching close().
        // Revoke its credentials and discard any forms still queued in the UI.
        let id = self.id.clone();
        let sessions = Arc::clone(&self.sessions);
        #[cfg(any(unix, windows))]
        let connections = Arc::clone(&self.connections);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                sessions.lock().await.remove(&id);
                #[cfg(any(unix, windows))]
                connections.lock().await.remove(&id);
                publish_session_closed(id);
            });
        }
    }
}

fn publish_session_closed(session_id: String) {
    let Some(app) = crate::APP_HANDLE.get() else {
        return;
    };
    let emit_app = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = emit_app.emit("ipc-session-closed", serde_json::json!({"sessionId": session_id})) {
            log::warn!("failed to emit IPC session closure: {error}");
        }
    }) {
        log::warn!("failed to schedule IPC session closure: {error}");
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
                artifacts: None,
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
            closed: false,
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
    let writer = Arc::new(Mutex::new(writer));
    register_connection(&session_id, Arc::clone(&writer), &connections).await?;
    handle_messages(reader, session_id, message_sender, writer, connections).await
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
    let writer = Arc::new(Mutex::new(writer));
    register_connection(&session_id, Arc::clone(&writer), &connections).await?;

    handle_messages(&mut reader, session_id, message_sender, writer, connections).await
}

#[cfg(any(unix, windows))]
async fn register_connection(
    session_id: &str,
    writer: IpcWriter,
    connections: &Arc<Mutex<HashMap<String, IpcWriter>>>,
) -> Result<()> {
    let mut connections = connections.lock().await;
    if connections.contains_key(session_id) {
        bail!("IPC session already has an active connection: {session_id}");
    }
    connections.insert(session_id.to_owned(), writer);
    Ok(())
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
    writer: IpcWriter,
    connections: Arc<Mutex<HashMap<String, IpcWriter>>>,
) -> Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let app_handle = handle::Handle::app_handle();
    let result = async {
        while let Ok(message) = receive_message(&mut reader).await {
            if message
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind.starts_with("artifact."))
            {
                let id = required_string(&message, "id")?;
                let response = artifact_request(&session_id, &message).await;
                let response = match response {
                    Ok(data) => serde_json::json!({"id": id, "type": "artifact.response", "data": data}),
                    Err(error) => serde_json::json!({"id": id, "type": "artifact.error", "error": error.to_string()}),
                };
                IpcServer::global().send(&session_id, response).await?;
                continue;
            }
            // A run owner can await structured messages (such as process.result)
            // while the webview continues to receive the same event for UI work.
            enqueue_result(&message_sender, &message)?;
            if matches!(
                message.get("type").and_then(Value::as_str),
                Some("process.result") | Some("tool.result")
            ) {
                let id = required_string(&message, "id")?;
                let accepted_type = format!(
                    "{}.accepted",
                    message.get("type").and_then(Value::as_str).expect("matched type")
                );
                IpcServer::global()
                    .send(&session_id, serde_json::json!({ "id": id, "type": accepted_type }))
                    .await?;
            }
            let emit_app = app_handle.clone();
            let emit_session_id = session_id.clone();
            app_handle
                .run_on_main_thread(move || {
                    if let Err(error) = emit_app.emit(
                        IPC_EVENT_MESSAGE,
                        IpcMessageEvent {
                            session_id: emit_session_id,
                            message,
                        },
                    ) {
                        log::warn!("failed to emit IPC message: {error}");
                    }
                })
                .context("failed to emit IPC message")?;
        }
        Ok(())
    }
    .await;
    let mut connections = connections.lock().await;
    if connections
        .get(&session_id)
        .is_some_and(|active| Arc::ptr_eq(active, &writer))
    {
        connections.remove(&session_id);
    }
    result
}

fn enqueue_result(sender: &mpsc::Sender<Value>, message: &Value) -> Result<()> {
    // UI requests are consumed by the renderer, not the result collector.
    // Never fill its bounded queue with forms, or acknowledge a lost result.
    if matches!(
        message.get("type").and_then(Value::as_str),
        Some("process.result") | Some("tool.result")
    ) {
        sender
            .try_send(message.clone())
            .context("IPC result queue is unavailable")?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn authenticates_each_session_with_its_own_token() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        for id in ["a", "b"] {
            let (messages, _receiver) = mpsc::channel(16);
            sessions.lock().await.insert(
                id.to_owned(),
                IpcSessionEntry {
                    token: format!("token-{id}"),
                    messages,
                    artifacts: None,
                },
            );
        }
        for id in ["a", "b"] {
            assert_eq!(
                authenticate_hello(
                    &json!({"type":"hello", "runId":id, "token":format!("token-{id}")}),
                    &sessions
                )
                .await
                .unwrap()
                .0,
                id
            );
        }
        assert!(
            authenticate_hello(&json!({"type":"hello", "runId":"a", "token":"token-b"}), &sessions)
                .await
                .is_err()
        );
        assert!(
            authenticate_hello(&json!({"type":"ui.request", "runId":"a", "token":"token-a"}), &sessions)
                .await
                .is_err()
        );
        sessions.lock().await.remove("a");
        assert!(
            authenticate_hello(&json!({"type":"hello", "runId":"a", "token":"token-a"}), &sessions)
                .await
                .is_err()
        );
    }

    #[test]
    fn form_requests_cannot_displace_a_structured_result() {
        let (sender, mut receiver) = mpsc::channel(16);
        for index in 0..100 {
            enqueue_result(&sender, &json!({"type":"ui.request", "id":index})).unwrap();
        }
        let result = json!({"type":"process.result", "data":{"ok":true}});
        enqueue_result(&sender, &result).unwrap();
        assert_eq!(receiver.try_recv().unwrap(), result);
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn a_full_result_queue_is_reported_instead_of_acknowledged() {
        let (sender, _receiver) = mpsc::channel(1);
        let result = json!({"type":"tool.result", "data":{}});
        enqueue_result(&sender, &result).unwrap();
        assert!(enqueue_result(&sender, &result).is_err());
    }

    #[tokio::test]
    async fn dropping_an_app_session_revokes_its_credentials() {
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let (messages, receiver) = mpsc::channel(16);
        sessions.lock().await.insert(
            "cancelled".into(),
            IpcSessionEntry {
                token: "token".into(),
                messages,
                artifacts: None,
            },
        );
        let session = IpcSession {
            id: "cancelled".into(),
            token: "token".into(),
            endpoint: "test".into(),
            receiver,
            sessions: Arc::clone(&sessions),
            connections: Arc::new(Mutex::new(HashMap::new())),
            closed: false,
        };
        drop(session);
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            while sessions.lock().await.contains_key("cancelled") {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn rejects_a_second_connection_using_the_same_session() {
        use tokio::net::windows::named_pipe::ServerOptions;
        let mut writers = Vec::new();
        for _ in 0..2 {
            let endpoint = format!(r"\\.\pipe\workrun-register-test-{}", uuid::Uuid::new_v4());
            let pipe = ServerOptions::new().create(&endpoint).unwrap();
            let (_, writer) = tokio::io::split(pipe);
            writers.push(Arc::new(Mutex::new(writer)));
        }
        let connections = Arc::new(Mutex::new(HashMap::new()));
        register_connection("a", Arc::clone(&writers[0]), &connections)
            .await
            .unwrap();
        assert!(
            register_connection("a", Arc::clone(&writers[1]), &connections)
                .await
                .is_err()
        );
        assert!(Arc::ptr_eq(connections.lock().await.get("a").unwrap(), &writers[0]));
    }

    #[tokio::test]
    async fn framed_messages_survive_fragmentation_and_unicode() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, mut reader) = tokio::io::duplex(8);
        let message = json!({"type":"ui.request", "title":"填写健康信息", "data":"x".repeat(8192)});
        let expected = message.clone();
        let task = tokio::spawn(async move {
            let payload = serde_json::to_vec(&message).unwrap();
            let frame = [(payload.len() as u32).to_be_bytes().as_slice(), &payload].concat();
            for bytes in frame.chunks(3) {
                writer.write_all(bytes).await.unwrap();
            }
        });
        assert_eq!(receive_message(&mut reader).await.unwrap(), expected);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_and_truncated_frames() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, mut reader) = tokio::io::duplex(16);
        writer.write_u32((MAX_MESSAGE_SIZE + 1) as u32).await.unwrap();
        assert!(
            receive_message(&mut reader)
                .await
                .unwrap_err()
                .to_string()
                .contains("exceeds")
        );
        let (mut writer, mut reader) = tokio::io::duplex(16);
        writer.write_u32(10).await.unwrap();
        writer.write_all(b"{}").await.unwrap();
        drop(writer);
        assert!(receive_message(&mut reader).await.is_err());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn concurrent_python_apps_receive_only_their_own_out_of_order_responses() {
        use tokio::net::windows::named_pipe::ServerOptions;
        let endpoint = format!(r"\\.\pipe\workrun-rust-test-{}", uuid::Uuid::new_v4());
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        let mut servers = Vec::new();
        let mut clients = Vec::new();
        let sdk = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/python-sdk");
        let python = sdk.join(".venv/Scripts/python.exe");
        for id in ["a", "b"] {
            let (sender, _receiver) = mpsc::channel(16);
            sessions.lock().await.insert(
                id.into(),
                IpcSessionEntry {
                    token: format!("token-{id}"),
                    messages: sender,
                    artifacts: None,
                },
            );
            let mut pipe = ServerOptions::new().create(&endpoint).unwrap();
            let sessions = Arc::clone(&sessions);
            servers.push(tokio::spawn(async move {
                pipe.connect().await.unwrap();
                let hello = receive_message(&mut pipe).await.unwrap();
                let (session_id, _) = authenticate_hello(&hello, &sessions).await.unwrap();
                let mut requests = Vec::new();
                for _ in 0..12 { requests.push(receive_message(&mut pipe).await.unwrap()); }
                for request in requests.iter().rev() {
                    send_message(&mut pipe, &json!({"id":request["id"], "type":"ui.response", "data":{"session":session_id,"title":request["title"]}})).await.unwrap();
                }
                let result = receive_message(&mut pipe).await.unwrap();
                assert_eq!(result["type"], "process.result");
                send_message(&mut pipe, &json!({"id":result["id"], "type":"process.result.accepted"})).await.unwrap();
            }));
            clients.push(tokio::process::Command::new(&python).env("PYTHONPATH", sdk.join("src"))
                .arg("-c").arg("import sys\nfrom concurrent.futures import ThreadPoolExecutor\nfrom workrun_sdk._client import WorkrunClient\nwith WorkrunClient(sys.argv[1], 'token-'+sys.argv[2], sys.argv[2]) as client:\n def request(i):\n  return client.request_interaction(schema={'type':'object'}, title=str(i))\n with ThreadPoolExecutor(max_workers=12) as pool:\n  assert list(pool.map(request, range(12))) == [{'session':sys.argv[2], 'title':str(i)} for i in range(12)]\n client.emit({'type':'process.result','data':{'ok':True}})\n")
                .arg(&endpoint).arg(id).kill_on_drop(true).spawn().unwrap());
        }
        for mut client in clients {
            assert!(
                tokio::time::timeout(std::time::Duration::from_secs(10), client.wait())
                    .await
                    .unwrap()
                    .unwrap()
                    .success()
            );
        }
        for server in servers {
            server.await.unwrap();
        }
    }
}

async fn artifact_request(session_id: &str, message: &Value) -> Result<Value> {
    let access = IpcServer::global()
        .sessions
        .lock()
        .await
        .get(session_id)
        .and_then(|entry| entry.artifacts.clone())
        .context("This process has no resource capability")?;
    let kind = required_string(message, "type")?;
    match kind.as_str() {
        "artifact.read" => {
            let reference: crate::module::artifact::ArtifactRef = serde_json::from_value(
                message
                    .get("reference")
                    .cloned()
                    .context("Missing resource reference")?,
            )?;
            if !access.allows(&reference) {
                bail!("Resource is not part of this process's authorized input");
            }
            tokio::task::spawn_blocking(move || -> Result<Value> {
                let source = access.store.resolve(&reference)?;
                // SDK consumers receive a private copy, never the immutable original.
                let destination = access
                    .copies
                    .path()
                    .join(format!("{}-{}", reference.id, Uuid::new_v4()));
                std::fs::copy(source, &destination)?;
                Ok(serde_json::json!({"path": destination}))
            })
            .await?
        },
        "artifact.save" => {
            let path = std::path::PathBuf::from(required_string(message, "path")?);
            let reference = tokio::task::spawn_blocking(move || access.store.import(&path)).await??;
            let mut sessions = IpcServer::global().sessions.lock().await;
            let access = sessions
                .get_mut(session_id)
                .and_then(|entry| entry.artifacts.as_mut())
                .context("IPC session has closed")?;
            access.references.push(reference.clone());
            Ok(serde_json::to_value(reference)?)
        },
        _ => bail!("Unknown resource operation"),
    }
}

#[cfg(test)]
mod artifact_capability_tests {
    use super::*;
    #[tokio::test]
    async fn artifact_ipc_round_trip_returns_private_copies_and_denies_ungranted_reads() {
        let temporary = tempfile::tempdir().unwrap();
        let store = crate::module::artifact::ArtifactStore::new(temporary.path().join("store"));
        let private = store.save_bytes("private.pdf", b"%PDF-private").unwrap();
        let source = temporary.path().join("report.pdf");
        std::fs::write(&source, b"%PDF-report").unwrap();
        let access = ArtifactAccess {
            store: store.clone(),
            references: Vec::new(),
            copies: Arc::new(tempfile::tempdir().unwrap()),
        };
        let server = IpcServer::global();
        let id = Uuid::new_v4().to_string();
        let (messages, _receiver) = mpsc::channel(16);
        server.sessions.lock().await.insert(
            id.clone(),
            IpcSessionEntry {
                token: "test".into(),
                messages,
                artifacts: Some(access),
            },
        );
        let result = artifact_request(&id, &serde_json::json!({"type":"artifact.save", "path":source}))
            .await
            .unwrap();
        let reference: crate::module::artifact::ArtifactRef = serde_json::from_value(result.clone()).unwrap();
        let loaded = artifact_request(&id, &serde_json::json!({"type":"artifact.read", "reference":result}))
            .await
            .unwrap();
        let copied = std::path::PathBuf::from(loaded["path"].as_str().unwrap());
        assert_eq!(std::fs::read(&copied).unwrap(), b"%PDF-report");
        std::fs::write(copied, b"consumer changed copy").unwrap();
        assert_eq!(
            std::fs::read(store.resolve(&reference).unwrap()).unwrap(),
            b"%PDF-report"
        );
        assert!(
            artifact_request(&id, &serde_json::json!({"type":"artifact.read", "reference":private}))
                .await
                .is_err()
        );
        server.sessions.lock().await.remove(&id);
        assert!(
            artifact_request(&id, &serde_json::json!({"type":"artifact.read", "reference":reference}))
                .await
                .is_err()
        );
    }

    #[test]
    fn process_capability_rejects_other_resources_and_forged_metadata() {
        let temporary = tempfile::tempdir().unwrap();
        let store = crate::module::artifact::ArtifactStore::new(temporary.path().join("store"));
        let file = store.save_bytes("allowed.pdf", b"%PDF-allowed").unwrap();
        let other = store.save_bytes("private.pdf", b"%PDF-private").unwrap();
        let access = ArtifactAccess {
            store,
            references: vec![file.clone()],
            copies: Arc::new(tempfile::tempdir().unwrap()),
        };
        assert!(access.allows(&file));
        assert!(!access.allows(&other));
        let mut forged = file.clone();
        forged.size = 1;
        assert!(!access.allows(&forged));
        let mut visible = file;
        visible.name = "[EMAIL REDACTED].pdf".into();
        assert!(access.allows(&visible));
    }
}
