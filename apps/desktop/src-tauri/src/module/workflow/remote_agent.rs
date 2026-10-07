//! A2A v1.0.1 JSON-RPC boundary. Binary resources stay outside State and traces.
use super::remote_auth::RemoteAuth;
use super::remote_tasks::{RemoteConnection, RemoteTaskTracker};
use super::*;
use crate::module::artifact::{ArtifactStore, references};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{collections::BTreeMap, time::Duration};
use tauri_plugin_http::reqwest::{Client, Response, Url};

const MAX_BYTES: usize = 20 * 1024 * 1024;
const MAX_FILES: usize = 10;
const MAX_WIRE: usize = 64 * 1024 * 1024;
const MAX_EVENT: usize = 32 * 1024 * 1024;

pub(super) struct RemoteAgentNode {
    id: String,
    auth: RemoteAuth,
    authentication: Option<RemoteAuthentication>,
    #[cfg(test)]
    tracking_storage: Option<(sqlx::SqlitePool, Vec<u8>)>,
    store: Option<ArtifactStore>,
    url: Url,
    paths: Vec<String>,
    timeout: Duration,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
    on_event: Option<Channel<StreamEvent>>,
}

pub(super) fn remote_a2a_graph_node(
    node: &WorkflowNode,
    config: &IWorkrun,
    on_event: Option<Channel<StreamEvent>>,
    state: SharedWorkflowState,
    state_config: WorkflowNodeStateConfig,
) -> Result<RemoteAgentNode> {
    let url = Url::parse(&string_data(node, "url").unwrap_or_default()).context("Invalid A2A service URL")?;
    validate_url(&url)?;
    let seconds = match node.data.get("timeoutSeconds") {
        None => 120,
        Some(value) => value
            .as_u64()
            .filter(|n| (1..=600).contains(n))
            .context("A2A timeoutSeconds must be an integer between 1 and 600")?,
    };
    let authentication = node
        .data
        .get("authentication")
        .filter(|v| !v.is_null())
        .map(|value| serde_json::from_value::<RemoteAuthentication>(value.clone()))
        .transpose()?;
    let auth = RemoteAuth::resolve(authentication.as_ref(), url.as_str(), config)?;
    Ok(RemoteAgentNode {
        id: node.id.clone(),
        auth,
        authentication,
        #[cfg(test)]
        tracking_storage: None,
        store: None,
        url,
        paths: string_array_data(node, "attachmentPaths")?,
        timeout: Duration::from_secs(seconds),
        state,
        state_config,
        on_event,
    })
}

fn validate_url(url: &Url) -> Result<()> {
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        bail!("A2A requires an HTTP(S) URL without credentials or fragments");
    }
    Ok(())
}

fn input_parts(input: &Value, paths: &[String], store: &ArtifactStore) -> Result<Vec<Value>> {
    let mut selected = Vec::new();
    for path in paths {
        let value = state_bridge::value_at_path(input, path)
            .with_context(|| format!("A2A attachment path `{path}` is missing or inaccessible"))?;
        let files = references(value)?;
        if files.is_empty() {
            bail!("A2A attachment path `{path}` contains no files");
        }
        selected.extend(files);
    }
    let mut seen = HashSet::new();
    selected.retain(|r| seen.insert((r.id.clone(), r.version)));
    if selected.len() > MAX_FILES {
        bail!("A2A accepts at most 10 attachments");
    }
    let mut total = 0usize;
    let mut parts = Vec::new();
    for reference in &selected {
        total = total
            .checked_add(reference.size as usize)
            .context("A2A attachment size overflow")?;
        if total > MAX_BYTES {
            bail!("A2A attachments exceed 20 MiB");
        }
        let bytes = std::fs::read(store.resolve(reference)?)?;
        parts
            .push(json!({"raw": STANDARD.encode(bytes), "filename": reference.name, "mediaType": reference.mime_type}));
    }
    // Local UUID references are capabilities, not transferable file contents.
    // Retain descriptive State for the remote prompt without exporting those IDs.
    fn describe(value: &Value) -> Value {
        if value.get("$type").and_then(Value::as_str) == Some("artifact") {
            return json!({"name":value.get("name"),"mimeType":value.get("mimeType"),"size":value.get("size")});
        }
        match value {
            Value::Object(map) => Value::Object(map.iter().map(|(k, v)| (k.clone(), describe(v))).collect()),
            Value::Array(items) => Value::Array(items.iter().map(describe).collect()),
            _ => value.clone(),
        }
    }
    parts.insert(0, json!({"text":serde_json::to_string(&describe(input))?}));
    if serde_json::to_vec(&parts)?.len() > MAX_EVENT {
        bail!("A2A input exceeds the wire size limit");
    }
    Ok(parts)
}

fn endpoint(card: &Value, base: &Url) -> Result<(Url, Option<String>, bool)> {
    if card
        .pointer("/capabilities/extensions")
        .and_then(Value::as_array)
        .is_some_and(|a| {
            a.iter()
                .any(|e| e.get("required").and_then(Value::as_bool) == Some(true))
        })
    {
        bail!("This A2A agent requires unsupported protocol extensions");
    }
    let interface = card
        .get("supportedInterfaces")
        .and_then(Value::as_array)
        .and_then(|items| {
            items.iter().find(|i| {
                i.get("protocolBinding").and_then(Value::as_str) == Some("JSONRPC")
                    && i.get("protocolVersion").and_then(Value::as_str) == Some("1.0")
            })
        })
        .context("Agent Card must advertise A2A 1.0 JSONRPC (v1.0.1); older protocols are unsupported")?;
    let url = Url::parse(
        interface
            .get("url")
            .and_then(Value::as_str)
            .context("Agent interface URL missing")?,
    )?;
    validate_url(&url)?;
    if url.origin() != base.origin() {
        bail!("A2A interface must share the configured service origin");
    }
    Ok((
        url,
        interface.get("tenant").and_then(Value::as_str).map(str::to_owned),
        card.pointer("/capabilities/streaming").and_then(Value::as_bool) == Some(true),
    ))
}

async fn bounded_body(mut response: Response, context: &NodeContext) -> Result<Vec<u8>> {
    if !response.status().is_success() {
        return Err(HttpStatus(response.status().as_u16()).into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_EVENT {
            bail!("A2A response exceeds the wire size limit");
        }
        body.extend_from_slice(&chunk);
        context.report_progress();
    }
    Ok(body)
}

const READ_RETRIES: usize = 3;

#[derive(Debug)]
struct HttpStatus(u16);
impl std::fmt::Display for HttpStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "A2A HTTP request failed with status {}", self.0)
    }
}
impl std::error::Error for HttpStatus {}

#[derive(Debug)]
struct InterruptedStream;
impl std::fmt::Display for InterruptedStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("A2A stream ended in a partial SSE event")
    }
}
impl std::error::Error for InterruptedStream {}

fn transient(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<HttpStatus>()
        .is_some_and(|status| matches!(status.0, 429 | 500 | 502 | 503 | 504))
        || error.is::<InterruptedStream>()
        || error.chain().any(|cause| {
            cause
                .downcast_ref::<tauri_plugin_http::reqwest::Error>()
                .is_some_and(|e| e.is_connect() || e.is_request() || e.is_timeout() || e.is_body() || e.is_decode())
        })
}

// Only discovery and GetTask are replayed. A failed message submission can
// already have created remote work, so replaying it would require an explicit
// server idempotency guarantee that discovery does not currently provide.
async fn read_with_retry(client: &Client, url: &Url, params: Option<&Value>, context: &NodeContext) -> Result<Vec<u8>> {
    for attempt in 0..=READ_RETRIES {
        if attempt > 0 {
            context.report_progress();
            tokio::time::sleep(Duration::from_secs(1 << (attempt - 1))).await;
        }
        let read = async {
            let request = match params {
                Some(params) => client.post(url.clone()).json(params),
                None => client.get(url.clone()),
            };
            let response = request.header("A2A-Version", "1.0").send().await?;
            if matches!(response.status().as_u16(), 429 | 500 | 502 | 503 | 504) {
                return Err(HttpStatus(response.status().as_u16()).into());
            }
            bounded_body(response, context).await
        }
        .await;
        match read {
            Ok(body) => return Ok(body),
            Err(error) if transient(&error) && attempt < READ_RETRIES => {},
            Err(error) => return Err(error),
        }
    }
    unreachable!("bounded read retry loop returns on its last attempt")
}

