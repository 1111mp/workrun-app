use super::*;
async fn pool() -> SqlitePool {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    test_schema(&pool).await;
    pool
}
fn message(i: usize) -> Value {
    json!({"id":format!("m{i}"),"role":if i.is_multiple_of(2){"user"}else{"assistant"},"text":format!("Message {i}"),"content":{"role":if i.is_multiple_of(2){"user"}else{"model"},"parts":[{"text":format!("Message {i}")}]}})
}
fn session(count: usize) -> Value {
    json!({"id":uuid::Uuid::new_v4().to_string(),"title":"Test","modelId":"model","status":"idle","messages":(0..count).map(message).collect::<Vec<_>>()})
}
#[tokio::test]
async fn history_exceeding_old_limit_persists_without_rewriting_old_messages() {
    let pool = pool().await;
    let mut session = session(9);
    let id = session["id"].as_str().unwrap().to_string();
    for m in session["messages"].as_array_mut().unwrap() {
        m["text"] = json!("x".repeat(600_000));
    }
    assert!(session.to_string().len() > 4 * 1024 * 1024);
    save(&pool, "personal", &session).await.unwrap();
    sqlx::raw_sql("CREATE TRIGGER unchanged_history BEFORE UPDATE ON assistant_messages WHEN OLD.id='m0' BEGIN SELECT RAISE(ABORT,'history rewritten'); END;").execute(&pool).await.unwrap();
    session["title"] = json!("Renamed");
    save(&pool, "personal", &session).await.unwrap();
    session["messages"].as_array_mut().unwrap().push(message(9));
    save(&pool, "personal", &session).await.unwrap();
    let loaded = load(&pool, "personal", &id, None, true).await.unwrap();
    assert_eq!(loaded["messages"], session["messages"]);
    let state: String = sqlx::query_scalar("SELECT state_json FROM assistant_sessions WHERE id=?")
        .bind(&id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(state.len() < 1000);
    assert!(!state.contains("messages"));
    assert!(load(&pool, "other", &id, None, true).await.is_err());
}
#[tokio::test]
async fn cursor_pages_are_disjoint_and_restore_items_at_their_original_turn() {
    let pool = pool().await;
    let mut s = session(125);
    let id = s["id"].as_str().unwrap().to_string();
    s["activities"] =
        json!([{"id":"early","turnId":"m2","summary":"Earlier"},{"id":"recent","turnId":"m100","summary":"Recent"}]);
    save(&pool, "personal", &s).await.unwrap();
    let recent = load(&pool, "personal", &id, Some(i64::MAX), true).await.unwrap();
    assert_eq!(recent["messages"].as_array().unwrap().len(), 50);
    assert_eq!(recent["history"]["beforeSequence"], 75);
    assert_eq!(recent["messages"][0]["turnId"], "m74");
    assert_eq!(recent["activities"].as_array().unwrap().len(), 1);
    assert_eq!(recent["activities"][0]["id"], "recent");
    s["messages"].as_array_mut().unwrap().push(message(125));
    save(&pool, "personal", &s).await.unwrap();
    let middle = load(&pool, "personal", &id, Some(75), true).await.unwrap();
    let earliest = load(&pool, "personal", &id, Some(25), true).await.unwrap();
    assert_eq!(middle["messages"][0]["id"], "m25");
    assert_eq!(middle["messages"][49]["id"], "m74");
    assert_eq!(earliest["messages"][0]["id"], "m0");
    assert_eq!(earliest["history"]["hasMore"], false);
    assert_eq!(earliest["activities"][0]["id"], "early");
}
#[tokio::test]
async fn draft_survives_restart_and_late_flush_cannot_replace_final_content() {
    let pool = pool().await;
    let mut s = session(1);
    let id = s["id"].as_str().unwrap().to_string();
    s["status"] = json!("thinking");
    s["responsePhaseId"] = json!("response");
    save(&pool, "personal", &s).await.unwrap();
    checkpoint(&pool, "personal", &id, "response", "Partial").await.unwrap();
    assert_eq!(
        load(&pool, "personal", &id, None, false).await.unwrap()["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let restored = load(&pool, "personal", &id, None, true).await.unwrap();
    assert_eq!(restored["messages"][1]["text"], "Partial");
    assert_eq!(restored["messages"][1]["interrupted"], true);
    let mut final_message = message(1);
    final_message["id"] = json!("response");
    s["messages"].as_array_mut().unwrap().push(final_message.clone());
    s["status"] = json!("idle");
    save(&pool, "personal", &s).await.unwrap();
    checkpoint(&pool, "personal", &id, "response", "Late stale text")
        .await
        .unwrap();
    assert_eq!(
        load(&pool, "personal", &id, None, true).await.unwrap()["messages"][1],
        final_message
    );
}
#[tokio::test]
async fn delete_cascades_history_and_items_and_failed_save_is_atomic() {
    let pool = pool().await;
    let mut s = session(2);
    let id = s["id"].as_str().unwrap().to_string();
    s["reasoning"] = json!([{"id":"thought","turnId":"m0","text":"Thinking"}]);
    save(&pool, "personal", &s).await.unwrap();
    let mut invalid = s.clone();
    invalid["title"] = json!("Should roll back");
    invalid["messages"].as_array_mut().unwrap().push(message(0));
    assert!(save(&pool, "personal", &invalid).await.is_err());
    assert_eq!(load(&pool, "personal", &id, None, true).await.unwrap()["title"], "Test");
    crate::feat::WorkflowRepository::new(pool.clone(), "personal".into())
        .delete_session(&id)
        .await
        .unwrap();
    for query in [
        "SELECT COUNT(*) FROM assistant_messages",
        "SELECT COUNT(*) FROM assistant_session_items",
    ] {
        let count: i64 = sqlx::query_scalar(query).fetch_one(&pool).await.unwrap();
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn native_writer_skips_historical_sql_and_metadata_excludes_unknown_collections() {
    let pool = pool().await;
    let mut s = session(100);
    s["accidentalHistory"] = json!(["x".repeat(2_000_000)]);
    save(&pool, "personal", &s).await.unwrap();
    let id = s["id"].as_str().unwrap().to_owned();
    with_writer(Default::default(), async {
        let mut loaded=load(&pool,"personal",&id,None,true).await.unwrap();
        assert!(loaded.get("accidentalHistory").is_none());
        sqlx::raw_sql("CREATE TRIGGER no_old_insert BEFORE INSERT ON assistant_messages WHEN NEW.id='m0' BEGIN SELECT RAISE(ABORT,'historical statement'); END;").execute(&pool).await.unwrap();
        loaded["title"]=json!("Changed");
        save(&pool,"personal",&loaded).await.unwrap();
        loaded["messages"].as_array_mut().unwrap().push(message(100));
        save(&pool,"personal",&loaded).await.unwrap();
        assert_eq!(load(&pool,"personal",&id,None,true).await.unwrap()["messages"].as_array().unwrap().len(),101);
    }).await;
}
#[tokio::test]
async fn draft_and_final_message_use_the_same_encoded_size_limit() {
    let pool = pool().await;
    let mut s = session(1);
    s["status"] = json!("thinking");
    s["responsePhaseId"] = json!("draft");
    save(&pool, "personal", &s).await.unwrap();
    assert!(
        checkpoint(
            &pool,
            "personal",
            s["id"].as_str().unwrap(),
            "draft",
            &"x".repeat(3 * 1024 * 1024)
        )
        .await
        .is_err()
    );
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM assistant_messages")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}
