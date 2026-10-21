//! One application event bus. Only active responses retain their live contents;
//! reading history never registers a subscriber or owns a native task.
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::{collections::HashMap, sync::LazyLock};

static EPOCH: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
static STATE: LazyLock<Mutex<EventState>> = LazyLock::new(|| Mutex::new(EventState::default()));

#[derive(Default)]
struct EventState {
    sequence: u64,
    sessions: HashMap<(String, String), Session>,
    revisions: HashMap<(String, String), u64>,
    list_revisions: HashMap<String, u64>,
}
#[derive(Default)]
struct Session {
    snapshot: Value,
    live: Value,
}

fn envelope(workspace: &str, id: &str, sequence: u64, kind: &str, payload: Value) -> Value {
    json!({"workspaceId":workspace,"sessionId":id,"epoch":*EPOCH,"sequence":sequence,"type":kind,"payload":payload})
}
fn emit(event: &Value) {
    let _ = crate::module::run_manager::emit_on_main_thread("assistant-event", event.clone());
}
fn busy(session: &Value) -> bool {
    matches!(session["status"].as_str(), Some("thinking" | "running"))
}
fn upsert(session: &mut Value, field: &str, value: &Value) {
    if !session[field].is_array() {
        session[field] = json!([]);
    }
    let items = session[field].as_array_mut().unwrap();
    let key = |entry: &Value| {
        if field == "workflowPlans" {
            json!([entry["turnId"], entry["plan"]["id"], entry["plan"]["version"]])
        } else {
            entry["id"].clone()
        }
    };
    if let Some(old) = items.iter_mut().find(|entry| key(entry) == key(value)) {
        *old = value.clone();
    } else {
        items.push(value.clone());
    }
}
impl Session {
    fn view(&self) -> Value {
        let mut session = self.snapshot.clone();
        for field in ["activities", "reasoning", "workflowPlans"] {
            for value in self.live[field].as_array().into_iter().flatten() {
                upsert(&mut session, field, value);
            }
        }
        if self.live["workflowPlan"].is_object() {
            session["workflowPlan"] = self.live["workflowPlan"].clone();
        }
        let message_id = &self.live["messageId"];
        let stream = if busy(&session)
            && message_id.is_string()
            && session["responsePhaseId"] == *message_id
            && !session["messages"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|message| message["id"] == *message_id)
        {
            json!({"messageId":message_id,"text":self.live["text"].as_str().unwrap_or("")})
        } else {
            Value::Null
        };
        json!({"session":session,"stream":stream})
    }
    fn snapshot(&mut self, session: &Value) {
        // Each commit includes the phase's durable progress. Keep only the text
        // still being streamed for the same phase; never overlay old decisions.
        if self.snapshot["responsePhaseId"] != session["responsePhaseId"] || !busy(session) {
            self.live = Value::Null;
        } else if self.live.is_object() {
            self.live
                .as_object_mut()
                .unwrap()
                .retain(|key, _| matches!(key.as_str(), "messageId" | "text"));
        }
        self.snapshot = session.clone();
    }
    fn stream(&mut self, payload: &Value) {
        if !busy(&self.snapshot) || self.snapshot["responsePhaseId"] != payload["messageId"] {
            return;
        }
        if self.live["messageId"] != payload["messageId"] {
            self.live = json!({"messageId":payload["messageId"],"text":""});
        }
        match payload["event"]["type"].as_str() {
            Some("text_delta") => {
                self.live["text"] = json!(format!(
                    "{}{}",
                    self.live["text"].as_str().unwrap_or(""),
                    payload["event"]["text"].as_str().unwrap_or("")
                ));
            },
            Some("text_replace") => self.live["text"] = payload["event"]["text"].clone(),
            Some("activity") => upsert(&mut self.live, "activities", &payload["activity"]),
            Some("reasoning") => upsert(&mut self.live, "reasoning", &payload["reasoning"]),
            Some("workflow_plan") => {
                self.live["workflowPlan"] = payload["event"]["plan"].clone();
                upsert(
                    &mut self.live,
                    "workflowPlans",
                    &json!({"turnId":payload["turnId"],"plan":payload["event"]["plan"]}),
                );
            },
            _ => {},
        }
    }
}

