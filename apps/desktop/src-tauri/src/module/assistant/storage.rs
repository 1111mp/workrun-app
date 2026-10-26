//! Message-level persistence; runtime context and UI history use separate reads.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    future::Future,
};

// A native turn owns its persistence baseline. It is dropped with that task,
// never shared across sessions or kept in an unbounded global history cache.
#[derive(Default)]
pub(crate) struct Writer {
    session: String,
    workspace: String,
    messages: HashMap<String, Value>,
    items: HashMap<(String, String), Value>,
}
tokio::task_local! { static WRITER: RefCell<Writer>; }

pub(crate) async fn with_writer<T>(writer: Writer, future: impl Future<Output = T>) -> T {
    WRITER.scope(RefCell::new(writer), future).await
}
pub(crate) fn writer(workspace: &str, session: &Value) -> Result<Writer> {
    let mut writer = Writer {
        workspace: workspace.into(),
        session: session["id"].as_str().context("Session ID missing")?.into(),
        ..Default::default()
    };
    remember(&mut writer, workspace, session)?;
    Ok(writer)
}
fn remember(writer: &mut Writer, workspace: &str, session: &Value) -> Result<()> {
    if writer.workspace != workspace || writer.session != session["id"].as_str().unwrap_or_default() {
        *writer = Writer::default();
    }
    writer.workspace = workspace.into();
    writer.session = session["id"].as_str().context("Session ID missing")?.into();
    for message in session["messages"].as_array().into_iter().flatten() {
        let id = message["id"].as_str().context("Message ID missing")?;
        if writer.messages.get(id) != Some(message) {
            writer.messages.insert(id.into(), message.clone());
        }
    }
    for kind in ITEMS {
        for item in session[kind].as_array().into_iter().flatten() {
            let key = (kind.to_owned(), item_id(kind, item)?);
            if writer.items.get(&key) != Some(item) {
                writer.items.insert(key, item.clone());
            }
        }
    }
    Ok(())
}

pub const ITEMS: [&str; 5] = [
    "workflowPlans",
    "workflowConfirmations",
    "toolConfirmations",
    "reasoning",
    "activities",
];
pub const PAGE_SIZE: usize = 50;

pub fn item_id(kind: &str, item: &Value) -> Result<String> {
    if kind == "workflowPlans" {
        return Ok(json!([item["turnId"], item["plan"]["id"], item["plan"]["version"]]).to_string());
    }
    Ok(item["id"].as_str().context("Conversation item ID missing")?.into())
}

pub(crate) fn encode_message(message: &Value) -> Result<String> {
    let data = serde_json::to_string(message)?;
    ensure!(
        data.len() <= 4 * 1024 * 1024,
        "A single message is too large; use an artifact for large outputs"
    );
    Ok(data)
}

fn metadata(session: &Value) -> Result<Value> {
    session.as_object().context("Session must be an object")?;
    // Only current control state belongs here. New collections must explicitly
    // choose row storage instead of silently growing this metadata document.
    Ok(Value::Object(
        [
            "activeCall",
            "pendingTool",
            "pendingToolDecision",
            "workflowPlan",
            "responsePhaseId",
            "error",
            "steps",
        ]
        .into_iter()
        .filter_map(|key| session.get(key).map(|value| (key.into(), value.clone())))
        .collect(),
    ))
}

