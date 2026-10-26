use super::*;
use serde_json::json;

pub(crate) async fn repository() -> WorkflowRepository {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON").execute(&pool).await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../resources/migrations/20261016100000_assistant_workspace.up.sql"
    ))
    .execute(&pool)
    .await
    .unwrap();
    WorkflowRepository::new(pool, "personal".into())
}
fn candidate(id: &str, name: &str) -> IWorkflow {
    IWorkflow {
        id: id.into(),
        created_at: "2026-10-25T00:00:00Z".into(),
        updated_at: Utc::now().to_rfc3339(),
        document: json!({"settings":{"name":name},"nodes":[],"edges":[]}),
        current_revision_id: None,
    }
}
async fn save(
    repo: &WorkflowRepository,
    item: IWorkflow,
    revise: bool,
    op: Option<&str>,
    expected: Option<&Value>,
) -> Result<WorkflowRevision> {
    let mut tx = repo.begin().await?;
    let revision = repo.save(&mut tx, item, revise, "test", op, expected).await?;
    repo.commit(tx).await?;
    Ok(revision)
}
#[tokio::test]
async fn snapshots_retry_conflict_delete_and_workspace_isolation() {
    let repo = repository().await;
    let id = Uuid::now_v7().to_string();
    let original = candidate(&id, "Original");
    let first = save(&repo, original.clone(), false, Some("create"), None)
        .await
        .unwrap();
    let second = save(
        &repo,
        candidate(&id, "Changed"),
        true,
        Some("edit"),
        Some(&original.document),
    )
    .await
    .unwrap();
    assert_eq!(second.parent_revision_id, Some(first.id.clone()));
    let retry = save(&repo, original.clone(), false, Some("create"), None)
        .await
        .unwrap();
    assert_eq!(retry, first);
    assert_eq!(repo.get(&id).await.unwrap().document, second.document);
    assert!(
        save(&repo, candidate(&id, "Stale"), true, None, Some(&original.document))
            .await
            .is_err()
    );
    assert!(
        save(&repo, candidate(&id, "Other"), true, Some("edit"), None)
            .await
            .is_err()
    );
    let other = WorkflowRepository::new(repo.pool.clone(), "team:test".into());
    assert!(other.list().await.unwrap().is_empty());
    assert!(other.get(&id).await.is_err());
    assert!(other.revision(&first.id).await.is_err());
    assert!(other.delete(&id).await.is_err());
    save(&other, original.clone(), false, Some("create"), None)
        .await
        .unwrap();
    repo.delete(&id).await.unwrap();
    assert!(repo.get(&id).await.is_err());
    assert!(repo.list().await.unwrap().is_empty());
    assert!(repo.revision(&first.id).await.is_err());
    assert!(save(&repo, original, false, Some("create"), None).await.is_err());
    assert!(other.get(&id).await.is_ok());
}
#[tokio::test]
async fn rollback_keeps_document_and_revision_pointer_together() {
    let repo = repository().await;
    let id = Uuid::now_v7().to_string();
    let first = save(&repo, candidate(&id, "Original"), false, None, None)
        .await
        .unwrap();
    let mut tx = repo.begin().await.unwrap();
    let staged = repo
        .save(&mut tx, candidate(&id, "Uncommitted"), true, "test", None, None)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(repo.get(&id).await.unwrap().current_revision_id, Some(first.id));
    assert!(repo.revision(&staged.id).await.is_err());
    assert!(
        sqlx::query("UPDATE workflow_revisions SET source='changed'")
            .execute(&repo.pool)
            .await
            .is_err()
    );
}
#[tokio::test]
async fn schema_can_be_rolled_back() {
    let repo = repository().await;
    let saved = save(
        &repo,
        candidate(&Uuid::now_v7().to_string(), "Present"),
        false,
        None,
        None,
    )
    .await
    .unwrap();
    let session = conversation(&repo).await;
    pin(&repo, &session, &saved).await;
    crate::module::assistant::storage::save(
        &repo.pool,
        "personal",
        &json!({
            "id":session,"status":"idle","messages":[{"id":"message","role":"user","text":"Hello"}],
            "activities":[{"id":"activity","turnId":"message","summary":"Checking"}]
        }),
    )
    .await
    .unwrap();
    sqlx::query("INSERT INTO workflow_revision_gc (workspace_id,revision_id) VALUES ('personal',?)")
        .bind(&saved.id)
        .execute(&repo.pool)
        .await
        .unwrap();
    let mut tx = repo.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../resources/migrations/20261016100000_assistant_workspace.down.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let remaining:i64=sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('assistant_sessions','assistant_messages','assistant_session_items','model_calls','workflows','workflow_revisions','workflow_revision_sessions','workflow_revision_gc')")
        .fetch_one(&repo.pool).await.unwrap();
    assert_eq!(remaining, 0);
}