// Revisions survive completion; full histories do not. A read that overlapped a
// terminal commit retries its database read instead of returning stale state.
pub fn revision(workspace: &str, id: &str) -> u64 {
    STATE
        .lock()
        .revisions
        .get(&(workspace.into(), id.into()))
        .copied()
        .unwrap_or(0)
}
pub fn read_snapshot(workspace: &str, id: &str, before: u64, loaded: Value) -> Option<Value> {
    let state = STATE.lock();
    let key = (workspace.into(), id.into());
    let revision = state.revisions.get(&key).copied().unwrap_or(0);
    let view = if let Some(current) = state.sessions.get(&key) {
        if revision == before {
            Session {
                snapshot: loaded,
                live: current.live.clone(),
            }
            .view()
        } else {
            current.view()
        }
    } else if revision == before {
        json!({"session":loaded,"stream":null})
    } else {
        return None;
    };
    Some(envelope(workspace, id, revision, "snapshot", view))
}
pub fn snapshot(workspace: &str, value: &Value) -> Value {
    let id = value["id"].as_str().unwrap();
    let key = (workspace.into(), id.into());
    let mut state = STATE.lock();
    let session = state.sessions.entry(key.clone()).or_default();
    session.snapshot(value);
    let view = session.view();
    if !busy(value) {
        state.sessions.remove(&key);
    }
    state.sequence += 1;
    let sequence = state.sequence;
    state.revisions.insert(key, sequence);
    let event = envelope(workspace, id, sequence, "snapshot", view);
    emit(&event);
    event
}
pub fn stream(workspace: &str, id: &str, payload: Value) -> Option<Value> {
    let mut state = STATE.lock();
    let key = (workspace.into(), id.into());
    let session = state.sessions.get_mut(&key)?;
    if !busy(&session.snapshot) || session.snapshot["responsePhaseId"] != payload["messageId"] {
        return None;
    }
    session.stream(&payload);
    state.sequence += 1;
    let sequence = state.sequence;
    state.revisions.insert(key, sequence);
    let event = envelope(workspace, id, sequence, "stream", payload);
    emit(&event);
    Some(event)
}
pub fn decorate(workspace: &str, session: &Value) -> Value {
    let state = STATE.lock();
    if let Some(current) = state
        .sessions
        .get(&(workspace.into(), session["id"].as_str().unwrap().into()))
    {
        return Session {
            snapshot: session.clone(),
            live: current.live.clone(),
        }
        .view()["session"]
            .take();
    }
    session.clone()
}
pub fn list_change(workspace: &str, id: &str, summary: Value) {
    let mut state = STATE.lock();
    state.sequence += 1;
    let sequence = state.sequence;
    state.list_revisions.insert(workspace.into(), sequence);
    if summary.is_null() {
        let key = (workspace.into(), id.into());
        state.sessions.remove(&key);
        state.revisions.insert(key, sequence);
    }
    emit(&envelope(workspace, id, sequence, "summary", summary));
}
pub fn list_revision(workspace: &str) -> u64 {
    STATE.lock().list_revisions.get(workspace).copied().unwrap_or(0)
}
pub fn read_list(workspace: &str, before: u64, loaded: Vec<Value>) -> Option<Value> {
    let state = STATE.lock();
    let revision = state.list_revisions.get(workspace).copied().unwrap_or(0);
    (revision == before).then(|| envelope(workspace, "", revision, "list", json!(loaded)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> String {
        uuid::Uuid::new_v4().to_string()
    }
    fn current() -> Value {
        json!({"id":"session","status":"thinking","responsePhaseId":"answer","messages":[]})
    }
    fn delta(workspace: &str, text: &str) -> Option<Value> {
        stream(
            workspace,
            "session",
            json!({"messageId":"answer","event":{"type":"text_delta","text":text}}),
        )
    }
    #[test]
    fn snapshot_recovers_live_text_and_thinking_without_registering_anything() {
        let workspace = workspace();
        let initial = current();
        snapshot(&workspace, &initial);
        let before = revision(&workspace, "session");
        delta(&workspace, "Hello");
        stream(
            &workspace,
            "session",
            json!({"messageId":"answer","event":{"type":"reasoning"},"reasoning":{"id":"thought","text":"Checking"}}),
        );
        let view = read_snapshot(&workspace, "session", before, initial).unwrap();
        assert_eq!(view["payload"]["stream"]["text"], "Hello");
        assert_eq!(view["payload"]["session"]["reasoning"][0]["text"], "Checking");
        assert!(delta("other-workspace", "Wrong").is_none());
    }
    #[test]
    fn completion_during_a_read_requires_a_fresh_database_snapshot() {
        let workspace = workspace();
        let initial = current();
        snapshot(&workspace, &initial);
        let before = revision(&workspace, "session");
        delta(&workspace, "Partial");
        let mut finished = initial.clone();
        finished["status"] = json!("idle");
        finished["messages"] = json!([{"id":"answer","text":"Partial"}]);
        let event = snapshot(&workspace, &finished);
        assert_eq!(event["type"], "snapshot");
        assert!(event["payload"]["stream"].is_null());
        assert!(read_snapshot(&workspace, "session", before, initial).is_none());
        assert!(delta(&workspace, "Late text").is_none());
        let view = read_snapshot(&workspace, "session", revision(&workspace, "session"), finished).unwrap();
        assert_eq!(view["payload"]["session"]["status"], "idle");
        assert!(!STATE.lock().sessions.contains_key(&(workspace, "session".into())));
    }
    #[test]
    fn deletion_invalidates_inflight_history_and_list_reads() {
        let workspace = workspace();
        let before = list_revision(&workspace);
        let read = revision(&workspace, "session");
        list_change(&workspace, "session", Value::Null);
        assert!(read_list(&workspace, before, vec![]).is_none());
        assert!(read_snapshot(&workspace, "session", read, current()).is_none());
        assert!(read_list(&workspace, list_revision(&workspace), vec![]).is_some());
    }
}