pub async fn save(pool: &SqlitePool, workspace: &str, session: &Value) -> Result<()> {
    let id = session["id"].as_str().context("Session ID missing")?;
    uuid::Uuid::parse_str(id)?;
    // Clone only bounded metadata, never the entire message history.
    let state = metadata(session)?;
    let state_json = serde_json::to_string(&state)?;
    ensure!(state_json.len() <= 1024 * 1024, "Conversation state is too large");
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let result=sqlx::query("INSERT INTO assistant_sessions (id,workspace_id,state_json,title,model_id,active_run_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json,title=excluded.title,model_id=excluded.model_id,active_run_id=excluded.active_run_id,status=excluded.status,updated_at=excluded.updated_at WHERE assistant_sessions.workspace_id=excluded.workspace_id")
        .bind(id).bind(workspace).bind(state_json).bind(session["title"].as_str().unwrap_or(""))
        .bind(session["modelId"].as_str().unwrap_or("")).bind(session["activeCall"]["runId"].as_str()).bind(session["status"].as_str().unwrap_or("idle"))
        .bind(&now).bind(&now).execute(&mut *tx).await?;
    ensure!(result.rows_affected() == 1, "Conversation belongs to another workspace");
    let mut turn_id = None;
    let mut ids = HashSet::new();
    for (sequence, message) in session["messages"]
        .as_array()
        .context("Messages missing")?
        .iter()
        .enumerate()
    {
        let message_id = message["id"].as_str().context("Message ID missing")?;
        ensure!(ids.insert(message_id), "Duplicate message ID");
        if message["role"] == "user" {
            turn_id = Some(message_id);
        }
        let unchanged = WRITER
            .try_with(|writer| {
                let writer = writer.borrow();
                writer.workspace == workspace
                    && writer.session == id
                    && writer.messages.get(message_id) == Some(message)
            })
            .unwrap_or(false);
        if unchanged {
            continue;
        }
        let data = encode_message(message)?;
        // The baseline skips historical statements; this condition also protects
        // callers without a native writer and late draft finalization.
        sqlx::query("INSERT INTO assistant_messages (workspace_id,session_id,id,sequence,turn_id,role,run_id,status,message_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'completed',?,?,?) ON CONFLICT(workspace_id,session_id,id) DO UPDATE SET message_json=excluded.message_json,run_id=excluded.run_id,status='completed',updated_at=excluded.updated_at WHERE assistant_messages.message_json IS NOT excluded.message_json OR assistant_messages.status='streaming'")
            .bind(workspace).bind(id).bind(message_id).bind(sequence as i64).bind(turn_id)
            .bind(message["role"].as_str().unwrap_or("assistant")).bind(message["runId"].as_str()).bind(data).bind(&now).bind(&now).execute(&mut *tx).await?;
    }
    for kind in ITEMS {
        for (sequence, item) in session[kind].as_array().into_iter().flatten().enumerate() {
            let key = (kind.to_owned(), item_id(kind, item)?);
            let unchanged = WRITER
                .try_with(|writer| {
                    let writer = writer.borrow();
                    writer.workspace == workspace && writer.session == id && writer.items.get(&key) == Some(item)
                })
                .unwrap_or(false);
            if unchanged {
                continue;
            }
            let data = serde_json::to_string(item)?;
            ensure!(data.len() <= 4 * 1024 * 1024, "A conversation item is too large");
            sqlx::query("INSERT INTO assistant_session_items (workspace_id,session_id,kind,id,turn_id,sequence,item_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,session_id,kind,id) DO UPDATE SET item_json=excluded.item_json WHERE assistant_session_items.item_json IS NOT excluded.item_json")
                .bind(workspace).bind(id).bind(kind).bind(item_id(kind,item)?).bind(item["turnId"].as_str())
                .bind(sequence as i64).bind(data).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    // Advance the baseline only after the database transaction is durable.
    if let Ok(result) = WRITER.try_with(|writer| remember(&mut writer.borrow_mut(), workspace, session)) {
        result?;
    }
    Ok(())
}

pub async fn load(
    pool: &SqlitePool,
    workspace: &str,
    id: &str,
    page: Option<i64>,
    include_drafts: bool,
) -> Result<Value> {
    let mut tx = pool.begin().await?;
    let row =
        sqlx::query("SELECT state_json,id,title,model_id,status FROM assistant_sessions WHERE workspace_id=? AND id=?")
            .bind(workspace)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .context("Conversation was not found in this workspace")?;
    let mut session: Value = serde_json::from_str(row.try_get("state_json")?)?;
    for (key, column) in [
        ("id", "id"),
        ("title", "title"),
        ("modelId", "model_id"),
        ("status", "status"),
    ] {
        session[key] = json!(row.try_get::<String, _>(column)?);
    }
    let rows=sqlx::query("SELECT message_json,sequence,status,turn_id FROM assistant_messages WHERE workspace_id=? AND session_id=? AND sequence<? AND (? OR status!='streaming') ORDER BY sequence DESC LIMIT ?")
        .bind(workspace).bind(id).bind(page.unwrap_or(i64::MAX)).bind(include_drafts)
        .bind(if page.is_some(){PAGE_SIZE as i64 + 1}else{i64::MAX}).fetch_all(&mut *tx).await?;
    let has_more = page.is_some() && rows.len() > PAGE_SIZE;
    let mut messages = Vec::new();
    let mut turns = HashSet::<String>::new();
    let mut oldest = None;
    for row in rows
        .into_iter()
        .take(if page.is_some() { PAGE_SIZE } else { usize::MAX })
        .rev()
    {
        oldest.get_or_insert(row.try_get::<i64, _>("sequence")?);
        let turn = row.try_get::<Option<String>, _>("turn_id")?;
        if let Some(turn) = &turn {
            turns.insert(turn.clone());
        }
        let mut message: Value = serde_json::from_str(row.try_get("message_json")?)?;
        if page.is_some() {
            message["turnId"] = json!(turn);
        }
        if row.try_get::<String, _>("status")? == "streaming" {
            message["interrupted"] = json!(true);
        }
        messages.push(message);
    }
    session["messages"] = json!(messages);
    for kind in ITEMS {
        let rows=sqlx::query("SELECT item_json FROM assistant_session_items WHERE workspace_id=? AND session_id=? AND kind=? AND (? OR turn_id IN (SELECT value FROM json_each(?))) ORDER BY sequence")
            .bind(workspace).bind(id).bind(kind).bind(page.is_none())
            .bind(serde_json::to_string(&turns)?).fetch_all(&mut *tx).await?;
        session[kind] = json!(
            rows.into_iter()
                .map(|r| serde_json::from_str::<Value>(r.get("item_json")))
                .collect::<std::result::Result<Vec<_>, _>>()?
        );
    }
    if page.is_some() {
        session["history"] = json!({"hasMore":has_more,"beforeSequence":oldest});
    }
    tx.commit().await?;
    if page.is_none()
        && let Ok(result) = WRITER.try_with(|writer| {
            *writer.borrow_mut() = self::writer(workspace, &session)?;
            Ok::<_, anyhow::Error>(())
        })
    {
        result?;
    }
    Ok(session)
}

/// Only the active response may checkpoint a draft. A late flush cannot overwrite
/// a completed message or a new response phase.
pub async fn checkpoint(pool: &SqlitePool, workspace: &str, id: &str, message_id: &str, text: &str) -> Result<()> {
    if text.is_empty() {
        return Ok(());
    }

    let now = chrono::Utc::now().to_rfc3339();
    let message =
        json!({"id":message_id,"role":"assistant","text":text,"content":{"role":"model","parts":[{"text":text}]}});
    let data = encode_message(&message)?;
    sqlx::query("INSERT INTO assistant_messages (workspace_id,session_id,id,sequence,turn_id,role,status,message_json,created_at,updated_at) SELECT ?,?,?,COALESCE((SELECT MAX(sequence)+1 FROM assistant_messages WHERE workspace_id=? AND session_id=?),0),(SELECT id FROM assistant_messages WHERE workspace_id=? AND session_id=? AND role='user' ORDER BY sequence DESC LIMIT 1),'assistant','streaming',?,?,? FROM assistant_sessions WHERE workspace_id=? AND id=? AND json_extract(state_json,'$.responsePhaseId')=? AND status IN ('thinking','running') ON CONFLICT(workspace_id,session_id,id) DO UPDATE SET message_json=excluded.message_json,updated_at=excluded.updated_at WHERE assistant_messages.status='streaming'")
        .bind(workspace).bind(id).bind(message_id).bind(workspace).bind(id).bind(workspace).bind(id)
        .bind(data).bind(&now).bind(&now).bind(workspace).bind(id).bind(message_id).execute(pool).await?;
    Ok(())
}

#[cfg(test)]
pub async fn test_schema(pool: &SqlitePool) {
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261016100000_assistant_workspace.up.sql"
    ))
    .execute(pool)
    .await
    .unwrap();
}

