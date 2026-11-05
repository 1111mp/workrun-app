use super::*;
use sqlx::{SqlitePool, sqlite::SqlitePoolOptions};
use std::sync::Mutex;

async fn pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20260904083536_create_run_history.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261005100000_remote_tasks.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261104100000_schedule_agent.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::raw_sql(include_str!(
        "../../../resources/migrations/20261104110000_one_time_schedules.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    pool
}
fn proposal(operation: &str) -> Value {
    json!({"id":"card-1","status":"waiting","operation":operation,"before":null,"after":{
        "id":"task-1","name":"Report","targetType":"app","targetId":"app-1","targetName":"Report App",
        "cronExpression":"0 9 * * 1-5","timezone":"Asia/Shanghai","enabled":true,"snapshot":{},"recipe":{"editorMode":"custom"}
    }})
}
async fn session(pool: &SqlitePool, workspace: &str, proposal: Value) -> Value {
    let mut state = json!({"id":"session-1","messages":[],"contents":[],"proposals":[proposal],"pending":"card-1"});
    SchedulingStore::new(pool.clone(), workspace.into())
        .save_session(&mut state)
        .await
        .unwrap();
    state
}

#[test]
fn reply_recovery_is_available_only_for_an_unanswered_saved_receipt() {
    for status in ["saved", "cancelled"] {
        let mut state = json!({"proposals":[],"contents":[{"role":"user","parts":[{"text":format!("Native schedule action receipt (data): {}", json!({"status":status}))}]}]});
        assert_eq!(
            ScheduleAgent::public_state(state.clone())["receiptPending"],
            status == "saved"
        );
        state["contents"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"model","parts":[{"text":"Done"}]}));
        let public = ScheduleAgent::public_state(state);
        assert_eq!(public["receiptPending"], false);
        assert!(public.get("contents").is_none());
    }
}

#[tokio::test]
async fn confirmation_is_atomic_idempotent_and_keeps_conversations_independent() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    assert!(store.list().await.unwrap().as_array().unwrap().is_empty());
    store.decide(&mut state, "card-1", true).await.unwrap();
    let mut loaded = store.load_session("session-1").await.unwrap();
    store.decide(&mut loaded, "card-1", true).await.unwrap();
    let tasks = store.list().await.unwrap();
    assert_eq!(tasks.as_array().unwrap().len(), 1);
    assert_eq!(loaded["proposals"][0]["status"], "saved");
    assert_eq!(loaded["scheduleId"], "task-1");
    assert!(
        SchedulingStore::new(pool.clone(), "team:another".into())
            .load_session("session-1")
            .await
            .is_err()
    );
    assert!(
        SchedulingStore::new(pool.clone(), "team:another".into())
            .raw("task-1")
            .await
            .is_err()
    );
    assert!(
        SchedulingStore::new(pool.clone(), "team:another".into())
            .list()
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty()
    );
    sqlx::query("DELETE FROM schedule_agent_sessions")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(store.list().await.unwrap().as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn changed_and_deleted_tasks_cannot_consume_stale_cards() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut initial = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut initial, "card-1", true).await.unwrap();
    let before = store.raw("task-1").await.unwrap();
    let mut p = proposal("update");
    p["before"] = before.clone();
    p["after"]["name"] = json!("Changed");
    let mut state = session(&pool, &workspace, p).await;
    sqlx::query("UPDATE schedules SET name='External edit', updated_at='new-version'")
        .execute(&pool)
        .await
        .unwrap();
    let error = store.decide(&mut state, "card-1", true).await.unwrap_err();
    assert!(error.to_string().contains("changed"));
    assert_eq!(store.raw("task-1").await.unwrap()["name"], "External edit");
    assert_eq!(
        store.load_session("session-1").await.unwrap()["proposals"][0]["status"],
        "waiting"
    );
    sqlx::query("DELETE FROM schedules").execute(&pool).await.unwrap();
    assert!(store.decide(&mut state, "card-1", true).await.is_err());
}

#[tokio::test]
async fn cancelling_does_not_schedule_and_public_state_hides_execution_recipes() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut state, "card-1", false).await.unwrap();
    assert!(store.list().await.unwrap().as_array().unwrap().is_empty());
    assert_eq!(state["proposals"][0]["status"], "cancelled");
    let public = ScheduleAgent::public_state(state);
    assert!(public.get("contents").is_none());
    assert!(public["proposals"][0]["after"].get("snapshot").is_none());
    assert!(public["proposals"][0]["after"].get("recipe").is_none());
}

