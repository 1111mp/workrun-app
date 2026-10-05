//! A2A v1.0.1 JSON-RPC boundary. Binary resources stay outside State and traces.
use super::remote_auth::RemoteAuth;
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
        bail!("A2A HTTP request failed with status {}", response.status());
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

    fn status(&mut self, status: &Value) -> Result<()> {
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

// Dropping a graph future stops local I/O. If a remote task was already
// allocated, ask the server to stop it too, without delaying local cancellation.
struct RemoteCallGuard {
    client: Client,
    url: Url,
    tenant: Option<String>,
    task: Arc<Mutex<Option<String>>>,
    completed: bool,
}

impl Drop for RemoteCallGuard {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let Some(task) = self.task.lock().ok().and_then(|t| t.clone()) else {
            return;
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let client = self.client.clone();
        let url = self.url.clone();
        let tenant = self.tenant.clone();
        runtime.spawn(async move {
            let mut params = json!({"id":task});
            if let Some(tenant) = tenant {
                params["tenant"] = json!(tenant);
            }
            let request =
                json!({"jsonrpc":"2.0","id":uuid::Uuid::new_v4().to_string(),"method":"CancelTask","params":params});
            let _ = tokio::time::timeout(
                Duration::from_secs(3),
                client.post(url).header("A2A-Version", "1.0").json(&request).send(),
            )
            .await;
        });
    }
}

async fn receive_stream(
    mut response: Response,
    id: &str,
    context: &NodeContext,
    output: &mut RemoteResult,
    task: &Mutex<Option<String>>,
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
                        let accepted = output.accept(rpc_result(serde_json::from_slice(&data)?, id)?);
                        *task.lock().map_err(|_| anyhow!("A2A task lock unavailable"))? = output.task_id.clone();
                        accepted?;
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
        bail!("A2A stream ended in a partial SSE event");
    }
    Ok(())
}