fn rpc_result(value: Value, id: &str) -> Result<Value> {
    if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || value.get("id").and_then(Value::as_str) != Some(id)
    {
        bail!("Invalid A2A JSON-RPC response or request ID");
    }
    if let Some(error) = value.get("error") {
        // A remote error message can contain echoed input or base64. Report only its code.
        bail!(
            "A2A JSON-RPC error (code {})",
            error.get("code").unwrap_or(&Value::Null)
        );
    }
    value.get("result").cloned().context("A2A JSON-RPC result missing")
}

#[derive(Default)]
struct RemoteResult {
    task_id: Option<String>,
    complete: bool,
    remote_state: Option<String>,
    tracking: Option<RemoteTaskTracker>,
    response: Vec<Value>,
    artifacts: BTreeMap<String, Value>,
}

impl RemoteResult {
    fn task_id(&mut self, value: &Value, key: &str) -> Result<()> {
        let id = value
            .get(key)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .context("A2A task ID missing")?;
        if self.task_id.as_deref().is_some_and(|old| old != id) {
            bail!("A2A stream changed task ID");
        }
        self.task_id = Some(id.to_string());
        Ok(())
    }

    async fn accept_tracked(&mut self, value: Value, auth: &RemoteAuth) -> Result<()> {
        let accepted = self.accept(value);
        if let Some(tracking) = &mut self.tracking {
            tracking
                .observe(
                    self.task_id.as_deref(),
                    self.remote_state.as_deref(),
                    self.task_id.as_ref().map(|id| auth.redact(id)),
                )
                .await?;
        }
        accepted
    }

    fn status(&mut self, status: &Value) -> Result<()> {
        let state = status
            .get("state")
            .and_then(Value::as_str)
            .context("A2A task state missing")?;
        remote_tasks::task_state(state)?;
        self.remote_state = Some(state.to_string());
        match status
            .get("state")
            .and_then(Value::as_str)
            .context("A2A task state missing")?
        {
            "TASK_STATE_COMPLETED" => self.complete = true,
            "TASK_STATE_SUBMITTED" | "TASK_STATE_WORKING" => {},
            "TASK_STATE_FAILED"
            | "TASK_STATE_CANCELED"
            | "TASK_STATE_REJECTED"
            | "TASK_STATE_INPUT_REQUIRED"
            | "TASK_STATE_AUTH_REQUIRED" => bail!("A2A task ended in {}", status["state"]),
            _ => bail!("Unsupported A2A task state"),
        }
        if let Some(message) = status.get("message") {
            self.response = message_parts(message)?;
        }
        Ok(())
    }

    fn accept(&mut self, result: Value) -> Result<()> {
        let variants = ["task", "message", "statusUpdate", "artifactUpdate"];
        if variants.iter().filter(|k| result.get(**k).is_some()).count() != 1 {
            bail!("Invalid A2A result variant");
        }
        if let Some(task) = result.get("task") {
            self.task_id(task, "id")?;
            self.status(task.get("status").context("A2A task status missing")?)?;
            if let Some(history) = task.get("history").and_then(Value::as_array)
                && let Some(message) = history
                    .iter()
                    .rev()
                    .find(|m| m.get("role").and_then(Value::as_str) == Some("ROLE_AGENT"))
            {
                self.response = message_parts(message)?;
            }

            if let Some(artifacts) = task.get("artifacts").and_then(Value::as_array) {
                self.artifacts.clear();
                for artifact in artifacts {
                    self.artifact(artifact.clone(), false)?;
                }
            }
        } else if let Some(message) = result.get("message") {
            self.response = message_parts(message)?;
            self.complete = true;
            self.remote_state = Some("TASK_STATE_COMPLETED".to_string());
        } else if let Some(update) = result.get("statusUpdate") {
            self.task_id(update, "taskId")?;
            self.status(update.get("status").context("A2A task status missing")?)?;
        } else if let Some(update) = result.get("artifactUpdate") {
            self.task_id(update, "taskId")?;
            self.artifact(
                update.get("artifact").cloned().context("A2A artifact missing")?,
                update.get("append").and_then(Value::as_bool).unwrap_or(false),
            )?;
        }
        // Bound accumulated parts as well as each HTTP event; a small append
        // repeated indefinitely must not grow unbounded in memory.
        if serde_json::to_vec(&json!({"response":self.response,"artifacts":self.artifacts}))?.len() > MAX_EVENT {
            bail!("A2A accumulated output exceeds the size limit");
        }
        Ok(())
    }

    fn artifact(&mut self, artifact: Value, append: bool) -> Result<()> {
        let id = artifact
            .get("artifactId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .context("A2A artifactId missing")?
            .to_string();
        let parts = artifact
            .get("parts")
            .and_then(Value::as_array)
            .filter(|a| !a.is_empty())
            .context("A2A artifact parts missing")?;
        if append {
            let old = self
                .artifacts
                .get_mut(&id)
                .context("A2A append references an unknown artifact")?;
            old["parts"]
                .as_array_mut()
                .context("Invalid A2A artifact parts")?
                .extend(parts.iter().cloned());
        } else {
            self.artifacts.insert(id, artifact);
        }
        if self.artifacts.len() > MAX_FILES {
            bail!("A2A returned too many artifacts");
        }
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    fn output(&self) -> Result<(String, Vec<(String, Option<String>, Vec<u8>)>)> {
        if !self.complete {
            bail!("A2A response ended before task completion");
        }
        let mut text = Vec::new();
        let mut files = Vec::new();
        let mut total = 0usize;
        for (name, parts) in
            std::iter::once(("response", self.response.as_slice())).chain(self.artifacts.values().map(|a| {
                (
                    a.get("name").and_then(Value::as_str).unwrap_or("artifact"),
                    a["parts"].as_array().unwrap().as_slice(),
                )
            }))
        {
            for part in parts {
                if ["text", "raw", "url", "data"]
                    .iter()
                    .filter(|k| part.get(**k).is_some())
                    .count()
                    != 1
                {
                    bail!("Invalid A2A Part");
                }
                if part.get("url").is_some() {
                    bail!("A2A URL file outputs are unsupported; return inline raw bytes");
                }
                if let Some(raw) = part.get("raw") {
                    let raw = raw.as_str().context("Invalid A2A raw bytes")?;
                    if raw.len() > MAX_EVENT {
                        bail!("A2A file exceeds the size limit");
                    }
                    let bytes = STANDARD.decode(raw).context("Invalid A2A base64 file")?;
                    total += bytes.len();
                    if total > MAX_BYTES || files.len() >= MAX_FILES {
                        bail!("A2A files exceed 10 files / 20 MiB");
                    }
                    let media = part.get("mediaType").and_then(Value::as_str).map(str::to_owned);
                    if let Some(media) = &media {
                        crate::module::artifact::validate_media_type(&bytes, media)?;
                    }
                    let filename = part.get("filename").and_then(Value::as_str).unwrap_or(name);
                    if filename.is_empty()
                        || filename.len() > 255
                        || filename.chars().any(char::is_control)
                        || filename.contains(['/', '\\'])
                        || matches!(filename, "." | "..")
                    {
                        bail!("Invalid A2A output filename");
                    }
                    files.push((filename.to_string(), media, bytes));
                } else if let Some(value) = part.get("text") {
                    text.push(value.as_str().context("Invalid A2A text Part")?.to_string());
                } else if let Some(value) = part.get("data") {
                    text.push(serde_json::to_string(value)?);
                }
            }
        }
        Ok((text.join("\n"), files))
    }
}

fn message_parts(message: &Value) -> Result<Vec<Value>> {
    if message.get("role").and_then(Value::as_str) != Some("ROLE_AGENT") {
        bail!("A2A response must have ROLE_AGENT");
    }
    Ok(message
        .get("parts")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .context("A2A message parts missing")?
        .clone())
}

async fn receive_stream(
    mut response: Response,
    id: &str,
    context: &NodeContext,
    output: &mut RemoteResult,
    auth: &RemoteAuth,
) -> Result<()> {
    if !response.status().is_success() {
        bail!("A2A HTTP stream failed with status {}", response.status());
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        bail!("A2A streaming response must be text/event-stream");
    }
    let mut buffer = Vec::new();
    let mut data = Vec::new();
    let mut total = 0usize;
    let mut seen = HashSet::new();
    let mut event_id: Option<String> = None;
    while let Some(chunk) = response.chunk().await? {
        total += chunk.len();
        if total > MAX_WIRE {
            bail!("A2A stream exceeds the wire size limit");
        }
        buffer.extend_from_slice(&chunk);
        context.report_progress();
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let mut line = buffer.drain(..=end).collect::<Vec<_>>();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if line.is_empty() {
                if !data.is_empty() {
                    if event_id.as_ref().is_none_or(|id| seen.insert(id.clone())) {
                        output
                            .accept_tracked(rpc_result(serde_json::from_slice(&data)?, id)?, auth)
                            .await?;
                    }
                    data.clear();
                    if output.complete {
                        return Ok(());
                    }
                }
                event_id = None;
            } else if let Some(value) = line.strip_prefix(b"data:") {
                if !data.is_empty() {
                    data.push(b'\n');
                }
                data.extend_from_slice(value.strip_prefix(b" ").unwrap_or(value));
            } else if let Some(value) = line.strip_prefix(b"id:") {
                event_id = Some(String::from_utf8(value.to_vec())?);
            }
            if data.len() > MAX_EVENT {
                bail!("A2A SSE event exceeds the size limit");
            }
        }
        if buffer.len() > MAX_EVENT {
            bail!("A2A SSE line exceeds the size limit");
        }
    }
    if !data.is_empty() || !buffer.is_empty() {
        return Err(InterruptedStream.into());
    }
    Ok(())
}

impl RemoteAgentNode {
    fn tracking_storage(&self) -> Result<(sqlx::SqlitePool, Vec<u8>)> {
        #[cfg(test)]
        if let Some(storage) = &self.tracking_storage {
            return Ok(storage.clone());
        }
        Ok((
            crate::core::db::DBManager::global().pool()?,
            crate::utils::dirs::get_encryption_key()?,
        ))
    }