#[test]
fn dedicated_tools_cannot_author_or_execute_and_transport_receipts_preserve_ids() {
    let tools = ScheduleTools::declarations();
    assert_eq!(tools.len(), 6);
    for name in [
        "save_workflow_plan",
        "save_workflow_draft",
        "execute_workflow",
        "execute_capability",
        "transfer_to_agent",
    ] {
        assert!(!tools.contains_key(name));
    }
    assert!(include_str!("AGENT.md").contains("One-time tasks"));
}

struct Model {
    responses: Mutex<std::collections::VecDeque<Content>>,
    requests: Mutex<Vec<LlmRequest>>,
}
#[async_trait::async_trait]
impl Llm for Model {
    fn name(&self) -> &str {
        "schedule-test"
    }
    async fn generate_content(&self, request: LlmRequest, _: bool) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        self.requests.lock().unwrap().push(request);
        let content = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected extra model call");
        Ok(Box::pin(futures::stream::once(async move {
            Ok(adk_rust::LlmResponse {
                content: Some(content),
                partial: false,
                ..Default::default()
            })
        })))
    }
}
fn call(name: &str, args: Value, id: &str) -> Content {
    serde_json::from_value(
        json!({"role":"model","parts":[{"name":name,"args":args,"id":id,"thought_signature":"signed-provider-call"}]}),
    )
    .unwrap()
}
fn scripted(responses: Vec<Content>) -> Model {
    Model {
        responses: Mutex::new(responses.into()),
        requests: Mutex::new(vec![]),
    }
}

#[tokio::test]
async fn model_can_only_preview_and_signed_history_resumes_after_clarification() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut initial = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut initial, "card-1", true).await.unwrap();
    let mut state = json!({"scheduleId":"task-1","messages":[{"id":"user-1","role":"user","text":"Pause my report"}],"contents":[{"role":"user","parts":[{"text":"Pause my report"}]}],"proposals":[],"questions":[]});
    let model = scripted(vec![
        call("get_schedule", json!({"id":"task-1"}), "read-1"),
        call(
            "preview_change",
            json!({"operation":"pause","id":"task-1"}),
            "preview-1",
        ),
        Content::new("model").with_text("I prepared the pause. Confirm the card to save it."),
    ]);
    ScheduleAgent {
        store: SchedulingStore::new(pool.clone(), workspace.clone()),
        runtime: ScheduleRuntime::global(),
    }
    .run(
        &model,
        &crate::config::ModelProvider::Gemini,
        &Catalog::empty_scheduling_catalog(),
        "Asia/Shanghai",
        &mut state,
        &Channel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    assert_eq!(state["proposals"].as_array().unwrap().len(), 1);
    assert_eq!(state["proposals"][0]["status"], "waiting");
    assert_eq!(state["proposals"][0]["after"]["enabled"], false);
    assert_eq!(
        state["messages"][1]["text"],
        "I prepared the pause. Confirm the card to save it."
    );
    assert_eq!(state["proposals"][0]["messageIndex"], 2);
    assert!(model.requests.lock().unwrap().last().unwrap().tools.is_empty());
    assert_eq!(store.raw("task-1").await.unwrap()["enabled"], true);
    assert_eq!(
        state["contents"][1]["parts"][0]["thought_signature"],
        "signed-provider-call"
    );
    assert_eq!(state["contents"][2]["parts"][0]["id"], "read-1");
    assert_eq!(
        state["contents"][2]["parts"][0]["functionResponse"]["response"]["id"],
        "task-1"
    );
    assert!(
        state["contents"][2]["parts"][0]["functionResponse"]["response"]
            .get("error")
            .is_none()
    );
    for request in model.requests.lock().unwrap().iter() {
        assert!(!request.tools.contains_key("save_workflow_draft"));
        assert!(request.tools.len() == 6 || request.tools.is_empty());
    }
}