pub(crate) async fn fail_next_commit(repo: &WorkflowRepository) {
    // Violate a deferred FK after INSERT so commit, rather than save, fails.
    sqlx::raw_sql("CREATE TRIGGER break_workflow_pointer AFTER INSERT ON workflows BEGIN UPDATE workflows SET current_revision_id='missing' WHERE workspace_id=NEW.workspace_id AND id=NEW.id; END;")
        .execute(&repo.pool).await.unwrap();
}

#[tokio::test]
async fn competing_updates_cannot_overwrite_the_same_base() {
    let repo = repository().await;
    let id = Uuid::now_v7().to_string();
    let base = candidate(&id, "Original");
    save(&repo, base.clone(), false, None, None).await.unwrap();
    let (left, right) = tokio::join!(
        save(&repo, candidate(&id, "Left"), true, None, Some(&base.document)),
        save(&repo, candidate(&id, "Right"), true, None, Some(&base.document)),
    );
    assert_ne!(left.is_ok(), right.is_ok());
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_revisions")
        .fetch_one(&repo.pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
}

async fn conversation(repo: &WorkflowRepository) -> String {
    let id = Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO assistant_sessions (id,workspace_id,state_json,updated_at) VALUES (?,?,'{}','now')")
        .bind(&id)
        .bind(&repo.workspace)
        .execute(&repo.pool)
        .await
        .unwrap();
    id
}
async fn pin(repo: &WorkflowRepository, session: &str, revision: &WorkflowRevision) {
    let mut tx = repo.begin().await.unwrap();
    repo.retain_for_session(&mut tx, session, revision).await.unwrap();
    tx.commit().await.unwrap();
}

#[tokio::test]
async fn deleting_conversation_collects_only_unreferenced_snapshots() {
    let repo = repository().await;
    let first_session = conversation(&repo).await;
    let second_session = conversation(&repo).await;
    let id = Uuid::now_v7().to_string();
    let a = save(&repo, candidate(&id, "A"), false, None, None).await.unwrap();
    let b = save(&repo, candidate(&id, "B"), true, None, None).await.unwrap();
    pin(&repo, &first_session, &b).await;
    let c = save(&repo, candidate(&id, "C"), true, None, None).await.unwrap();
    pin(&repo, &second_session, &c).await;
    let manual = save(&repo, candidate(&id, "Manual"), true, None, None).await.unwrap();
    let current = save(&repo, candidate(&id, "Current"), true, None, None).await.unwrap();
    repo.delete_session(&first_session).await.unwrap();
    assert!(repo.revision(&a.id).await.is_err());
    assert_eq!(repo.revision(&b.id).await.unwrap().document, b.document);
    assert_eq!(repo.revision(&c.id).await.unwrap().document, c.document);
    repo.delete_session(&second_session).await.unwrap();
    assert!(repo.revision(&b.id).await.is_err());
    assert!(repo.revision(&c.id).await.is_err());
    assert_eq!(repo.revision(&manual.id).await.unwrap().parent_revision_id, None);
    assert_eq!(repo.get(&id).await.unwrap().current_revision_id, Some(current.id));
    assert!(repo.delete_session(&second_session).await.is_err());
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&repo.pool)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn current_versions_are_kept_and_later_become_collectible() {
    let repo = repository().await;
    let session = conversation(&repo).await;
    let id = Uuid::now_v7().to_string();
    let a = save(&repo, candidate(&id, "A"), false, None, None).await.unwrap();
    let b = save(&repo, candidate(&id, "B"), true, None, None).await.unwrap();
    pin(&repo, &session, &b).await;
    repo.delete_session(&session).await.unwrap();
    assert!(repo.revision(&a.id).await.is_err());
    assert_eq!(repo.get(&id).await.unwrap().document, b.document);
    let next_session = conversation(&repo).await;
    let mut tx = repo.begin().await.unwrap();
    let c = repo
        .save(&mut tx, candidate(&id, "C"), true, "conversation", None, None)
        .await
        .unwrap();
    repo.retain_for_session(&mut tx, &next_session, &c).await.unwrap();
    repo.commit(tx).await.unwrap();
    repo.delete(&id).await.unwrap();
    assert!(repo.revision(&b.id).await.is_ok());
    assert!(repo.revision(&c.id).await.is_ok());
    repo.delete_session(&next_session).await.unwrap();
    assert!(repo.revision(&b.id).await.is_err());
    assert!(repo.revision(&c.id).await.is_err()); // Only the lightweight deleted identity remains.
    assert!(repo.get(&id).await.is_err());
}

#[tokio::test]
async fn cleanup_failure_rolls_back_conversation_references_and_parent_detachment() {
    let repo = repository().await;
    let session = conversation(&repo).await;
    let id = Uuid::now_v7().to_string();
    let a = save(&repo, candidate(&id, "A"), false, None, None).await.unwrap();
    let b = save(&repo, candidate(&id, "B"), true, None, None).await.unwrap();
    pin(&repo, &session, &b).await;
    sqlx::raw_sql("CREATE TRIGGER block_collection BEFORE DELETE ON workflow_revisions BEGIN SELECT RAISE(ABORT,'injected failure'); END;")
        .execute(&repo.pool).await.unwrap();
    assert!(repo.delete_session(&session).await.is_err());
    let references: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_revision_sessions WHERE session_id=?")
        .bind(&session)
        .fetch_one(&repo.pool)
        .await
        .unwrap();
    assert_eq!(references, 2);
    assert_eq!(repo.revision(&b.id).await.unwrap().parent_revision_id, Some(a.id));
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM assistant_sessions WHERE id=?)")
        .bind(&session)
        .fetch_one(&repo.pool)
        .await
        .unwrap();
    assert!(exists);
}