    async fn run(&self, context: &NodeContext, store: &ArtifactStore, input: &Value) -> Result<RemoteResult> {
        let parts = input_parts(input, &self.paths, store)?;
        let client = self.auth.client()?;
        let card_url = self.url.join("/.well-known/agent-card.json")?;
        let card: Value = serde_json::from_slice(&read_with_retry(&client, &card_url, None, context).await?)?;
        self.auth.validate_card(&card)?;
        let (url, tenant, streaming) = endpoint(&card, &self.url)?;
        let modes = card
            .get("defaultInputModes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .chain(
                card.get("skills")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .flat_map(|skill| skill.get("inputModes").and_then(Value::as_array).into_iter().flatten()),
            )
            .filter_map(Value::as_str)
            .collect::<Vec<_>>();
        for part in parts.iter().skip(1) {
            let mime = part
                .get("mediaType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            if !modes.is_empty()
                && !modes
                    .iter()
                    .any(|m| *m == mime || *m == "*/*" || (m.ends_with("/*") && mime.starts_with(&m[..m.len() - 1])))
            {
                bail!("Remote A2A agent does not advertise input type {mime}");
            }
        }
        let id = uuid::Uuid::new_v4().to_string();
        let message_id = uuid::Uuid::new_v4().to_string();
        let tracking = if let Some(run_id) = context.config.metadata.get("workrun.run_id").and_then(Value::as_str) {
            let (pool, key) = self.tracking_storage()?;
            Some(
                RemoteTaskTracker::begin(
                    pool,
                    key,
                    run_id,
                    &self.id,
                    &message_id,
                    RemoteConnection {
                        service_url: self.url.to_string(),
                        endpoint: url.to_string(),
                        tenant: tenant.clone(),
                        authentication: self.authentication.clone(),
                        task_id: None,
                    },
                )
                .await?,
            )
        } else {
            None
        };
        let mut result = RemoteResult {
            tracking,
            ..Default::default()
        };
        let mut params = json!({"message":{"messageId":message_id,"role":"ROLE_USER","parts":parts},
            "configuration":{"historyLength":0,"returnImmediately":false}});
        if let Some(tenant) = &tenant {
            params["tenant"] = json!(tenant);
        }
        let request = json!({"jsonrpc":"2.0","id":id,"method":if streaming {"SendStreamingMessage"} else {"SendMessage"},"params":params});
        let response = client
            .post(url.clone())
            .header("A2A-Version", "1.0")
            .header(
                "Accept",
                if streaming {
                    "text/event-stream"
                } else {
                    "application/json"
                },
            )
            .json(&request)
            .send()
            .await
            .context("A2A submission outcome is unknown; the message was not resubmitted")?;
        if streaming {
            if let Err(error) = receive_stream(response, &id, context, &mut result, &self.auth).await {
                if !transient(&error) {
                    return Err(error);
                }
                if result.task_id.is_none() {
                    return Err(error.context("A2A submission outcome is unknown; no task ID was received and the message was not resubmitted"));
                }
                // The remote task belongs to this run. Keep its ID and recover
                // from a full Task snapshot instead of replaying SSE append events.
                if let Some(channel) = &self.on_event {
                    send_guarded_event(
                        channel,
                        StreamEvent::custom(&self.id, "workflow.remote_reconnecting", json!({"nodeId":self.id})),
                    );
                }
                context.report_progress();
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        } else {
            result.accept_tracked(rpc_result(
                serde_json::from_slice(&bounded_body(response, context).await.context(
                    "A2A submission outcome is unknown; no task ID was received and the message was not resubmitted",
                )?)?,
                &id,
            )?, &self.auth).await?;
        }
        // A server may return a nonterminal Task despite blocking configuration.
        // Poll the same task; never resend the original message and its files.
        while !result.complete {
            let task = result
                .task_id
                .clone()
                .context("A2A incomplete response has no task ID")?;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let id = uuid::Uuid::new_v4().to_string();
            let mut params = json!({"id":task,"historyLength":1});
            if let Some(tenant) = &tenant {
                params["tenant"] = json!(tenant);
            }
            let request = json!({"jsonrpc":"2.0","id":id,"method":"GetTask","params":params});
            let task = rpc_result(
                serde_json::from_slice(&read_with_retry(&client, &url, Some(&request), context).await?)?,
                &id,
            )?;
            // Snapshots replace partial streamed artifacts, including when the
            // authoritative snapshot omits artifacts. Never append recovered files.
            let mut snapshot = RemoteResult {
                task_id: result.task_id.clone(),
                tracking: result.tracking.take(),
                ..Default::default()
            };
            snapshot.accept_tracked(json!({"task":task}), &self.auth).await?;
            result = snapshot;
        }
        Ok(result)
    }
}

#[async_trait::async_trait]
impl Node for RemoteAgentNode {
    fn name(&self) -> &str {
        &self.id
    }
    async fn execute(&self, context: &NodeContext) -> adk_rust::graph::Result<NodeOutput> {
        let work = async {
            let input = self
                .state
                .lock()
                .map_err(|_| anyhow!("workflow state lock is poisoned"))?
                .agent_input(&self.id)?;
            // Compilation also runs in headless validation. Resolve storage only
            // when invoking, then retain that workspace throughout the call.
            let store = self.store.clone().map(Ok).unwrap_or_else(ArtifactStore::active)?;
            let remote = tokio::time::timeout(self.timeout, self.run(context, &store, &input))
                .await
                .context("A2A request timed out")??;
            let (response, files) = remote.output()?;
            // Validate the entire result before importing files or publishing State.
            let artifacts = files
                .iter()
                .map(|(name, mime, bytes)| {
                    store
                        .save_bytes_with_mime(&self.auth.redact(name), bytes, mime.as_deref())
                        .and_then(|r| Ok(serde_json::to_value(r)?))
                })
                .collect::<Result<Vec<_>>>()?;
            let response = redact_text(&self.auth.redact(&response));
            let values = json!({"response":response,"messages":[{"role":"assistant","content":response}],"artifacts":artifacts,"remoteTaskId":remote.task_id.as_ref().map(|id| self.auth.redact(id))});
            if let Some(tracking) = &remote.tracking {
                tracking
                    .save_result(&redact_json(&json!({"response": response, "artifacts": artifacts})))
                    .await?;
            }
            let updates = self
                .state
                .lock()
                .map_err(|_| anyhow!("workflow state lock is poisoned"))?
                .apply_node_update_with_sensitive_fields(
                    &self.id,
                    crate::module::state::NodeStateUpdate::from_object(values.as_object().unwrap().clone()),
                    &self.state_config.global_keys,
                    &self.state_config.sensitive_fields,
                )?;
            let event = redact_json(
                &json!({"nodeId":self.id,"type":"remote_agent","protocolVersion":"1.0.1",
                "messages":[{"role":"assistant","content":response}],"artifacts":artifacts}),
            );
            if let Some(channel) = &self.on_event {
                send_guarded_event(
                    channel,
                    StreamEvent::custom(&self.id, "workflow.node_result", event.clone()),
                );
            }
            Ok(NodeOutput::new()
                .with_updates(updates)
                .with_update("workflow.last_node", json!(self.id))
                .with_update("workflow.node", event.clone())
                .with_update("workflow.trace", event))
        };
        work.await
            .map_err(|error: anyhow::Error| graph_node_error(&self.id, self.auth.redact(&error.to_string())))
    }
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum RemoteTaskOperation {
    Query,
    Fetch,
    Cancel,
}

// Serialize operations for one record, without holding a database transaction
// over network I/O. Repeated fetches reuse the locally collected result.
static REMOTE_TASK_OPERATIONS: std::sync::LazyLock<parking_lot::Mutex<HashSet<String>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashSet::new()));
struct TaskOperationGuard(String);
impl Drop for TaskOperationGuard {
    fn drop(&mut self) {
        REMOTE_TASK_OPERATIONS.lock().remove(&self.0);
    }
}

pub(crate) async fn remote_task_operation(
    id: &str,
    operation: RemoteTaskOperation,
    config: &IWorkrun,
) -> Result<remote_tasks::RemoteTaskRecord> {
    let pool = crate::core::db::DBManager::global().pool()?;
    let key = crate::utils::dirs::get_encryption_key()?;
    let store = ArtifactStore::active()?;
    remote_task_operation_in_pool(pool, key, &store, id, operation, config, None).await
}

async fn remote_task_operation_in_pool(
    pool: sqlx::SqlitePool,
    key: Vec<u8>,
    store: &ArtifactStore,
    id: &str,
    operation: RemoteTaskOperation,
    config: &IWorkrun,
    test_auth: Option<RemoteAuth>,
) -> Result<remote_tasks::RemoteTaskRecord> {
    if !REMOTE_TASK_OPERATIONS.lock().insert(id.to_string()) {
        bail!("Remote task operation already in progress");
    }
    let _guard = TaskOperationGuard(id.to_string());
    let (run_id, run_status): (String, String) = sqlx::query_as(
        "SELECT t.run_id, r.status FROM remote_tasks t JOIN run_records r ON r.id = t.run_id WHERE t.id = ?",
    )
    .bind(id)
    .fetch_optional(&pool)
    .await?
    .context("Remote task record not found")?;
    if matches!(run_status.as_str(), "queued" | "running" | "waiting_for_input") {
        bail!("Wait until the local run has ended before managing its remote task");
    }
    let current = remote_tasks::list_remote_tasks(&pool, &run_id)
        .await?
        .into_iter()
        .find(|record| record.id == id)
        .context("Remote task record not found")?;
    if operation == RemoteTaskOperation::Fetch && current.result.is_some() {
        return Ok(current);
    }
    let mut tracking = RemoteTaskTracker::load(pool.clone(), key, id).await?;
    let connection = &tracking.connection;
    let task_id = connection
        .task_id
        .clone()
        .context("Submission outcome is unknown: no remote task ID was received; automatic resubmission is disabled")?;
    let base = Url::parse(&connection.service_url)?;
    let url = Url::parse(&connection.endpoint)?;
    validate_url(&base)?;
    validate_url(&url)?;
    if base.origin() != url.origin() {
        bail!("Saved A2A endpoint has a different origin");
    }
    let auth = test_auth
        .map(Ok)
        .unwrap_or_else(|| RemoteAuth::resolve(connection.authentication.as_ref(), &connection.service_url, config))?;
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let client = auth.client()?;
        let context = NodeContext::new(State::new(), ExecutionConfig::new("remote-task-operation"), 0);
        let rpc_id = uuid::Uuid::new_v4().to_string();
        let mut params = json!({"id":task_id});
        if operation != RemoteTaskOperation::Cancel { params["historyLength"] = json!(1); }
        if let Some(tenant) = &tracking.connection.tenant { params["tenant"] = json!(tenant); }
        let request = json!({"jsonrpc":"2.0","id":rpc_id,"method":if operation == RemoteTaskOperation::Cancel {"CancelTask"} else {"GetTask"},"params":params});
        let body = if operation == RemoteTaskOperation::Cancel {
            bounded_body(client.post(url).header("A2A-Version", "1.0").json(&request).send().await?, &context).await
        } else { read_with_retry(&client, &url, Some(&request), &context).await };
        let body = match body {
            Err(error) if error.downcast_ref::<HttpStatus>().is_some_and(|status| status.0 == 404) => {
                sqlx::query("UPDATE remote_tasks SET status = 'not_found', updated_at = ?, last_checked_at = ? WHERE id = ?")
                    .bind(chrono::Utc::now().to_rfc3339()).bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await?;
                return Ok(());
            },
            body => body?,
        };
        let envelope: Value = serde_json::from_slice(&body)?;
        // Check envelope identity before recognizing the protocol's task-not-found error.
        if envelope["jsonrpc"] == "2.0" && envelope["id"] == rpc_id && envelope.pointer("/error/code").and_then(Value::as_i64) == Some(-32001) {
            sqlx::query("UPDATE remote_tasks SET status = 'not_found', updated_at = ?, last_checked_at = ? WHERE id = ?")
                .bind(chrono::Utc::now().to_rfc3339()).bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await?;
            return Ok(());
        }
        let task = rpc_result(envelope, &rpc_id)?;
        if task["id"].as_str() != Some(task_id.as_str()) { bail!("A2A response changed task ID"); }
        let state = task.pointer("/status/state").and_then(Value::as_str).context("A2A task state missing")?;
        tracking.observe(Some(&task_id), Some(state), current.task_id.clone()).await?;
        if operation == RemoteTaskOperation::Fetch {
            if state != "TASK_STATE_COMPLETED" { bail!("Remote task has not completed; no result was collected"); }
            let mut remote = RemoteResult { task_id: Some(task_id.clone()), ..Default::default() };
            remote.accept(json!({"task":task}))?;
            let (response, files) = remote.output()?;
            let artifacts = files.iter().map(|(name, mime, bytes)| store.save_bytes_with_mime(&auth.redact(name), bytes, mime.as_deref()).and_then(|reference| Ok(serde_json::to_value(reference)?))).collect::<Result<Vec<_>>>()?;
            tracking.save_result(&redact_json(&json!({"response":auth.redact(&response),"artifacts":artifacts}))).await?;
        }
        Ok::<_, anyhow::Error>(())
    }).await.context("Remote task operation timed out").and_then(|result| result);
    result.map_err(|error| anyhow!("{}", auth.redact(&error.to_string())))?;
    remote_tasks::list_remote_tasks(&pool, &run_id)
        .await?
        .into_iter()
        .find(|record| record.id == id)
        .context("Remote task record not found")
}