#[tokio::test]
async fn unavailable_authoring_and_mixed_cards_are_rejected_without_side_effects() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mixed: Content = serde_json::from_value(json!({"role":"model","parts":[
        {"name":"ask_questions","args":{"questions":[{"title":"Which project?"}]},"id":"q1"},
        {"name":"preview_change","args":{"operation":"delete","id":"unknown"},"id":"p1"}
    ]}))
    .unwrap();
    let model = scripted(vec![
        call("save_workflow_draft", json!({}), "forbidden"),
        mixed,
        call(
            "ask_questions",
            json!({"questions":[{"title":"Which project?","options":["A","B"]}]}),
            "q2",
        ),
        Content::new("model").with_text("Please choose a project."),
    ]);
    let mut state = json!({"messages":[],"contents":[{"role":"user","parts":[{"text":"Schedule my report"}]}],"proposals":[],"questions":[]});
    ScheduleAgent {
        store: SchedulingStore::new(pool.clone(), workspace.clone()),
        runtime: ScheduleRuntime::global(),
    }
    .run(
        &model,
        &crate::config::ModelProvider::Gemini,
        &Catalog::empty_scheduling_catalog(),
        "Asia/Shanghai",
        &mut state,
        &Channel::new(|_| Ok(())),
    )
    .await
    .unwrap();
    assert_eq!(state["questions"][0]["title"], "Which project?");
    assert!(state["proposals"].as_array().unwrap().is_empty());
    assert!(store.list().await.unwrap().as_array().unwrap().is_empty());
    assert!(state["contents"][2].to_string().contains("unavailable"));
}

#[tokio::test]
async fn updates_pause_resume_and_delete_preserve_existing_schedule_contracts() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut state, "card-1", true).await.unwrap();
    for operation in ["update", "pause", "resume", "delete"] {
        let before = store.raw("task-1").await.unwrap();
        let mut after = before.clone();
        if operation == "update" {
            after["name"] = json!("Monday report");
            after["cronExpression"] = json!("0 9 * * 1");
        }
        if operation == "pause" {
            after["enabled"] = json!(false);
        }
        if operation == "resume" {
            after["enabled"] = json!(true);
        }
        let p = json!({"id":"change-card","status":"waiting","operation":operation,"before":before,"after":after});
        state = session(&pool, &workspace, p).await;
        if operation == "pause" {
            sqlx::query("UPDATE schedules SET last_error='Retain diagnosis'")
                .execute(&pool)
                .await
                .unwrap();
        }
        store.decide(&mut state, "change-card", true).await.unwrap();
        if operation == "delete" {
            assert!(store.raw("task-1").await.is_err());
        } else {
            let saved = store.raw("task-1").await.unwrap();
            assert_eq!(saved["name"], "Monday report");
            assert_eq!(saved["cronExpression"], "0 9 * * 1");
            assert_eq!(saved["enabled"], operation != "pause");
            if operation == "pause" {
                assert_eq!(saved["lastError"], "Retain diagnosis");
            }
        }
    }
}

#[tokio::test]
async fn recent_runs_expose_real_execution_errors_and_survive_task_deletion() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut state, "card-1", true).await.unwrap();
    sqlx::query("INSERT INTO run_records (workspace_id,id,target_type,target_id,target_name,status,started_at,target_snapshot_json,error,created_at,updated_at) VALUES (?,'run-1','app','app-1','Report','failed','2026-11-04T00:00:00Z','{}','Connection refused','now','now')").bind(&workspace).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO schedule_occurrences(id,schedule_id,scheduled_for,status,run_id,created_at) VALUES ('occurrence-1','task-1','2026-11-04T00:00:00Z','queued','run-1','now')").execute(&pool).await.unwrap();
    let detail = store.detail("task-1").await.unwrap();
    assert_eq!(detail["occurrences"][0]["status"], "failed");
    assert_eq!(detail["occurrences"][0]["error"], "Connection refused");
    assert_eq!(store.list().await.unwrap()[0]["lastStatus"], "failed");
    let before = store.raw("task-1").await.unwrap();
    let p = json!({"id":"delete-card","operation":"delete","status":"waiting","before":before,"after":before});
    state = session(&pool, &workspace, p).await;
    store.decide(&mut state, "delete-card", true).await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM run_records WHERE id='run-1'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn runtime_isolates_session_leases_and_cancellation_by_workspace() {
    let runtime = ScheduleRuntime::default();
    let lease = runtime.lease("personal", "same-session");
    let guard = lease.try_lock().unwrap();
    assert!(runtime.lease("personal", "same-session").try_lock().is_err());
    assert!(runtime.lease("team:another", "same-session").try_lock().is_ok());
    drop(guard);
    assert!(runtime.lease("personal", "same-session").try_lock().is_ok());

    let personal = runtime.start("personal", "same-session");
    let team = runtime.start("team:another", "same-session");
    runtime.stop("personal", "same-session");
    assert!(personal.is_cancelled());
    assert!(!team.is_cancelled());
    runtime.finish("personal", "same-session");
    assert!(!runtime.is_running("personal", "same-session"));
    assert!(runtime.is_running("team:another", "same-session"));
}