impl RemoteAgentNode {
    async fn run(&self, context: &NodeContext, store: &ArtifactStore, input: &Value) -> Result<RemoteResult> {
        let parts = input_parts(input, &self.paths, store)?;
        let client = self.auth.client()?;
        let card_url = self.url.join("/.well-known/agent-card.json")?;
        let card: Value = serde_json::from_slice(
            &bounded_body(client.get(card_url).header("A2A-Version", "1.0").send().await?, context).await?,
        )?;
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
        let mut guard = RemoteCallGuard {
            client: client.clone(),
            url: url.clone(),
            tenant: tenant.clone(),
            task: Arc::new(Mutex::new(None)),
            completed: false,
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut params = json!({"message":{"messageId":uuid::Uuid::new_v4().to_string(),"role":"ROLE_USER","parts":parts},
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
            .await?;
        let mut result = RemoteResult::default();
        if streaming {
            receive_stream(response, &id, context, &mut result, &guard.task).await?;
        } else {
            result.accept(rpc_result(
                serde_json::from_slice(&bounded_body(response, context).await?)?,
                &id,
            )?)?;
        }
        *guard.task.lock().map_err(|_| anyhow!("A2A task lock unavailable"))? = result.task_id.clone();
        // A server may return a nonterminal Task despite blocking configuration.
        // Poll the same task; never resend the original message and its files.
        while !result.complete {
            let task = result
                .task_id
                .clone()
                .context("A2A incomplete response has no task ID")?;
            tokio::time::sleep(Duration::from_millis(250)).await;
            let id = uuid::Uuid::new_v4().to_string();
            let mut params = json!({"id":task,"historyLength":0});
            if let Some(tenant) = &tenant {
                params["tenant"] = json!(tenant);
            }
            let request = json!({"jsonrpc":"2.0","id":id,"method":"GetTask","params":params});
            let response = client
                .post(url.clone())
                .header("A2A-Version", "1.0")
                .json(&request)
                .send()
                .await?;
            let task = rpc_result(serde_json::from_slice(&bounded_body(response, context).await?)?, &id)?;
            // GetTask returns Task directly, unlike SendMessage's union wrapper.
            result.accept(json!({"task":task}))?;
        }
        guard.completed = true;
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
            let values = json!({"response":response,"messages":[{"role":"assistant","content":response}],"artifacts":artifacts,"remoteTaskId":remote.task_id.map(|id| self.auth.redact(&id))});
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
            for mode in ["stream", "send", "poll", "timeout", "uri", "unauthorized", "forbidden"] {
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
                                let mut card = json!({"supportedInterfaces":[{"url":format!("{base}/rpc"),"protocolBinding":"JSONRPC","protocolVersion":"1.0","tenant":"team"}],
                                "capabilities":{"streaming":matches!(mode,"stream"|"timeout")},"defaultInputModes":["text/plain","application/pdf"]});
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
                                let task = json!({"id":"task-1","status":{"state":"TASK_STATE_COMPLETED","message":{"role":"ROLE_AGENT","parts":[{"text":"reply test-secret"}]}},"artifacts":[{"artifactId":"pdf","name":"processed.pdf",
                                "parts":[{"raw":STANDARD.encode(b"%PDF-generated"),"filename":"processed-test-secret.pdf","mediaType":"application/pdf"}]}]});
                                let reply =
                                    |result: Value| json!({"jsonrpc":"2.0","id":rpc["id"],"result":result}).to_string();
                                if method == "CancelTask" {
                                    assert_eq!(rpc["params"]["id"], "task-1");
                                    ("application/json", reply(task))
                                } else if method == "GetTask" {
                                    ("application/json", reply(task))
                                } else {
                                    assert_eq!(rpc["params"]["message"]["role"], "ROLE_USER");
                                    assert_eq!(
                                        STANDARD
                                            .decode(rpc["params"]["message"]["parts"][1]["raw"].as_str().unwrap())
                                            .unwrap(),
                                        b"%PDF-original"
                                    );
                                    if matches!(mode, "stream" | "timeout") {
                                        assert_eq!(method, "SendStreamingMessage");
                                        let initial = reply(
                                            json!({"task":{"id":"task-1","status":{"state":"TASK_STATE_WORKING"}}}),
                                        );
                                        let body = if mode == "timeout" {
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
                                + if mode == "timeout" && content_type == "text/event-stream" {
                                    100
                                } else {
                                    0
                                };
                            let status = if mode == "unauthorized" {
                                "401 Unauthorized"
                            } else if mode == "forbidden" {
                                "403 Forbidden"
                            } else {
                                "200 OK"
                            };
                            let response = format!(
                                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {declared}\r\nConnection: close\r\n\r\n{body}"
                            );
                            for chunk in response.as_bytes().chunks(37) {
                                if socket.write_all(chunk).await.is_err() {
                                    return;
                                }
                                tokio::task::yield_now().await;
                            }
                            if mode == "timeout" && content_type == "text/event-stream" {
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
                let node = RemoteAgentNode {
                    id: "remote".into(),
                    auth: RemoteAuth::testing(auth_kind.clone()),
                    store: Some(store.clone()),
                    url: Url::parse(&url).unwrap(),
                    paths: vec!["document".into()],
                    timeout: Duration::from_secs(1),
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
                let result = graph.invoke(State::new(), ExecutionConfig::new("a2a-http")).await;
                if mode == "timeout" {
                    assert!(result.err().unwrap().to_string().contains("timed out"));
                    for _ in 0..20 {
                        if calls.lock().unwrap().iter().any(|r| r["method"] == "CancelTask") {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    assert!(calls.lock().unwrap().iter().any(|r| r["method"] == "CancelTask"));
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
                    assert_eq!(files.len(), 1);
                    assert_eq!(
                        std::fs::read(store.resolve(&files[0]).unwrap()).unwrap(),
                        b"%PDF-generated"
                    );
                    assert_eq!(files[0].mime_type, "application/pdf");
                    if mode == "poll" {
                        assert!(calls.lock().unwrap().iter().any(|r| r["method"] == "GetTask"));
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
        for auth_kind in [
            None,
            Some(RemoteCredentialKind::Bearer),
            Some(RemoteCredentialKind::ApiKey),
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
                store: Some(store.clone()),
                url,
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
        }
    }
}