pub(crate) async fn cancel_remote_tasks_for_run(run_id: &str) -> Result<()> {
    let pool = crate::core::db::DBManager::global().pool()?;
    let config = BaseConfig::workrun().await.data_arc();
    for record in remote_tasks::list_remote_tasks(&pool, run_id).await? {
        if record.task_id.is_some()
            && matches!(
                record.status.as_str(),
                "unknown" | "submitted" | "working" | "input_required" | "auth_required"
            )
        {
            // The workflow is already locally cancelled. Remote cancellation is
            // best effort; its confirmed state remains independently inspectable.
            let _ = remote_task_operation(&record.id, RemoteTaskOperation::Cancel, &config).await;
        }
    }
    Ok(())
}

/// A read-only check: discover the card and validate transport/authentication.
/// No remote agent task is created and no workflow files are sent.
pub(crate) async fn test_remote_connection(
    url: &str,
    authentication: Option<&RemoteAuthentication>,
    config: &IWorkrun,
) -> Result<()> {
    let base = Url::parse(url).context("Invalid A2A service URL")?;
    validate_url(&base)?;
    let auth = RemoteAuth::resolve(authentication, url, config)?;
    let context = NodeContext::new(State::new(), ExecutionConfig::new("a2a-connection-test"), 0);
    tokio::time::timeout(Duration::from_secs(15), async {
        let response = auth
            .client()?
            .get(base.join("/.well-known/agent-card.json")?)
            .header("A2A-Version", "1.0")
            .send()
            .await?;
        let card: Value = serde_json::from_slice(&bounded_body(response, &context).await?)?;
        auth.validate_card(&card)?;
        endpoint(&card, &base)?;
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("A2A connection test timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn store() -> (tempfile::TempDir, ArtifactStore) {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(directory.path().join("artifacts"));
        (directory, store)
    }

    #[test]
    fn retries_are_limited_to_transport_failures() {
        assert!(transient(&anyhow::Error::new(HttpStatus(503)).context("query")));
        assert!(transient(&InterruptedStream.into()));
        assert!(!transient(&anyhow!("A2A HTTP request failed with status 401")));
        assert!(!transient(&anyhow!("A2A response exceeds the wire size limit")));
        let malformed = serde_json::from_str::<Value>("{invalid}").unwrap_err();
        assert!(!transient(&malformed.into()));
        assert!(!transient(
            &rpc_result(
                json!({"jsonrpc":"2.0","id":"request","error":{"code":-32602}}),
                "request"
            )
            .unwrap_err()
        ));
    }

    #[test]
    fn attachments_are_explicit_deduplicated_and_do_not_export_local_ids() {
        let (_dir, store) = store();
        let reference = store.save_bytes("report.pdf", b"%PDF-example").unwrap();
        let input = json!({"document":reference,"nested":{"files":[reference]},"instruction":"Read this"});
        let paths = vec!["document".into(), "nested.files".into()];
        let parts = input_parts(&input, &paths, &store).unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(
            STANDARD.decode(parts[1]["raw"].as_str().unwrap()).unwrap(),
            b"%PDF-example"
        );
        assert_eq!(parts[1]["mediaType"], "application/pdf");
        assert!(!parts[0]["text"].as_str().unwrap().contains(&reference.id));
        assert_eq!(input_parts(&input, &[], &store).unwrap().len(), 1);
        assert!(input_parts(&input, &["missing".into()], &store).is_err());
        assert!(input_parts(&input, &["instruction".into()], &store).is_err());
    }

    #[test]
    fn unauthorized_and_sensitive_state_cannot_supply_attachments() {
        let (_dir, store) = store();
        let reference = store.save_bytes("private.pdf", b"%PDF-private").unwrap();
        let bridge = WorkflowStateBridge::from_initial_state_with_policy(
            json!({"document":reference}),
            BTreeSet::from(["remote".into()]),
            BTreeSet::from(["document".into()]),
        )
        .unwrap();
        assert!(input_parts(&bridge.agent_input("remote").unwrap(), &["document".into()], &store).is_err());
        let mut bridge = WorkflowStateBridge::from_initial_state(json!({})).unwrap();
        bridge
            .apply_node_update_with_sensitive_fields(
                "producer",
                crate::module::state::NodeStateUpdate::from_object(
                    json!({"document":reference}).as_object().unwrap().clone(),
                ),
                &BTreeSet::new(),
                &BTreeSet::new(),
            )
            .unwrap();
        assert!(input_parts(&bridge.agent_input("remote").unwrap(), &["document".into()], &store).is_err());
    }

    #[test]
    fn only_v1_jsonrpc_same_origin_interfaces_are_selected() {
        let base = Url::parse("http://localhost:8080/").unwrap();
        assert!(endpoint(&json!({"url":"http://localhost:8080","protocolVersion":"0.3.0"}), &base).is_err());
        let mut card = json!({"supportedInterfaces":[{"url":"http://localhost:8080/a2a","protocolBinding":"JSONRPC","protocolVersion":"1.0","tenant":"tenant-a"}],"capabilities":{"streaming":true}});
        let (url, tenant, streaming) = endpoint(&card, &base).unwrap();
        assert_eq!(url.path(), "/a2a");
        assert_eq!(tenant.as_deref(), Some("tenant-a"));
        assert!(streaming);
        card["supportedInterfaces"][0]["url"] = json!("http://other.example/a2a");
        assert!(endpoint(&card, &base).is_err());
    }

    fn artifact(text: &str) -> Value {
        json!({"artifactId":"result","name":"summary","parts":[{"text":text}]})
    }

    #[test]
    fn artifact_updates_replace_or_append_parts_without_duplicate_snapshots() {
        let mut result = RemoteResult::default();
        for _ in 0..2 {
            result
                .accept(json!({"artifactUpdate":{"taskId":"t","artifact":artifact("one")}}))
                .unwrap();
        }
        result
            .accept(json!({"artifactUpdate":{"taskId":"t","artifact":artifact("two"),"append":true,"lastChunk":true}}))
            .unwrap();
        result
            .accept(json!({"statusUpdate":{"taskId":"t","status":{"state":"TASK_STATE_COMPLETED"}}}))
            .unwrap();
        assert_eq!(result.output().unwrap().0, "one\ntwo");
        assert!(
            result
                .accept(json!({"statusUpdate":{"taskId":"other","status":{"state":"TASK_STATE_COMPLETED"}}}))
                .is_err()
        );
    }

    #[test]
    fn failure_partial_uri_and_invalid_binary_outputs_are_rejected() {
        for state in [
            "TASK_STATE_FAILED",
            "TASK_STATE_REJECTED",
            "TASK_STATE_CANCELED",
            "TASK_STATE_INPUT_REQUIRED",
            "TASK_STATE_AUTH_REQUIRED",
        ] {
            assert!(
                RemoteResult::default()
                    .accept(json!({"task":{"id":"t","status":{"state":state}}}))
                    .is_err()
            );
        }
        assert!(RemoteResult::default().output().is_err());
        for part in [
            json!({"url":"https://example.com/a.pdf"}),
            json!({"raw":"invalid!"}),
            json!({"raw":STANDARD.encode(b"%PDF-file"),"mediaType":"image/png"}),
            json!({"raw":STANDARD.encode(b"hello"),"filename":"../escape"}),
            json!({"text":"hello","raw":""}),
        ] {
            let mut result = RemoteResult::default();
            result
                .accept(json!({"message":{"role":"ROLE_AGENT","parts":[part]}}))
                .unwrap();
            assert!(result.output().is_err());
        }
        assert!(rpc_result(json!({"jsonrpc":"2.0","id":"wrong","result":{}}), "request").is_err());
    }

    #[test]
    fn incoming_and_outgoing_file_limits_are_enforced() {
        let (_dir, store) = store();
        let files = (0..11)
            .map(|n| store.save_bytes(&format!("{n}.txt"), b"a").unwrap())
            .collect::<Vec<_>>();
        assert!(input_parts(&json!({"files":files}), &["files".into()], &store).is_err());
        let mut result = RemoteResult::default();
        result.accept(json!({"message":{"role":"ROLE_AGENT","parts":(0..11).map(|_|json!({"raw":"YQ==","filename":"a.txt"})).collect::<Vec<_>>()}})).unwrap();
        assert!(result.output().is_err());
        let large = store.save_bytes("large.txt", &vec![b'x'; MAX_BYTES + 1]).unwrap();
        assert!(input_parts(&json!({"file":large}), &["file".into()], &store).is_err());
        result.response = vec![json!({"raw":STANDARD.encode(vec![0;MAX_BYTES+1]),"filename":"large.bin"})];
        assert!(result.output().is_err());
    }

    // Real HTTP exercises discovery, wire names, tenant routing, SSE framing,
    // task polling, timeout cancellation, immutable files and downstream State.
    #[tokio::test]
    #[ignore = "requires loopback TCP sockets"]
    async fn v1_http_files_stream_poll_and_timeout_closed_loop() {
        use crate::config::RemoteCredentialKind;
        for auth_kind in [
            None,
            Some(RemoteCredentialKind::Bearer),
            Some(RemoteCredentialKind::ApiKey),
        ] {
            let expected_header = match auth_kind {
                None => None,
                Some(RemoteCredentialKind::Bearer) => Some("authorization: bearer test-secret"),
                Some(RemoteCredentialKind::ApiKey) => Some("x-api-key: test-secret"),
            };
            let security = match auth_kind {
                None => Value::Null,
                Some(RemoteCredentialKind::Bearer) => {
                    json!({"securitySchemes":{"auth":{"httpAuthSecurityScheme":{"scheme":"Bearer"}}},"securityRequirements":[{"schemes":{"auth":{}}}]})
                },
                Some(RemoteCredentialKind::ApiKey) => {
                    json!({"securitySchemes":{"auth":{"apiKeySecurityScheme":{"location":"header","name":"X-API-Key"}}},"securityRequirements":[{"schemes":{"auth":{}}}]})
                },
            };
            for mode in [
                "stream",
                "send",
                "poll",
                "timeout",
                "uri",
                "unauthorized",
                "forbidden",
                "disconnect",
                "discovery_retry",
                "partial",
                "query_retry",
                "query_close",
                "recovery_timeout",
                "query_401",
                "exhaust",
                "unknown",
                "malformed",
                "no_artifacts",
                "manual_cancel",
                "manual_notfound",
                "manual_http404",
                "manual_refuse",
            ] {
                let recovery = matches!(
                    mode,
                    "disconnect"
                        | "discovery_retry"
                        | "partial"
                        | "query_retry"
                        | "query_close"
                        | "query_401"
                        | "recovery_timeout"
                        | "exhaust"
                        | "unknown"
                        | "malformed"
                        | "no_artifacts"
                        | "manual_cancel"
                        | "manual_notfound"
                        | "manual_http404"
                        | "manual_refuse"
                );
                if recovery && auth_kind != Some(RemoteCredentialKind::ApiKey) {
                    continue;
                }
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let url = format!("http://{}", listener.local_addr().unwrap());
                let calls = Arc::new(Mutex::new(Vec::<Value>::new()));
                let server_calls = Arc::clone(&calls);
                let base = url.clone();
                let security = security.clone();
                let server = tokio::spawn(async move {
                    loop {
                        let (mut socket, _) = listener.accept().await.unwrap();
                        let calls = Arc::clone(&server_calls);
                        let base = base.clone();
                        let security = security.clone();
                        tokio::spawn(async move {
                            let mut request = Vec::new();
                            let header_end = loop {
                                let mut bytes = [0u8; 4096];
                                let n = socket.read(&mut bytes).await.unwrap();
                                if n == 0 {
                                    return;
                                }
                                request.extend_from_slice(&bytes[..n]);
                                if let Some(end) = request.windows(4).position(|b| b == b"\r\n\r\n") {
                                    break end + 4;
                                }
                            };
                            let header = String::from_utf8_lossy(&request[..header_end]).to_lowercase();
                            assert!(header.contains("a2a-version: 1.0"));
                            if let Some(expected) = expected_header {
                                assert!(header.contains(expected));
                            } else {
                                assert!(!header.contains("authorization:"));
                                assert!(!header.contains("x-api-key:"));
                            }
                            let (content_type, body) = if header.starts_with("get ") {
                                assert!(header.starts_with("get /.well-known/agent-card.json "));
                                calls.lock().unwrap().push(json!({"method":"Discovery"}));
                                let mut card = json!({"supportedInterfaces":[{"url":format!("{base}/rpc"),"protocolBinding":"JSONRPC","protocolVersion":"1.0","tenant":"team"}],
                                "capabilities":{"streaming":matches!(mode,"stream"|"timeout") || recovery},"defaultInputModes":["text/plain","application/pdf"]});
                                if !security.is_null() {
                                    card["securitySchemes"] = security["securitySchemes"].clone();
                                    card["securityRequirements"] = security["securityRequirements"].clone();
                                }
                                ("application/json", card.to_string())
                            } else {
                                let len = header
                                    .lines()
                                    .find_map(|l| l.strip_prefix("content-length: "))
                                    .unwrap()
                                    .trim()
                                    .parse::<usize>()
                                    .unwrap();
                                while request.len() < header_end + len {
                                    let mut bytes = [0u8; 4096];
                                    let n = socket.read(&mut bytes).await.unwrap();
                                    if n == 0 {
                                        return;
                                    }
                                    request.extend_from_slice(&bytes[..n]);
                                }
                                let rpc: Value =
                                    serde_json::from_slice(&request[header_end..header_end + len]).unwrap();
                                assert_eq!(rpc["params"]["tenant"], "team");
                                calls.lock().unwrap().push(rpc.clone());
                                let method = rpc["method"].as_str().unwrap();
                                let mut task = json!({"id":"task-1","status":{"state":"TASK_STATE_COMPLETED","message":{"role":"ROLE_AGENT","parts":[{"text":"reply test-secret"}]}},"artifacts":[{"artifactId":"pdf","name":"processed.pdf",
                                "parts":[{"raw":STANDARD.encode(b"%PDF-generated"),"filename":"processed-test-secret.pdf","mediaType":"application/pdf"}]}]});
                                if mode == "no_artifacts" {
                                    task.as_object_mut().unwrap().remove("artifacts");
                                }
                                let reply =
                                    |result: Value| json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}).to_string();
                                if method == "CancelTask" {
                                    assert_eq!(rpc["params"]["id"], "task-1");
                                    if mode == "manual_refuse" {
                                        ("application/json", json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32002,"message":"refused test-secret"}}).to_string())
                                    } else {
                                        task["status"]["state"] = json!("TASK_STATE_CANCELED");
                                        ("application/json", reply(task))
                                    }
                                } else if method == "GetTask" {
                                    if mode == "manual_notfound" {
                                        ("application/json", json!({"jsonrpc":"2.0","id":rpc["id"],"error":{"code":-32001,"message":"missing test-secret"}}).to_string())
                                    } else {
                                        ("application/json", reply(task))
                                    }
                                } else {
                                    assert_eq!(rpc["params"]["message"]["role"], "ROLE_USER");
                                    assert_eq!(
                                        STANDARD
                                            .decode(rpc["params"]["message"]["parts"][1]["raw"].as_str().unwrap())
                                            .unwrap(),
                                        b"%PDF-original"
                                    );
                                    if matches!(mode, "stream" | "timeout") || recovery {
                                        assert_eq!(method, "SendStreamingMessage");
                                        let initial = reply(
                                            json!({"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}),
                                        );
                                        let body = if mode.starts_with("manual_") {
                                            format!("data: {initial}\r\n\r\n")
                                        } else if recovery {
                                            let partial = reply(
                                                json!({"artifactUpdate":{"taskId":"task-1","artifact":{"artifactId":"pdf","parts":[{"raw":STANDARD.encode(b"%PDF-partial"),"filename":"partial.pdf","mediaType":"application/pdf"}]}}}),
                                            );
                                            if mode == "unknown" {
                                                "data: {".to_string()
                                            } else if mode == "malformed" {
                                                format!("data: {initial}\n\ndata: {{invalid}}\n\n")
                                            } else {
                                                format!(
                                                    "data: {initial}\n\ndata: {partial}\n\n{}",
                                                    if mode == "partial" { "data: {" } else { "" }
                                                )
                                            }
                                        } else if mode == "timeout" {
                                            format!("data: {initial}\r\n\r\n")
                                        } else {
                                            let update = reply(
                                                json!({"artifactUpdate":{"taskId":"task-1","artifact":task["artifacts"][0],"lastChunk":true}}),
                                            );
                                            let status = reply(
                                                json!({"statusUpdate":{"taskId":"task-1","status":task["status"]}}),
                                            );
                                            format!(
                                                ": heartbeat\r\n\r\ndata: {initial}\r\n\r\nid: file-1\r\ndata: {update}\r\n\r\nid: file-1\r\ndata: {update}\r\n\r\ndata: {status}\r\n\r\n"
                                            )
                                        };
                                        ("text/event-stream", body)
                                    } else {
                                        assert_eq!(method, "SendMessage");
                                        let result = if mode == "poll" {
                                            json!({"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}})
                                        } else if mode == "uri" {
                                            json!({"message":{"role":"ROLE_AGENT","parts":[{"url":"http://example.com/private.pdf"}]}})
                                        } else {
                                            json!({"task":task})
                                        };
                                        ("application/json", reply(result))
                                    }
                                }
                            };
                            let declared = body.len()
                                + if (matches!(
                                    mode,
                                    "timeout"
                                        | "recovery_timeout"
                                        | "disconnect"
                                        | "query_retry"
                                        | "query_401"
                                        | "exhaust"
                                        | "unknown"
                                        | "no_artifacts"
                                ) || mode.starts_with("manual_"))
                                    && content_type == "text/event-stream"
                                {
                                    100
                                } else {
                                    0
                                };
                            let query_count = calls
                                .lock()
                                .unwrap()
                                .iter()
                                .filter(|r| r["method"] == "GetTask")
                                .count();
                            let is_query = header.starts_with("post ")
                                && calls.lock().unwrap().last().is_some_and(|r| r["method"] == "GetTask");
                            let discovery_retry = mode == "discovery_retry"
                                && header.starts_with("get ")
                                && calls
                                    .lock()
                                    .unwrap()
                                    .iter()
                                    .filter(|r| r["method"] == "Discovery")
                                    .count()
                                    == 1;
                            let status = if mode == "manual_http404" && is_query {
                                "404 Not Found"
                            } else if discovery_retry
                                || (is_query
                                    && (matches!(mode, "exhaust" | "recovery_timeout")
                                        || mode == "query_retry" && query_count == 1))
                            {
                                "503 Service Unavailable"
                            } else if (is_query && mode == "query_401") || mode == "unauthorized" {
                                "401 Unauthorized"
                            } else if mode == "forbidden" {
                                "403 Forbidden"
                            } else {
                                "200 OK"
                            };
                            // Close before response headers to exercise request transport errors,
                            // separately from a valid transient HTTP status.
                            if mode == "query_close" && is_query && query_count == 1 {
                                return;
                            }
                            let response = format!(
                                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n{body}"
                            );
                            for chunk in response.as_bytes().chunks(37) {
                                if socket.write_all(chunk).await.is_err() {
                                    return;
                                }
                                tokio::task::yield_now().await;
                            }
                            if (mode == "timeout" || mode.starts_with("manual_")) && content_type == "text/event-stream"
                            {
                                tokio::time::sleep(Duration::from_secs(2)).await;
                            }
                        });
                    }
                });
                let (_dir, store) = store();
                let reference = store.save_bytes("source.pdf", b"%PDF-original").unwrap();
                let bridge = Arc::new(Mutex::new(
                    WorkflowStateBridge::from_initial_state(json!({"document":reference})).unwrap(),
                ));
                // Grant only the downstream reader; output is node-private otherwise.
                bridge.lock().unwrap().configure_node(
                    "remote",
                    NodeStatePolicy {
                        readers: AccessRule::only(["next"]),
                        ..Default::default()
                    },
                );
                let task_pool = remote_tasks::test_pool().await;
                let node = RemoteAgentNode {
                    id: "remote".into(),
                    auth: RemoteAuth::testing(auth_kind.clone()),
                    authentication: None,
                    tracking_storage: Some((task_pool.clone(), vec![42; 32])),
                    store: Some(store.clone()),
                    url: Url::parse(&url).unwrap(),
                    paths: vec!["document".into()],
                    timeout: Duration::from_secs(if mode.starts_with("manual_") {
                        1
                    } else if mode == "recovery_timeout" {
                        2
                    } else if recovery {
                        15
                    } else {
                        1
                    }),
                    state: Arc::clone(&bridge),
                    state_config: WorkflowNodeStateConfig::default(),
                    on_event: None,
                };
                let graph = StateGraph::with_channels(&["workflow.last_node", "workflow.node", "workflow.trace"])
                    .add_node(node)
                    .add_edge(START, "remote")
                    .add_edge("remote", END)
                    .compile()
                    .unwrap();
                let result = graph
                    .invoke(
                        State::new(),
                        ExecutionConfig::new("a2a-http").with_metadata("workrun.run_id", json!("run-1")),
                    )
                    .await;
                if matches!(mode, "timeout" | "recovery_timeout") || mode.starts_with("manual_") {
                    assert!(result.err().unwrap().to_string().contains("timed out"));
                    assert!(!calls.lock().unwrap().iter().any(|r| r["method"] == "CancelTask"));
                    assert_eq!(
                        calls
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|r| r["method"] == "SendStreamingMessage")
                            .count(),
                        1
                    );
                } else if matches!(mode, "query_401" | "exhaust" | "unknown" | "malformed") {
                    let error = result.err().unwrap().to_string();
                    if mode == "unknown" {
                        assert!(error.contains("outcome is unknown"));
                    }
                    let calls = calls.lock().unwrap();
                    assert_eq!(
                        calls.iter().filter(|r| r["method"] == "SendStreamingMessage").count(),
                        1
                    );
                    assert_eq!(
                        calls.iter().filter(|r| r["method"] == "GetTask").count(),
                        match mode {
                            "exhaust" => 4,
                            "query_401" => 1,
                            _ => 0,
                        }
                    );
                    assert_eq!(calls.iter().filter(|r| r["method"] == "CancelTask").count(), 0);
                } else if matches!(mode, "unauthorized" | "forbidden") {
                    let error = result.err().unwrap().to_string();
                    assert!(error.contains(if mode == "unauthorized" { "401" } else { "403" }));
                    assert!(!error.contains("test-secret"));
                    assert!(
                        bridge
                            .lock()
                            .unwrap()
                            .node_input("next")
                            .unwrap()
                            .get("artifacts")
                            .is_none()
                    );
                } else if mode == "uri" {
                    assert!(result.is_err());
                } else {
                    let result = result.unwrap();
                    let serialized = serde_json::to_string(&result).unwrap();
                    assert!(!serialized.contains("JVBER"));
                    if auth_kind.is_some() {
                        assert!(!serialized.contains("test-secret"));
                    }
                    assert!(!serialized.contains(_dir.path().to_str().unwrap()));
                    let input = bridge.lock().unwrap().node_input("next").unwrap();
                    if auth_kind.is_some() {
                        assert!(!serde_json::to_string(&input).unwrap().contains("test-secret"));
                    }
                    let files = references(&input["artifacts"]).unwrap();
                    assert_eq!(files.len(), if mode == "no_artifacts" { 0 } else { 1 });
                    if mode != "no_artifacts" {
                        assert_eq!(
                            std::fs::read(store.resolve(&files[0]).unwrap()).unwrap(),
                            b"%PDF-generated"
                        );
                        assert_eq!(files[0].mime_type, "application/pdf");
                    }
                    if recovery {
                        let calls = calls.lock().unwrap();
                        assert_eq!(
                            calls.iter().filter(|r| r["method"] == "SendStreamingMessage").count(),
                            1
                        );
                        assert_eq!(
                            calls.iter().filter(|r| r["method"] == "GetTask").count(),
                            if matches!(mode, "query_retry" | "query_close") {
                                2
                            } else {
                                1
                            }
                        );
                        assert!(!calls.iter().any(|r| r["method"] == "CancelTask"));
                        if mode == "discovery_retry" {
                            assert_eq!(calls.iter().filter(|r| r["method"] == "Discovery").count(), 2);
                        }
                    }
                    if mode == "poll" {
                        assert!(calls.lock().unwrap().iter().any(|r| r["method"] == "GetTask"));
                    }
                }
                for _ in 0..20 {
                    let records = remote_tasks::list_remote_tasks(&task_pool, "run-1").await.unwrap();
                    if records
                        .first()
                        .is_none_or(|record| !matches!(record.status.as_str(), "working" | "submitted"))
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let records = remote_tasks::list_remote_tasks(&task_pool, "run-1").await.unwrap();
                if let Some(record) = records.first() {
                    if mode == "timeout" {
                        assert_eq!(record.status, "unknown");
                        assert_eq!(record.task_id.as_deref(), Some("task-1"));
                        // Running workflows cannot be managed independently.
                        assert!(
                            remote_task_operation_in_pool(
                                task_pool.clone(),
                                vec![42; 32],
                                &store,
                                &record.id,
                                RemoteTaskOperation::Query,
                                &IWorkrun::default(),
                                Some(RemoteAuth::testing(auth_kind.clone()))
                            )
                            .await
                            .is_err()
                        );
                        sqlx::query("UPDATE run_records SET status = 'failed' WHERE id = 'run-1'")
                            .execute(&task_pool)
                            .await
                            .unwrap();
                        let query = remote_task_operation_in_pool(
                            task_pool.clone(),
                            vec![42; 32],
                            &store,
                            &record.id,
                            RemoteTaskOperation::Query,
                            &IWorkrun::default(),
                            Some(RemoteAuth::testing(auth_kind.clone())),
                        )
                        .await
                        .unwrap();
                        assert_eq!(query.status, "completed");
                        assert!(query.result.is_none());
                        let fetched = remote_task_operation_in_pool(
                            task_pool.clone(),
                            vec![42; 32],
                            &store,
                            &record.id,
                            RemoteTaskOperation::Fetch,
                            &IWorkrun::default(),
                            Some(RemoteAuth::testing(auth_kind.clone())),
                        )
                        .await
                        .unwrap();
                        let files = references(&fetched.result.as_ref().unwrap()["artifacts"]).unwrap();
                        assert_eq!(
                            std::fs::read(store.resolve(&files[0]).unwrap()).unwrap(),
                            b"%PDF-generated"
                        );
                        let query_count = calls
                            .lock()
                            .unwrap()
                            .iter()
                            .filter(|r| r["method"] == "GetTask")
                            .count();
                        let fetched_again = remote_task_operation_in_pool(
                            task_pool.clone(),
                            vec![42; 32],
                            &store,
                            &record.id,
                            RemoteTaskOperation::Fetch,
                            &IWorkrun::default(),
                            Some(RemoteAuth::testing(auth_kind.clone())),
                        )
                        .await
                        .unwrap();
                        assert_eq!(fetched.result, fetched_again.result);
                        assert_eq!(
                            calls
                                .lock()
                                .unwrap()
                                .iter()
                                .filter(|r| r["method"] == "GetTask")
                                .count(),
                            query_count
                        );
                        let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-1'")
                            .fetch_one(&task_pool)
                            .await
                            .unwrap();
                        assert_eq!(status, "failed");
                    } else if mode.starts_with("manual_") {
                        assert_eq!(record.status, "unknown");
                        sqlx::query("UPDATE run_records SET status = 'failed' WHERE id = 'run-1'")
                            .execute(&task_pool)
                            .await
                            .unwrap();
                        let operation = if matches!(mode, "manual_notfound" | "manual_http404") {
                            RemoteTaskOperation::Query
                        } else {
                            RemoteTaskOperation::Cancel
                        };
                        let result = remote_task_operation_in_pool(
                            task_pool.clone(),
                            vec![42; 32],
                            &store,
                            &record.id,
                            operation,
                            &IWorkrun::default(),
                            Some(RemoteAuth::testing(auth_kind.clone())),
                        )
                        .await;
                        if mode == "manual_refuse" {
                            let error = result.err().unwrap().to_string();
                            assert!(error.contains("-32002"));
                            assert!(!error.contains("test-secret"));
                            assert_eq!(
                                remote_tasks::list_remote_tasks(&task_pool, "run-1").await.unwrap()[0].status,
                                "unknown"
                            );
                        } else {
                            assert_eq!(
                                result.unwrap().status,
                                if mode == "manual_cancel" {
                                    "canceled"
                                } else {
                                    "not_found"
                                }
                            );
                        }
                        let calls = calls.lock().unwrap();
                        assert_eq!(
                            calls
                                .iter()
                                .filter(|call| call["method"] == "SendStreamingMessage")
                                .count(),
                            1
                        );
                        assert_eq!(
                            calls.iter().filter(|call| call["method"] == "CancelTask").count(),
                            usize::from(operation == RemoteTaskOperation::Cancel)
                        );
                    } else if mode == "unknown" {
                        assert!(record.task_id.is_none());
                        assert_eq!(record.status, "unknown");
                        sqlx::query("UPDATE run_records SET status = 'failed' WHERE id = 'run-1'")
                            .execute(&task_pool)
                            .await
                            .unwrap();
                        let calls_before = calls.lock().unwrap().len();
                        let error = remote_task_operation_in_pool(
                            task_pool.clone(),
                            vec![42; 32],
                            &store,
                            &record.id,
                            RemoteTaskOperation::Query,
                            &IWorkrun::default(),
                            Some(RemoteAuth::testing(auth_kind.clone())),
                        )
                        .await
                        .err()
                        .unwrap()
                        .to_string();
                        assert!(error.contains("no remote task ID"));
                        assert_eq!(calls.lock().unwrap().len(), calls_before);
                    }
                }
                server.abort();
            }
        }
        // Exercise the shipped Python fixture too, so the manual acceptance
        // guide depends on a server that actually speaks this adapter's wire format.
        struct Fixture(std::process::Child);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        for (auth_kind, delayed) in [
            (None, false),
            (Some(RemoteCredentialKind::Bearer), false),
            (Some(RemoteCredentialKind::ApiKey), false),
            (Some(RemoteCredentialKind::ApiKey), true),
        ] {
            let mut fixture = Fixture(
                std::process::Command::new("python3")
                    .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../examples/a2a-v1/server.py"))
                    .args([
                        "--port",
                        "0",
                        "--auth",
                        match auth_kind {
                            None => "none",
                            Some(RemoteCredentialKind::Bearer) => "bearer",
                            Some(RemoteCredentialKind::ApiKey) => "apiKey",
                        },
                    ])
                    .args(["--delay-seconds", if delayed { "1.5" } else { "0" }])
                    .args(if delayed { vec!["--disconnect-stream"] } else { vec![] })
                    .env("WORKRUN_A2A_TEST_SECRET", "test-secret")
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .unwrap(),
            );
            use std::io::BufRead;
            let mut line = String::new();
            std::io::BufReader::new(fixture.0.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            let url = Url::parse(line.trim().strip_prefix("A2A fixture: ").unwrap()).unwrap();
            let (_dir, store) = store();
            let originals = [
                ("report.pdf", b"%PDF-original".as_slice()),
                ("image.png", b"\x89PNG\r\n\x1a\nimage".as_slice()),
                ("video.mp4", b"video-fixture".as_slice()),
            ];
            let references = originals
                .iter()
                .map(|(name, data)| store.save_bytes(name, data).unwrap())
                .collect::<Vec<_>>();
            let input = json!({"documents":references});
            let node = RemoteAgentNode {
                id: "fixture".into(),
                auth: RemoteAuth::testing(auth_kind.clone()),
                authentication: None,
                tracking_storage: None,
                store: Some(store.clone()),
                url: url.clone(),
                paths: vec!["documents".into()],
                timeout: Duration::from_secs(5),
                state: Arc::new(Mutex::new(
                    WorkflowStateBridge::from_initial_state(input.clone()).unwrap(),
                )),
                state_config: Default::default(),
                on_event: None,
            };
            let context = NodeContext::new(State::new(), ExecutionConfig::new("python-fixture"), 0);
            let result = node.run(&context, &store, &input).await.unwrap();
            let (receipt, files) = result.output().unwrap();
            assert_eq!(serde_json::from_str::<Value>(&receipt).unwrap()["receivedFiles"], 3);
            assert_eq!(files.len(), 3);
            for ((name, mime, data), (source, original)) in files.iter().zip(originals) {
                assert_eq!(name, &format!("copy-{source}"));
                assert_eq!(data, original);
                let saved = store.save_bytes_with_mime(name, data, mime.as_deref()).unwrap();
                assert_eq!(std::fs::read(store.resolve(&saved).unwrap()).unwrap(), original);
            }
            if delayed {
                let client = RemoteAuth::testing(auth_kind).client().unwrap();
                let rpc_id = uuid::Uuid::new_v4().to_string();
                let rpc = json!({"jsonrpc":"2.0","id":rpc_id,"method":"GetTask","params":{"id":result.task_id,"historyLength":1}});
                let body = client
                    .post(url.join("/a2a").unwrap())
                    .header("A2A-Version", "1.0")
                    .json(&rpc)
                    .send()
                    .await
                    .unwrap();
                let completed = rpc_result(
                    serde_json::from_slice(&bounded_body(body, &context).await.unwrap()).unwrap(),
                    &rpc_id,
                )
                .unwrap();
                assert_eq!(completed["status"]["state"], "TASK_STATE_COMPLETED");
                assert_eq!(completed["artifacts"].as_array().unwrap().len(), 3);
                let rpc_id = uuid::Uuid::new_v4().to_string();
                let rpc = json!({"jsonrpc":"2.0","id":rpc_id,"method":"SendMessage","params":{"message":{"messageId":uuid::Uuid::new_v4().to_string(),"role":"ROLE_USER","parts":input_parts(&input, &["documents".into()], &store).unwrap()}}});
                let body = client
                    .post(url.join("/a2a").unwrap())
                    .header("A2A-Version", "1.0")
                    .json(&rpc)
                    .send()
                    .await
                    .unwrap();
                let working = rpc_result(
                    serde_json::from_slice(&bounded_body(body, &context).await.unwrap()).unwrap(),
                    &rpc_id,
                )
                .unwrap()["task"]
                    .clone();
                assert_eq!(working["status"]["state"], "TASK_STATE_WORKING");
                let rpc_id = uuid::Uuid::new_v4().to_string();
                let rpc = json!({"jsonrpc":"2.0","id":rpc_id,"method":"CancelTask","params":{"id":working["id"]}});
                let body = client
                    .post(url.join("/a2a").unwrap())
                    .header("A2A-Version", "1.0")
                    .json(&rpc)
                    .send()
                    .await
                    .unwrap();
                let cancelled = rpc_result(
                    serde_json::from_slice(&bounded_body(body, &context).await.unwrap()).unwrap(),
                    &rpc_id,
                )
                .unwrap();
                assert_eq!(cancelled["status"]["state"], "TASK_STATE_CANCELED");
                tokio::time::sleep(Duration::from_millis(1600)).await;
                let rpc_id = uuid::Uuid::new_v4().to_string();
                let rpc = json!({"jsonrpc":"2.0","id":rpc_id,"method":"GetTask","params":{"id":working["id"]}});
                let body = client
                    .post(url.join("/a2a").unwrap())
                    .header("A2A-Version", "1.0")
                    .json(&rpc)
                    .send()
                    .await
                    .unwrap();
                let cancelled = rpc_result(
                    serde_json::from_slice(&bounded_body(body, &context).await.unwrap()).unwrap(),
                    &rpc_id,
                )
                .unwrap();
                assert_eq!(cancelled["status"]["state"], "TASK_STATE_CANCELED");
            }
        }
    }
}