struct StreamingModel {
    finish: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
}
#[async_trait::async_trait]
impl Llm for StreamingModel {
    fn name(&self) -> &str {
        "schedule-stream-test"
    }
    async fn generate_content(&self, _: LlmRequest, _: bool) -> adk_rust::Result<adk_rust::LlmResponseStream> {
        use futures::StreamExt;
        let finish = self.finish.lock().unwrap().take().unwrap();
        let first = futures::stream::once(async {
            Ok(adk_rust::LlmResponse {
                content: Some(Content::new("model").with_text("上海")),
                partial: true,
                ..Default::default()
            })
        });
        let last = futures::stream::once(async move {
            finish.await.unwrap();
            Ok(adk_rust::LlmResponse {
                content: Some(Content::new("model").with_text("天气")),
                partial: false,
                ..Default::default()
            })
        });
        Ok(Box::pin(first.chain(last)))
    }
}

#[tokio::test]
async fn response_deltas_reach_the_renderer_before_the_model_finishes() {
    let pool = pool().await;
    let agent = ScheduleAgent {
        store: SchedulingStore::new(pool, dirs::active_workspace_id()),
        runtime: ScheduleRuntime::global(),
    };
    let (finish, receiver) = tokio::sync::oneshot::channel();
    let model = StreamingModel {
        finish: Mutex::new(Some(receiver)),
    };
    let events = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
    let first_delta = std::sync::Arc::new(tokio::sync::Notify::new());
    let captured = events.clone();
    let signal = first_delta.clone();
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            let event: Value = serde_json::from_str(&text).unwrap();
            if event["type"] == "text_delta" {
                signal.notify_one();
            }
            captured.lock().unwrap().push(event);
        }
        Ok(())
    });
    let mut state = json!({"messages":[],"contents":[{"role":"user","parts":[{"text":"Weather request"}]}],"proposals":[],"questions":[]});
    let catalog = Catalog::empty_scheduling_catalog();
    let response = agent.run(
        &model,
        &crate::config::ModelProvider::Gemini,
        &catalog,
        "Asia/Shanghai",
        &mut state,
        &channel,
    );
    tokio::pin!(response);
    tokio::select! {
        _ = &mut response => panic!("The model must remain pending until its final chunk is released"),
        _ = tokio::time::timeout(std::time::Duration::from_secs(2), first_delta.notified()) => {
            assert!(events.lock().unwrap().iter().any(|event|event["type"]=="text_delta" && event["text"]=="上海"));
        }
    }
    finish.send(()).unwrap();
    response.await.unwrap();
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "text_delta" && event["text"] == "天气")
    );
    assert!(
        events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "phase_end" && event["kind"] == "answer")
    );
}

#[tokio::test]
async fn streamed_tool_narration_has_its_own_phase_and_never_becomes_a_saved_answer() {
    let pool = pool().await;
    let agent = ScheduleAgent {
        store: SchedulingStore::new(pool, dirs::active_workspace_id()),
        runtime: ScheduleRuntime::global(),
    };
    let mut lookup = call("list_schedules", json!({}), "lookup-1");
    lookup.parts.insert(
        0,
        Part::Text {
            text: "Checking saved tasks".into(),
        },
    );
    let model = scripted(vec![lookup, Content::new("model").with_text("No saved tasks")]);
    let captured = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = captured.clone();
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            events.lock().unwrap().push(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    });
    let mut state = json!({"messages":[],"contents":[{"role":"user","parts":[{"text":"List my tasks"}]}],"proposals":[],"questions":[]});
    agent
        .run(
            &model,
            &crate::config::ModelProvider::Gemini,
            &Catalog::empty_scheduling_catalog(),
            "Asia/Shanghai",
            &mut state,
            &channel,
        )
        .await
        .unwrap();
    assert_eq!(state["messages"].as_array().unwrap().len(), 1);
    assert_eq!(state["messages"][0]["text"], "No saved tasks");
    let events = captured.lock().unwrap();
    assert_eq!(events.iter().filter(|e| e["type"] == "phase_start").count(), 2);
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "phase_end" && e["kind"] == "activity")
    );
    assert!(
        events
            .iter()
            .any(|e| e["type"] == "tool_start" && e["name"] == "list_schedules")
    );
}