/// Bounded event snapshots never resend a growing conversation history.
pub fn window(session: &Value) -> Value {
    if session["history"].is_object() {
        return session.clone();
    }
    let mut view = metadata(session).unwrap_or_else(|_| session.clone());
    for key in ["id", "title", "modelId", "status"] {
        view[key] = session[key].clone();
    }
    let Some(all) = session["messages"].as_array() else {
        return view;
    };
    let start = all.len().saturating_sub(PAGE_SIZE);
    let mut turn = Value::Null;
    let mut turns = HashSet::new();
    let mut messages = Vec::new();
    for (index, message) in all.iter().enumerate() {
        if message["role"] == "user" {
            turn = message["id"].clone();
        }
        if index >= start {
            let mut message = message.clone();
            message["turnId"] = turn.clone();
            if let Some(id) = turn.as_str() {
                turns.insert(id.to_string());
            }
            messages.push(message);
        }
    }
    view["messages"] = json!(messages);
    {
        for kind in ITEMS {
            view[kind] = json!(
                session[kind]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| start == 0 || item["turnId"].as_str().is_some_and(|id| turns.contains(id)))
                    .cloned()
                    .collect::<Vec<_>>()
            );
        }
    }
    view["history"] = json!({"hasMore":start>0,"beforeSequence":start});
    view
}

#[cfg(test)]
mod tests;