#[tokio::test]
async fn conversation_links_and_cleanup_cannot_cross_workspaces() {
    let repo = repository().await;
    let other = WorkflowRepository::new(repo.pool.clone(), "team:other".into());
    let session = conversation(&repo).await;
    let target = candidate(&Uuid::now_v7().to_string(), "Private");
    let mut tx = other.begin().await.unwrap();
    let staged = other
        .save(&mut tx, target.clone(), false, "conversation", Some("op"), None)
        .await
        .unwrap();
    assert!(other.retain_for_session(&mut tx, &session, &staged).await.is_err());
    tx.rollback().await.unwrap();
    assert!(other.list().await.unwrap().is_empty());
    assert!(other.delete_session(&session).await.is_err());
    let saved = save(&repo, target, false, None, None).await.unwrap();
    pin(&repo, &session, &saved).await;
    repo.delete_session(&session).await.unwrap();
    assert!(repo.revision(&saved.id).await.is_ok());
}

#[tokio::test]
async fn later_manual_save_reclaims_a_version_retained_when_its_conversation_was_deleted() {
    let repo = repository().await;
    let session = conversation(&repo).await;
    let id = Uuid::now_v7().to_string();
    let current = save(&repo, candidate(&id, "Conversation"), false, None, None)
        .await
        .unwrap();
    pin(&repo, &session, &current).await;
    repo.delete_session(&session).await.unwrap();
    assert!(repo.revision(&current.id).await.is_ok());
    let manual = save(&repo, candidate(&id, "Manual"), true, None, None).await.unwrap();
    assert!(repo.revision(&current.id).await.is_err());
    assert_eq!(repo.get(&id).await.unwrap().document, manual.document);
    assert_eq!(repo.revision(&manual.id).await.unwrap().parent_revision_id, None);
    let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_revision_gc")
        .fetch_one(&repo.pool)
        .await
        .unwrap();
    assert_eq!(pending, 0);
}

#[tokio::test]
async fn unchanged_manual_saves_are_deduplicated_and_history_is_bounded() {
    let repo = repository().await;
    let id = Uuid::now_v7().to_string();
    let first = save(&repo, candidate(&id, "Original"), false, None, None)
        .await
        .unwrap();
    let same = save(&repo, candidate(&id, "Original"), true, None, None).await.unwrap();
    assert_eq!(same.id, first.id);
    for i in 0..60 {
        save(&repo, candidate(&id, &format!("Version {i}")), true, None, None)
            .await
            .unwrap();
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_revisions WHERE workflow_id=?")
        .bind(&id)
        .fetch_one(&repo.pool)
        .await
        .unwrap();
    assert_eq!(count, 50);
    assert_eq!(repo.get(&id).await.unwrap().document["settings"]["name"], "Version 59");
    assert!(
        sqlx::query("PRAGMA foreign_key_check")
            .fetch_all(&repo.pool)
            .await
            .unwrap()
            .is_empty()
    );
}