#[tokio::test]
async fn model_preferences_persist_per_session_before_any_turn_and_reject_invalid_or_busy_changes() {
    let pool = pool().await;
    let agent = ScheduleAgent {
        store: SchedulingStore::new(pool.clone(), dirs::active_workspace_id()),
        runtime: ScheduleRuntime::global(),
    };
    let first = model_catalog()
        .into_iter()
        .find(|model| !model.effort_options().is_empty())
        .unwrap();
    let second = model_catalog().into_iter().find(|model| model.id != first.id).unwrap();
    let selection = ScheduleModelSelection {
        model_id: first.id.clone(),
        reasoning_effort: Some(first.effort_options()[0].into()),
    };
    let a = agent.create(None, Some(selection.clone())).await.unwrap();
    let b = agent
        .create(
            None,
            Some(ScheduleModelSelection {
                model_id: second.id.clone(),
                reasoning_effort: None,
            }),
        )
        .await
        .unwrap();
    let a_id = a["id"].as_str().unwrap();
    let b_id = b["id"].as_str().unwrap();
    assert_eq!(agent.get(a_id).await.unwrap()["modelId"], first.id);
    assert_eq!(
        agent.get(a_id).await.unwrap()["reasoningEffort"],
        selection.reasoning_effort.as_deref().unwrap()
    );
    let changed = agent
        .set_model(
            a_id,
            ScheduleModelSelection {
                model_id: second.id.clone(),
                reasoning_effort: None,
            },
        )
        .await
        .unwrap();
    assert_eq!(changed["messages"], json!([]));
    assert_eq!(changed["modelId"], second.id);
    assert!(changed["reasoningEffort"].is_null());
    assert_eq!(agent.get(b_id).await.unwrap()["modelId"], second.id);
    agent.set_model(a_id, selection).await.unwrap();
    assert_eq!(agent.get(a_id).await.unwrap()["modelId"], first.id);
    assert_eq!(agent.get(b_id).await.unwrap()["modelId"], second.id);
    for selection in [
        ScheduleModelSelection {
            model_id: "missing-model".into(),
            reasoning_effort: None,
        },
        ScheduleModelSelection {
            model_id: first.id.clone(),
            reasoning_effort: Some("unsupported-effort".into()),
        },
    ] {
        assert!(agent.set_model(a_id, selection).await.is_err());
        assert_eq!(agent.get(a_id).await.unwrap()["modelId"], first.id);
    }
    let lease = agent.runtime.lease(agent.store.workspace(), a_id);
    let guard = lease.try_lock().unwrap();
    assert!(
        agent
            .set_model(
                a_id,
                ScheduleModelSelection {
                    model_id: second.id,
                    reasoning_effort: None
                }
            )
            .await
            .is_err()
    );
    drop(guard);
    assert_eq!(agent.store.load_session(a_id).await.unwrap()["modelId"], first.id);
}

#[tokio::test]
async fn one_time_confirmation_persists_exact_instant_and_rejects_expired_cards() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut card = proposal("create");
    let future = Utc::now() + chrono::Duration::days(1);
    crate::module::schedule::ScheduleTiming::patch(
        &mut card["after"],
        &json!({"operation":"create","runAt":future.to_rfc3339()}),
        Utc::now(),
    )
    .unwrap();
    let mut state = session(&pool, &workspace, card.clone()).await;
    store.decide(&mut state, "card-1", true).await.unwrap();
    let task = store.detail("task-1").await.unwrap();
    assert_eq!(task["scheduleKind"], "once");
    assert_eq!(task["runAt"], future.to_rfc3339());
    assert_eq!(task["cronExpression"], "");
    assert_eq!(task["nextRunAt"], task["runAt"]);
    assert!(state["contents"].to_string().contains("runAt"));
    // Reconfirming an old card cannot create an already overdue task.
    card["after"]["id"] = json!("expired");
    card["after"]["runAt"] = json!((Utc::now() - chrono::Duration::minutes(1)).to_rfc3339());
    let mut expired = session(&pool, &workspace, card).await;
    assert!(store.decide(&mut expired, "card-1", true).await.is_err());
    assert!(store.raw("expired").await.is_err());
}

