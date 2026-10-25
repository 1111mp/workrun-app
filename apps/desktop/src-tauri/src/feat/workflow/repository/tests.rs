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
        "../../../../resources/migrations/20261025100000_workflow_catalog.up.sql"
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
    tx.commit().await?;
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
    assert_eq!(repo.revision(&first.id).await.unwrap(), first);
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
    save(
        &repo,
        candidate(&Uuid::now_v7().to_string(), "Present"),
        false,
        None,
        None,
    )
    .await
    .unwrap();
    let mut tx = repo.begin().await.unwrap();
    sqlx::raw_sql(include_str!(
        "../../../../resources/migrations/20261025100000_workflow_catalog.down.sql"
    ))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();
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
