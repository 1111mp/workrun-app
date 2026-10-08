//! Durable compensation provenance and execution from original records.
use super::*;
use serde_json::Map;
use sqlx::Row;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Declaration {
    #[default]
    Unspecified,
    ReadOnly,
    Irreversible {
        reason: String,
    },
    Compensatable {
        action: Action,
        bindings: BTreeMap<String, Binding>,
        idempotency: Idempotency,
    },
    Delegated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(super) enum Action {
    AppEntry,
    Tool {
        tool_id: String,
    },
    Process {
        process_node_id: String,
    },
    RemoteAgent {
        url: String,
        #[serde(default)]
        authentication: Option<RemoteAuthentication>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Binding {
    Literal { value: Value },
    Input { pointer: String },
    Output { pointer: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Idempotency {
    pub key_argument: String,
    /// A declaration by the workflow author, not a locally verified guarantee.
    pub contract: String,
}

#[derive(Serialize, Deserialize)]
struct SavedContext {
    declaration: Declaration,
    input: Value,
    execution_snapshot: Value,
    compensation_target_snapshot: Value,
}

impl Declaration {
    fn mode(&self) -> &'static str {
        match self {
            Self::Unspecified => "unspecified",
            Self::ReadOnly => "read_only",
            Self::Irreversible { .. } => "irreversible",
            Self::Compensatable { .. } => "compensatable",
            Self::Delegated => "delegated",
        }
    }

    pub fn validate(&self, container: bool) -> Result<()> {
        if container && !matches!(self, Self::Delegated) {
            bail!("Subworkflow compensation must be delegated to descendant operations");
        }
        if !container && matches!(self, Self::Delegated) {
            bail!("Only subworkflow containers can delegate compensation");
        }
        match self {
            Self::Irreversible { reason } if reason.trim().is_empty() => bail!("Irreversible operation needs a reason"),
            Self::Compensatable {
                action,
                bindings,
                idempotency,
            } => {
                if idempotency.contract.trim().is_empty() || idempotency.key_argument.trim().is_empty() {
                    bail!("Compensation requires an explicit external idempotency contract and key argument");
                }
                if matches!(action, Action::AppEntry)
                    && (!bindings.is_empty() || idempotency.key_argument != "compensationId")
                {
                    bail!(
                        "Same-App compensation uses the frozen original context and compensationId; custom bindings are not allowed"
                    );
                }
                if bindings.contains_key(&idempotency.key_argument) {
                    bail!("Compensation idempotency key argument cannot be overwritten by a binding");
                }
                match action {
                    Action::Tool { tool_id } if tool_id.trim().is_empty() => bail!("Compensation toolId is required"),
                    Action::Process { process_node_id } if process_node_id.trim().is_empty() => {
                        bail!("Compensation processNodeId is required")
                    },
                    Action::RemoteAgent { url, .. } => {
                        let url =
                            tauri_plugin_http::reqwest::Url::parse(url).context("Invalid compensation Remote URL")?;
                        if !matches!(url.scheme(), "http" | "https")
                            || !url.username().is_empty()
                            || url.password().is_some()
                        {
                            bail!("Compensation Remote URL must use HTTP(S) without embedded credentials");
                        }
                    },
                    _ => {},
                }
                for (argument, binding) in bindings {
                    if argument.trim().is_empty() {
                        bail!("Compensation binding argument is required");
                    }
                    if let Binding::Input { pointer } | Binding::Output { pointer } = binding {
                        if !pointer.is_empty() && !pointer.starts_with('/') {
                            bail!("Compensation bindings use JSON pointers to original input/output");
                        }
                        let bytes = pointer.as_bytes();
                        for (index, byte) in bytes.iter().enumerate() {
                            if *byte == b'~' && !matches!(bytes.get(index + 1), Some(b'0' | b'1')) {
                                bail!("Invalid compensation JSON pointer escape");
                            }
                        }
                    }
                }
            },
            _ => {},
        }
        Ok(())
    }

    async fn target_snapshot(&self, snapshot: &Value) -> Result<Value> {
        match self {
            Self::Compensatable {
                action: Action::AppEntry,
                ..
            } => {
                let app = snapshot.get("app").unwrap_or(&snapshot["definition"]);
                let definition: crate::config::IProcessNode = serde_json::from_value(app.clone())?;
                crate::config::validate_process_node_definition(&definition)?;
                if definition.compensation.is_none() {
                    bail!("Original App has no compensation entry");
                }
                Ok(json!({"app":app,"sourceDigest":crate::feat::process_compensation_fingerprint(&definition).await?}))
            },
            Self::Compensatable {
                action: Action::Tool { tool_id },
                ..
            } => {
                let mut definitions = ToolRegistry::resolve(std::slice::from_ref(tool_id)).await?;
                let definition = definitions.remove(0);
                let process = if definition.source == ToolSource::Process {
                    serde_json::to_value(crate::feat::get_process_node(tool_id).await?)?
                } else {
                    Value::Null
                };
                let mcp_connection = if definition.source == ToolSource::Mcp {
                    mcp_connection(
                        definition
                            .source_id
                            .as_deref()
                            .context("MCP target server identity missing")?,
                    )
                    .await?
                } else {
                    Value::Null
                };
                Ok(json!({"tool":definition,"process":process,"mcpConnection":mcp_connection}))
            },
            Self::Compensatable {
                action: Action::Process { process_node_id },
                ..
            } => {
                let definition = crate::feat::get_process_node(process_node_id).await?;
                if definition.kind != crate::config::ProcessNodeKind::Workflow {
                    bail!("Compensation Process target must be a Workflow App");
                }
                Ok(serde_json::to_value(definition)?)
            },
            Self::Compensatable {
                action: Action::RemoteAgent { .. },
                ..
            } => Ok(serde_json::to_value(self)?),
            _ => Ok(Value::Null),
        }
    }
}

/// App entry configuration enables automatic cleanup. The App definition
/// comes from the execution snapshot, never a fresh compensation-time lookup.
pub(super) fn execution_declaration(snapshot: &Value, container: bool) -> Result<Declaration> {
    let app = snapshot.get("app").unwrap_or(&snapshot["definition"]);
    if let Some(value) = app.get("compensation").filter(|value| !value.is_null()) {
        let _: crate::config::ProcessCompensation = serde_json::from_value(value.clone())?;
        let result = Declaration::Compensatable {
            action: Action::AppEntry,
            bindings: BTreeMap::new(),
            idempotency: Idempotency {
                key_argument: "compensationId".into(),
                contract: "App failure cleanup uses the original successful invocation".into(),
            },
        };
        result.validate(container)?;
        return Ok(result);
    }
    declaration(snapshot.get("compensation"), container)
}

/// Only the same-App entry is eligible for automatic workflow-failure cleanup.
pub(super) fn app_cleanup_metadata(ciphertext: &str, key: &[u8]) -> Result<Option<(String, String)>> {
    let context: SavedContext = decrypt(ciphertext, key)?;
    if !matches!(
        context.declaration,
        Declaration::Compensatable {
            action: Action::AppEntry,
            ..
        }
    ) {
        return Ok(None);
    }
    let app: crate::config::IProcessNode = serde_json::from_value(context.compensation_target_snapshot["app"].clone())?;
    let entry = app.compensation.context("Saved App cleanup entry missing")?.entry;
    Ok(Some((app.name, entry.to_string_lossy().into_owned())))
}

pub(super) fn declaration(value: Option<&Value>, container: bool) -> Result<Declaration> {
    let declaration = match value.filter(|value| !value.is_null()) {
        Some(value) => serde_json::from_value(value.clone()).context("Invalid compensation declaration")?,
        None if container => Declaration::Delegated,
        None => Declaration::Unspecified,
    };
    declaration.validate(container)?;
    Ok(declaration)
}

async fn mcp_connection(server_id: &str) -> Result<Value> {
    let catalog = crate::config::Config::mcp_servers().await.data_arc();
    let server = catalog
        .get_mcp_server(server_id)
        .context("Compensation MCP server is missing")?;
    // Authentication can refresh independently. Freeze routing/runtime inputs
    // so a catalog edit cannot send an old compensation to a different server.
    Ok(
        json!({"id":server.id,"transport":server.transport,"command":server.command,"args":server.args,"env":server.env,"url":server.url,"auth":server.auth}),
    )
}

fn encrypt<T: Serialize>(value: &T, key: &[u8]) -> Result<String> {
    crate::config::encrypt_data_with_key(&serde_json::to_string(value)?, key)
        .map_err(|_| anyhow!("Cannot encrypt compensation provenance"))
}
fn decrypt<T: serde::de::DeserializeOwned>(value: &str, key: &[u8]) -> Result<T> {
    let plaintext = crate::config::decrypt_data_with_key(value, key)
        .map_err(|_| anyhow!("Cannot decrypt compensation provenance"))?;
    Ok(serde_json::from_str(&plaintext)?)
}

pub(super) async fn prepare(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    operation_id: &str,
    declaration: &Declaration,
    input: &Value,
    snapshot: &Value,
) -> Result<()> {
    let original: (String, String) =
        sqlx::query_as("SELECT input_digest,snapshot_digest FROM workflow_operations WHERE id=?")
            .bind(operation_id)
            .fetch_one(pool)
            .await?;
    if original != (operations::digest(input), operations::digest(snapshot)) {
        bail!("Compensation provenance must use the original operation input and snapshot");
    }
    let digest = operations::digest(&serde_json::to_value(declaration)?);
    let existing: Option<String> =
        sqlx::query_scalar("SELECT declaration_digest FROM workflow_compensation_intents WHERE operation_id = ?")
            .bind(operation_id)
            .fetch_optional(pool)
            .await?;
    if let Some(existing) = existing {
        if existing != digest {
            bail!("Compensation declaration changed; recovery requires the original contract");
        }
        return Ok(());
    }
    if let Declaration::Compensatable { bindings, .. } = declaration {
        for binding in bindings.values() {
            if let Binding::Input { pointer } = binding
                && input.pointer(pointer).is_none()
            {
                bail!("Compensation binding is missing from the original input");
            }
        }
    }
    // Resolve a mutable target once, before external dispatch. Recovery never
    // replaces that snapshot with the current catalog contract.
    let context = SavedContext {
        declaration: declaration.clone(),
        input: input.clone(),
        execution_snapshot: snapshot.clone(),
        compensation_target_snapshot: declaration.target_snapshot(snapshot).await?,
    };
    let ciphertext = encrypt(&context, key)?;
    let now = chrono::Utc::now().to_rfc3339();
    let id = uuid::Uuid::new_v4().to_string();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let dispatched: Option<String> = sqlx::query_scalar("SELECT dispatched_at FROM workflow_operations WHERE id = ?")
        .bind(operation_id)
        .fetch_one(&mut *tx)
        .await?;
    let provenance = if dispatched.is_some() {
        "after_dispatch"
    } else {
        "before_dispatch"
    };
    sqlx::query("INSERT INTO workflow_compensation_intents (id,operation_id,mode,provenance,declaration_digest,context_ciphertext,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(&id).bind(operation_id).bind(declaration.mode()).bind(provenance).bind(digest).bind(ciphertext).bind(&now).bind(&now).execute(&mut *tx).await?;
    sqlx::query("UPDATE workflow_operations SET compensation_required = 1 WHERE id = ?")
        .bind(operation_id)
        .execute(&mut *tx)
        .await?;
    event(&mut tx, &id, "intent_recorded", &now).await?;
    tx.commit().await?;
    Ok(())
}

async fn event(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, id: &str, kind: &str, now: &str) -> Result<()> {
    sqlx::query("INSERT INTO workflow_compensation_events (id,intent_id,sequence,kind,created_at) SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,? FROM workflow_compensation_events WHERE intent_id=?")
        .bind(uuid::Uuid::new_v4().to_string()).bind(id).bind(kind).bind(now).bind(id).execute(&mut **tx).await?;
    Ok(())
}

pub(super) async fn capture_outcome(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    key: &[u8],
    operation_id: &str,
    result: &Value,
) -> Result<()> {
    let adapter: String = sqlx::query_scalar("SELECT adapter FROM workflow_operations WHERE id=?")
        .bind(operation_id)
        .fetch_one(&mut **tx)
        .await?;
    let decoded = if adapter == "tool"
        && let Some(ciphertext) = result.get("toolResultCiphertext").and_then(Value::as_str)
    {
        decrypt::<Value>(ciphertext, key)?
    } else if matches!(adapter.as_str(), "process" | "subworkflow")
        && let Some(ciphertext) = result
            .get("processResultCiphertext")
            .or_else(|| result.get("subworkflowResultCiphertext"))
            .and_then(Value::as_str)
    {
        decrypt::<Value>(ciphertext, key)?["result"].clone()
    } else {
        result.clone()
    };
    let (resources, resources_valid) = match crate::module::artifact::references(&decoded) {
        Ok(resources) => (resources, true),
        Err(_) => (Vec::new(), false),
    };
    let ciphertext = encrypt(
        &json!({"output":decoded, "resources":resources, "resourcesValid":resources_valid}),
        key,
    )?;
    let now = chrono::Utc::now().to_rfc3339();
    let id: String = sqlx::query_scalar("SELECT id FROM workflow_compensation_intents WHERE operation_id=?")
        .bind(operation_id)
        .fetch_one(&mut **tx)
        .await?;
    let changed = sqlx::query("UPDATE workflow_compensation_intents SET outcome_ciphertext=?, updated_at=? WHERE id=? AND outcome_ciphertext IS NULL")
        .bind(ciphertext).bind(&now).bind(&id).execute(&mut **tx).await?.rows_affected();
    if changed == 1 {
        event(tx, &id, "outcome_recorded", &now).await?;
    }
    Ok(())
}

/// Build arguments exclusively from immutable original records. This function
/// neither activates compensation nor claims an executor retry is safe.
pub(crate) async fn arguments(pool: &sqlx::SqlitePool, key: &[u8], operation_id: &str) -> Result<Value> {
    let known: bool =
        sqlx::query_scalar("SELECT status='succeeded' AND result_json IS NOT NULL FROM workflow_operations WHERE id=?")
            .bind(operation_id)
            .fetch_one(pool)
            .await?;
    if !known {
        bail!("Original operation must be reconciled and stopped before preparing compensation");
    }
    let row = sqlx::query("SELECT * FROM workflow_compensation_intents WHERE operation_id=?")
        .bind(operation_id)
        .fetch_one(pool)
        .await?;
    if row.get::<String, _>("provenance") != "before_dispatch" {
        bail!("Compensation intent was recorded after dispatch; manual reconciliation required");
    }
    let context: SavedContext = decrypt(&row.get::<String, _>("context_ciphertext"), key)?;
    let Declaration::Compensatable {
        bindings,
        idempotency,
        action,
    } = context.declaration
    else {
        bail!("Operation has no executable compensation contract");
    };
    let outcome: Option<String> = row.get("outcome_ciphertext");
    let outcome = outcome.map(|value| decrypt::<Value>(&value, key)).transpose()?;
    let mut arguments = Map::new();
    if matches!(action, Action::AppEntry) {
        let outcome = outcome.as_ref().context("Original App outcome is unavailable")?;
        arguments.insert("originalOperationId".into(), json!(operation_id));
        arguments.insert("originalInput".into(), context.input.clone());
        arguments.insert("originalResult".into(), outcome["output"].clone());
        arguments.insert("resources".into(), outcome["resources"].clone());
    }

    for (argument, binding) in bindings {
        let value = match binding {
            Binding::Literal { value } => value,
            Binding::Input { pointer } => context
                .input
                .pointer(&pointer)
                .context("Original compensation input binding is missing")?
                .clone(),
            Binding::Output { pointer } => outcome
                .as_ref()
                .context("Compensation needs an original outcome; reconcile before scheduling")?["output"]
                .pointer(&pointer)
                .context("Original compensation output binding is missing")?
                .clone(),
        };
        arguments.insert(argument, value);
    }
    arguments.insert(idempotency.key_argument, json!(row.get::<String, _>("id")));
    Ok(Value::Object(arguments))
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Summary {
    pub id: String,
    pub mode: String,
    pub status: String,
    pub provenance: String,
    pub outcome_recorded: bool,
    /// Argument availability alone does not authorize compensation execution.
    pub arguments_available: bool,
    pub last_error: Option<String>,
}

pub(crate) async fn inspect(pool: &sqlx::SqlitePool, operation_id: &str) -> Result<Option<Summary>> {
    let mut summary: Option<Summary> = sqlx::query_as("SELECT id,mode,status,provenance,outcome_ciphertext IS NOT NULL AS outcome_recorded,0 AS arguments_available,last_error FROM workflow_compensation_intents WHERE operation_id=?")
        .bind(operation_id).fetch_optional(pool).await?;
    if let Some(summary) = &mut summary
        && summary.mode == "compensatable"
        && summary.provenance == "before_dispatch"
    {
        // Inspection must remain available when workspace decryption fails;
        // the worker still blocks execution until original arguments decrypt.
        if let Ok(key) = crate::utils::dirs::get_encryption_key() {
            summary.arguments_available = arguments(pool, &key, operation_id).await.is_ok();
        }
    }
    Ok(summary)
}

pub(super) async fn execute_compensation(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    run_id: &str,
    intent_id: &str,
    operation_id: &str,
) -> Result<()> {
    let authorized: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_abandonments b JOIN workflow_compensation_intents i ON i.id=? WHERE b.run_id=? AND b.status='running' AND i.status='running' AND i.operation_id=?)")
        .bind(intent_id).bind(run_id).bind(operation_id).fetch_one(pool).await?;
    if !authorized {
        bail!("Compensation requires a claimed durable abandonment and intent");
    }
    let args = arguments(pool, key, operation_id).await?;
    let ciphertext: String = sqlx::query_scalar(
        "SELECT context_ciphertext FROM workflow_compensation_intents WHERE id=? AND operation_id=?",
    )
    .bind(intent_id)
    .bind(operation_id)
    .fetch_one(pool)
    .await?;
    let context: SavedContext = decrypt(&ciphertext, key)?;
    let Declaration::Compensatable { action, .. } = &context.declaration else {
        bail!("No compensation action");
    };
    let adapter = match action {
        Action::RemoteAgent { .. } => "remote_agent",
        Action::Process { .. } | Action::AppEntry => "process",
        Action::Tool { .. } => "tool",
    };
    let snapshot = json!({"declaration":context.declaration,"target":context.compensation_target_snapshot});
    let mut op =
        operations::Operation::enter_compensation(pool.clone(), run_id, intent_id, adapter, &args, &snapshot).await?;
    if let Some(saved) = op.result.clone() {
        op.finish(Some(&saved), "succeeded", None).await?;
        return Ok(());
    }
    if !op.can_submit && adapter != "remote_agent" {
        op.finish(
            None,
            "unknown",
            Some("Compensation outcome unknown; this adapter cannot reconcile"),
        )
        .await?;
        bail!("Compensation outcome unknown; resubmission disabled");
    }
    let output = Arc::new(std::sync::Mutex::new(String::new()));
    let captured_output = output.clone();
    let work = async {
        let value = match action {
            Action::RemoteAgent { url, authentication } => {
                let config = BaseConfig::workrun().await.latest_arc();
                super::remote_agent::execute_compensation_remote(
                    pool,
                    key,
                    run_id,
                    url,
                    authentication.as_ref(),
                    &args,
                    &mut op,
                    &config,
                    &crate::module::artifact::ArtifactStore::active()?,
                )
                .await?
            },
            Action::AppEntry => {
                let definition: crate::config::IProcessNode =
                    serde_json::from_value(context.compensation_target_snapshot["app"].clone())?;
                let source_digest = context.compensation_target_snapshot["sourceDigest"]
                    .as_str()
                    .context("Original App source digest missing")?;
                if crate::feat::process_compensation_fingerprint(&definition).await? != source_digest {
                    bail!("Original App source changed; restore the original code and lockfile before compensation");
                }
                op.mark_dispatched().await?;
                tokio::time::timeout(
                    std::time::Duration::from_secs(120),
                    crate::module::process_node::ProcessNodeRegistry::run_for_compensation(
                        definition,
                        &args,
                        source_digest,
                        Arc::new(move |chunk| {
                            let mut log = captured_output.lock().expect("Compensation output lock poisoned");
                            // Keep output bounded while preserving stdout/stderr arrival order.
                            if log.len() < 256 * 1024 {
                                log.push_str(&chunk.data);
                            }
                        }),
                    ),
                )
                .await??
                .result
            },
            Action::Process { .. } => {
                let definition: crate::config::IProcessNode =
                    serde_json::from_value(context.compensation_target_snapshot.clone())?;
                op.mark_dispatched().await?;
                let run = tokio::time::timeout(
                    std::time::Duration::from_secs(120),
                    crate::module::process_node::ProcessNodeRegistry::run_for_workflow(
                        definition,
                        &args,
                        Arc::new(|_| {}),
                    ),
                )
                .await??;
                run.result
            },
            Action::Tool { tool_id } => {
                let definition: ToolDefinition =
                    serde_json::from_value(context.compensation_target_snapshot["tool"].clone())
                        .context("Saved compensation tool contract is incomplete")?;
                if definition.execution_policy != ToolExecutionPolicy::Auto {
                    operation_review::require_approval(pool, key, &op.id, &definition.display_name, &args).await?;
                }
                validate_tool_value(&definition.input_schema, &args, "compensation input")
                    .map_err(|error| anyhow!(error))?;
                match definition.source {
                    ToolSource::Process => {
                        let process: crate::config::IProcessNode =
                            serde_json::from_value(context.compensation_target_snapshot["process"].clone())?;
                        op.mark_dispatched().await?;
                        let run = tokio::time::timeout(
                            std::time::Duration::from_secs(120),
                            crate::module::process_node::ProcessNodeRegistry::run_for_tool(
                                process,
                                &args,
                                Arc::new(|_| {}),
                            ),
                        )
                        .await??;
                        run.result
                    },
                    ToolSource::Mcp => {
                        let current_connection = mcp_connection(
                            definition
                                .source_id
                                .as_deref()
                                .context("MCP target server identity missing")?,
                        )
                        .await?;
                        if operations::digest(&current_connection)
                            != operations::digest(&context.compensation_target_snapshot["mcpConnection"])
                        {
                            bail!("Compensation MCP connection changed; restore the original target");
                        }
                        let (current, tool) = crate::feat::resolve_mcp_tool(tool_id).await?;
                        if operations::digest(&serde_json::to_value(current)?)
                            != operations::digest(&serde_json::to_value(&definition)?)
                        {
                            bail!("Compensation MCP contract changed; restore the original contract");
                        }
                        op.mark_dispatched().await?;
                        let tool_context = Arc::new(
                            adk_rust::tool::SimpleToolContext::new("workrun-compensation")
                                .with_function_call_id(intent_id)
                                .with_session_id(format!("compensation:{run_id}")),
                        );
                        tokio::time::timeout(
                            std::time::Duration::from_secs(120),
                            tool.execute(tool_context, args.clone()),
                        )
                        .await??
                    },
                }
            },
        };
        Ok::<_, anyhow::Error>(value)
    }
    .await;
    let log = output.lock().expect("Compensation output lock poisoned").clone();
    match work {
        Ok(value) => {
            // Save the business fact before changing the compensation intent.
            // A crash in between reuses this result, never invokes undo twice.
            let saved = json!({"compensationResultCiphertext":encrypt(&value,key)?});
            op.finish(Some(&saved), "succeeded", None).await?;
            super::process_cleanup::record_output(pool, key, run_id, intent_id, operation_id, &log).await?;
            Ok(())
        },
        Err(error) => {
            op.finish(None, "unknown", Some("Compensation did not return a durable result"))
                .await?;
            super::process_cleanup::record_output(pool, key, run_id, intent_id, operation_id, &log).await?;
            Err(error)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::operations::Operation;
    use super::*;

    #[tokio::test]
    async fn app_entry_inherits_for_process_and_tool_and_freezes_original_context() {
        for adapter in ["process", "tool"] {
            let directory = tempfile::tempdir().unwrap();
            let project = directory.path().join("019b812d-4958-7d37-8a45-47e1e20a4744");
            std::fs::create_dir(&project).unwrap();
            for (name, content) in [
                ("main.py", "print('business')"),
                ("compensate.py", "print('undo')"),
                ("shared.py", "VALUE=1"),
                ("pyproject.toml", "[project]\nname='fixture'\nversion='0.1.0'"),
                ("uv.lock", "fixture lock"),
            ] {
                std::fs::write(project.join(name), content).unwrap();
            }
            let definition: crate::config::IProcessNode = serde_json::from_value(json!({
                "id":"019b812d-4958-7d37-8a45-47e1e20a4744","name":"Upload","version":"0.1.0","entry":"main.py",
                "projectRoot":directory.path(),"kind":if adapter=="tool" {"tool"} else {"workflow"},
                "compensation":{"entry":"compensate.py","idempotencyContract":"Deleting absent resources succeeds"}
            }))
            .unwrap();
            let definition = serde_json::to_value(definition).unwrap();
            let snapshot = if adapter == "tool" {
                json!({"app":definition})
            } else {
                json!({"definition":definition})
            };
            let pool = super::super::remote_tasks::test_pool().await;
            let key = &[31; 32];
            let mut op = Operation::enter(
                pool.clone(),
                "run-1",
                "upload",
                "run-1",
                adapter,
                &json!({"file":"original"}),
                &snapshot,
            )
            .await
            .unwrap();
            op.prepare_compensation(key, &json!({"file":"original"}), &snapshot)
                .await
                .unwrap();
            op.mark_dispatched().await.unwrap();
            let output = if adapter == "tool" {
                json!({"toolResultCiphertext":encrypt(&json!({"fileId":"file-1"}),key).unwrap()})
            } else {
                json!({"processResultCiphertext":encrypt(&json!({"exitCode":0,"result":{"fileId":"file-1"}}),key).unwrap()})
            };
            op.finish(Some(&output), "succeeded", None).await.unwrap();
            let args = arguments(&pool, key, &op.id).await.unwrap();
            assert_eq!(args["originalInput"], json!({"file":"original"}));
            assert_eq!(args["originalResult"], json!({"fileId":"file-1"}));
            assert_eq!(args["originalOperationId"], op.id);
            assert!(args["compensationId"].is_string());
            let ciphertext: String =
                sqlx::query_scalar("SELECT context_ciphertext FROM workflow_compensation_intents WHERE operation_id=?")
                    .bind(&op.id)
                    .fetch_one(&pool)
                    .await
                    .unwrap();
            let saved: SavedContext = decrypt(&ciphertext, key).unwrap();
            let app: crate::config::IProcessNode =
                serde_json::from_value(saved.compensation_target_snapshot["app"].clone()).unwrap();
            let before = crate::feat::process_compensation_fingerprint(&app).await.unwrap();
            assert_eq!(saved.compensation_target_snapshot["sourceDigest"], before);
            std::fs::write(project.join("shared.py"), "VALUE=2").unwrap();
            assert_ne!(
                crate::feat::process_compensation_fingerprint(&app).await.unwrap(),
                before
            );
            assert_eq!(arguments(&pool, key, &op.id).await.unwrap(), args);
            let override_snapshot = json!({"app":snapshot.get("app").unwrap_or(&snapshot["definition"]),"compensation":{"mode":"read_only"}});
            assert!(matches!(
                execution_declaration(&override_snapshot, false).unwrap(),
                Declaration::Compensatable {
                    action: Action::AppEntry,
                    ..
                }
            ));
        }
    }

    fn snapshot() -> Value {
        json!({"version":1,"compensation":{
            "mode":"compensatable", "action":{"kind":"remote_agent","url":"https://fixture.invalid/undo"},
            "bindings":{"resourceId":{"from":"output","pointer":"/resourceId"},"folder":{"from":"input","pointer":"/folder"}},
            "idempotency":{"keyArgument":"requestId","contract":"Service deduplicates undo requests by requestId"}
        }})
    }

    #[tokio::test]
    async fn intent_precedes_dispatch_and_original_arguments_survive_restart_and_reuse() {
        let pool = super::super::remote_tasks::test_pool().await;
        let input = json!({"folder":"original-private-folder"});
        let snapshot = snapshot();
        let mut op = Operation::enter(pool.clone(), "run-1", "effect", "run-1", "tool", &input, &snapshot)
            .await
            .unwrap();
        op.prepare_compensation(&[42; 32], &input, &snapshot).await.unwrap();
        let provenance: String = sqlx::query_scalar("SELECT provenance FROM workflow_compensation_intents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(provenance, "before_dispatch");
        let dispatched: Option<String> = sqlx::query_scalar("SELECT dispatched_at FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(dispatched.is_none());
        op.mark_dispatched().await.unwrap();
        let ciphertext = encrypt(&json!({"resourceId":"original-resource"}), &[42; 32]).unwrap();
        let output = json!({"toolResultCiphertext":ciphertext});
        op.finish(Some(&output), "succeeded", None).await.unwrap();
        let args = arguments(&pool, &[42; 32], &op.id).await.unwrap();
        assert_eq!(args["folder"], "original-private-folder");
        assert_eq!(args["resourceId"], "original-resource");
        let id: String = sqlx::query_scalar("SELECT id FROM workflow_compensation_intents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(args["requestId"], id);
        super::super::operations::recover_interrupted(&pool).await.unwrap();
        let mut resumed = Operation::enter(pool.clone(), "run-1", "effect", "run-1", "tool", &input, &snapshot)
            .await
            .unwrap();
        resumed
            .prepare_compensation(&[42; 32], &input, &snapshot)
            .await
            .unwrap();
        // The original result, not a current State or a later adapter rendering,
        // remains the compensation source after a reuse attempt.
        resumed.finish(Some(&output), "succeeded", None).await.unwrap();
        assert_eq!(arguments(&pool, &[42; 32], &op.id).await.unwrap(), args);
        let events: Vec<String> = sqlx::query_scalar("SELECT kind FROM workflow_compensation_events ORDER BY sequence")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(events, ["intent_recorded", "outcome_recorded"]);
        let row = sqlx::query("SELECT status,context_ciphertext,outcome_ciphertext FROM workflow_compensation_intents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(row.get::<String, _>("status"), "not_requested");
        assert!(
            !row.get::<String, _>("context_ciphertext")
                .contains("original-private-folder")
        );
        assert!(!row.get::<String, _>("outcome_ciphertext").contains("original-resource"));
    }

    #[tokio::test]
    async fn missing_persisted_intent_blocks_external_dispatch() {
        let pool = super::super::remote_tasks::test_pool().await;
        let mut op = Operation::enter(
            pool.clone(),
            "run-1",
            "effect",
            "run-1",
            "process",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        op.prepare_compensation(&[42; 32], &json!({}), &json!({}))
            .await
            .unwrap();
        sqlx::query("DELETE FROM workflow_compensation_intents")
            .execute(&pool)
            .await
            .unwrap();
        assert!(op.mark_dispatched().await.is_err());
        let dispatched: Option<String> = sqlx::query_scalar("SELECT dispatched_at FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(dispatched.is_none());
        op.finish(None, "failed", Some("intent unavailable")).await.unwrap();
    }

    #[tokio::test]
    async fn unknown_and_definite_failure_keep_intent_without_activating_compensation() {
        for status in ["unknown", "failed"] {
            let pool = super::super::remote_tasks::test_pool().await;
            let input = json!({"folder":"original"});
            let snapshot = snapshot();
            let mut op = Operation::enter(
                pool.clone(),
                "run-1",
                "effect",
                "run-1",
                "remote_agent",
                &input,
                &snapshot,
            )
            .await
            .unwrap();
            op.prepare_compensation(&[42; 32], &input, &snapshot).await.unwrap();
            op.mark_dispatched().await.unwrap();
            op.finish(None, status, Some("outcome missing")).await.unwrap();
            assert!(arguments(&pool, &[42; 32], &op.id).await.is_err());
            let row = sqlx::query("SELECT status,outcome_ciphertext FROM workflow_compensation_intents")
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(row.get::<String, _>("status"), "not_requested");
            assert!(row.get::<Option<String>, _>("outcome_ciphertext").is_none());
        }
    }

    #[tokio::test]
    async fn outcome_and_execution_fact_commit_in_one_transaction() {
        let pool = super::super::remote_tasks::test_pool().await;
        let snapshot = snapshot();
        let input = json!({"folder":"original"});
        let mut op = Operation::enter(
            pool.clone(),
            "run-1",
            "effect",
            "run-1",
            "remote_agent",
            &input,
            &snapshot,
        )
        .await
        .unwrap();
        op.prepare_compensation(&[42; 32], &input, &snapshot).await.unwrap();
        op.mark_dispatched().await.unwrap();
        sqlx::raw_sql("CREATE TRIGGER fail_compensation_snapshot BEFORE UPDATE OF outcome_ciphertext ON workflow_compensation_intents BEGIN SELECT RAISE(ABORT,'injected compensation write failure'); END;").execute(&pool).await.unwrap();
        assert!(
            op.finish(Some(&json!({"resourceId":"created"})), "succeeded", None)
                .await
                .is_err()
        );
        let result: Option<String> = sqlx::query_scalar("SELECT result_json FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(result.is_none());
        let event_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_compensation_events")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(event_count, 1);
        op.committed(); // hard exit: startup must preserve unknown, not assume success.
        super::super::operations::recover_interrupted(&pool).await.unwrap();
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
    }

    #[tokio::test]
    async fn legacy_intent_after_dispatch_cannot_claim_safe_compensation_provenance() {
        let pool = super::super::remote_tasks::test_pool().await;
        let snapshot = snapshot();
        let input = json!({"folder":"original"});
        let mut op = Operation::enter(
            pool.clone(),
            "run-1",
            "legacy",
            "run-1",
            "remote_agent",
            &input,
            &snapshot,
        )
        .await
        .unwrap();
        op.mark_dispatched().await.unwrap();
        op.prepare_compensation(&[42; 32], &input, &snapshot).await.unwrap();
        op.finish(Some(&json!({"resourceId":"created"})), "succeeded", None)
            .await
            .unwrap();
        assert!(arguments(&pool, &[42; 32], &op.id).await.is_err());
        let provenance: String = sqlx::query_scalar("SELECT provenance FROM workflow_compensation_intents")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(provenance, "after_dispatch");
    }

    #[test]
    fn declarations_reject_unsafe_contracts_and_parent_child_double_compensation() {
        let mut value = snapshot()["compensation"].clone();
        value["idempotency"]["contract"] = json!("");
        assert!(declaration(Some(&value), false).is_err());
        assert!(declaration(Some(&snapshot()["compensation"]), true).is_err());
        assert!(matches!(declaration(None, true).unwrap(), Declaration::Delegated));
        assert!(declaration(Some(&json!({"mode":"irreversible","reason":""})), false).is_err());
        assert!(declaration(Some(&json!({"mode":"compensatable","action":{"kind":"remote_agent","url":"https://fixture.invalid/undo"},"bindings":{},"idempotency":{"keyArgument":"key","contract":"dedup"},"latestState":true})),false).is_err());
    }
}