#[tokio::test]
async fn every_committed_session_change_advances_its_revision_and_retries_are_stable() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    assert_eq!(state["revision"], 1);
    store.decide(&mut state, "card-1", false).await.unwrap();
    assert_eq!(state["revision"], 2);
    assert_eq!(store.load_session("session-1").await.unwrap()["revision"], 2);
    store.decide(&mut state, "card-1", false).await.unwrap();
    assert_eq!(state["revision"], 2);
    store.save_session(&mut state).await.unwrap();
    assert_eq!(state["revision"], 3);
}

#[test]
fn scheduling_reasoning_is_forwarded_and_keeps_the_latest_provider_record() {
    let captured = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
    let events = captured.clone();
    let channel = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            events.lock().unwrap().push(serde_json::from_str(&text).unwrap());
        }
        Ok(())
    });
    let stream = super::stream::ScheduleResponseStream::new(&channel);
    for (text, complete) in [("Check", false), ("Check saved receipt", true)] {
        stream
            .forward(crate::module::assistant::AssistantStreamEvent::Reasoning {
                id: "thought-1".into(),
                text: text.into(),
                duration_ms: 400,
                complete,
            })
            .unwrap();
    }
    let records = stream.reasoning();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["text"], "Check saved receipt");
    assert_eq!(records[0]["complete"], true);
    let events = captured.lock().unwrap();
    assert_eq!(events.iter().filter(|event| event["type"] == "reasoning").count(), 2);
    assert_eq!(events.last().unwrap()["phaseId"], records[0]["phaseId"]);
}

#[tokio::test]
async fn task_history_indexes_all_saved_tasks_and_can_seed_management_of_a_form_created_task() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut state = session(&pool, &workspace, proposal("create")).await;
    store.decide(&mut state, "card-1", true).await.unwrap();
    let mut second = proposal("create");
    second["id"] = json!("card-2");
    second["after"]["id"] = json!("task-2");
    state["proposals"].as_array_mut().unwrap().push(second);
    state["pending"] = json!("card-2");
    store.decide(&mut state, "card-2", true).await.unwrap();
    let summaries = store.list_sessions().await.unwrap();
    assert_eq!(summaries[0]["scheduleIds"], json!(["task-1", "task-2"]));
    let agent = ScheduleAgent {
        store,
        runtime: ScheduleRuntime::global(),
    };
    let opened = agent.create(Some("task-1".into()), None).await.unwrap();
    assert_eq!(opened["messages"].as_array().unwrap().len(), 1);
    assert_eq!(opened["messages"][0]["proposalId"], opened["proposals"][0]["id"]);
    assert_eq!(opened["proposals"][0]["after"]["id"], "task-1");
    assert_eq!(opened["proposals"][0]["status"], "saved");
    assert_eq!(agent.store.list().await.unwrap().as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn direct_task_updates_preserve_conversations_and_pinned_execution_sources() {
    let pool = pool().await;
    let workspace = dirs::active_workspace_id();
    let store = SchedulingStore::new(pool.clone(), workspace.clone());
    let mut task = proposal("create");
    task["after"]["targetType"] = json!("workflow");
    task["after"]["snapshot"] = json!({"nodes":[],"edges":[]});
    task["after"]["recipe"] = json!({"source":{"kind":"published_release","release_id":"pinned","release_version":"1"},"input":{},"initialState":{},"editorMode":"custom"});
    let mut state = session(&pool, &workspace, task).await;
    store.decide(&mut state, "card-1", true).await.unwrap();
    let original_session = store.load_session("session-1").await.unwrap();
    let before = store.raw("task-1").await.unwrap();
    let changed = store.update_task(&Catalog::empty_scheduling_catalog(), &json!({"operation":"update","id":"task-1","version":before["version"],"name":"Updated from dialog","cronExpression":"0 10 * * *","timezone":"Asia/Shanghai","input":{}})).await.unwrap();
    assert_eq!(changed["name"], "Updated from dialog");
    assert_eq!(changed["cronExpression"], "0 10 * * *");
    assert_eq!(store.raw("task-1").await.unwrap()["recipe"], before["recipe"]);
    assert_eq!(store.load_session("session-1").await.unwrap(), original_session);
    assert_eq!(store.list_sessions().await.unwrap().as_array().unwrap().len(), 1);
    assert!(
        store
            .update_task(
                &Catalog::empty_scheduling_catalog(),
                &json!({"operation":"update","id":"task-1","version":before["version"],"name":"Stale edit"})
            )
            .await
            .is_err()
    );
    assert_eq!(store.raw("task-1").await.unwrap()["name"], "Updated from dialog");
}
