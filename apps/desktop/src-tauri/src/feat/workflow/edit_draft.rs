use crate::{core::db::DBManager, utils::dirs};
use anyhow::{Result, ensure};
use chrono::{DateTime, Utc};
use futures::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEditDraft {
    pub document: Value,
    pub base_revision_id: Option<String>,
    pub saved_at: String,
}

struct EditDraftRepository {
    pool: SqlitePool,
    workspace: String,
}

impl EditDraftRepository {
    fn new(pool: SqlitePool, workspace: String) -> Result<Self> {
        ensure!(
            workspace == "personal",
            "Editing stashes are available only in personal mode"
        );
        Ok(Self { pool, workspace })
    }

    fn active() -> Result<Self> {
        Self::new(DBManager::global().pool()?, dirs::active_workspace_id())
    }

    async fn get(&self, workflow_id: Option<&str>) -> Result<Option<WorkflowEditDraft>> {
        if let Some(id) = workflow_id {
            super::validate_id(id)?;
        }
        let row = sqlx::query("SELECT document_json,base_revision_id,saved_at FROM workflow_edit_drafts WHERE workspace_id=? AND draft_key=?")
            .bind(&self.workspace).bind(workflow_id.unwrap_or("new")).fetch_optional(&self.pool).await?;
        row.map(|row| {
            Ok(WorkflowEditDraft {
                document: serde_json::from_str(row.try_get("document_json")?)?,
                base_revision_id: row.try_get("base_revision_id")?,
                saved_at: row.try_get("saved_at")?,
            })
        })
        .transpose()
    }

    async fn persist(
        &self,
        workflow_id: Option<&str>,
        document: Value,
        base_revision_id: Option<&str>,
        legacy: Option<(&Value, &str)>,
    ) -> Result<WorkflowEditDraft> {
        super::validate_document(&document, workflow_id)?;
        if let Some(id) = workflow_id {
            super::validate_id(id)?;
        }
        if let Some(id) = base_revision_id {
            super::validate_id(id)?;
        }
        ensure!(
            workflow_id.is_some() || base_revision_id.is_none(),
            "New workflow stashes cannot reference a revision"
        );
        if let Some((base, saved_at)) = legacy {
            super::validate_document(base, workflow_id)?;
            DateTime::parse_from_rfc3339(saved_at)?;
        }
        let mut tx = self.pool.begin_with("BEGIN IMMEDIATE").await?;
        if let Some(id) = workflow_id {
            let live: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM workflows WHERE workspace_id=? AND id=? AND deleted_at IS NULL)",
            )
            .bind(&self.workspace)
            .bind(id)
            .fetch_one(&mut *tx)
            .await?;
            ensure!(live, "Workflow is not in the catalog");
        }
        let mut base_revision_id = base_revision_id.map(str::to_owned);
        if let Some((base, _)) = legacy {
            if let Some(id) = workflow_id {
                // Match the historical baseline, never silently rebase a stale stash
                // onto the current version. Missing history remains an unknown token.
                let mut rows = sqlx::query("SELECT id,document_json FROM workflow_revisions WHERE workspace_id=? AND workflow_id=? ORDER BY created_at DESC,id DESC")
                    .bind(&self.workspace).bind(id).fetch(&mut *tx);
                while let Some(row) = rows.try_next().await? {
                    if serde_json::from_str::<Value>(row.try_get("document_json")?)? == *base {
                        base_revision_id = Some(row.try_get("id")?);
                        break;
                    }
                }
            }
        } else if let Some(base) = &base_revision_id {
            let owner: Option<String> =
                sqlx::query_scalar("SELECT workflow_id FROM workflow_revisions WHERE workspace_id=? AND id=?")
                    .bind(&self.workspace)
                    .bind(base)
                    .fetch_optional(&mut *tx)
                    .await?;
            ensure!(
                owner.as_deref().is_none_or(|owner| Some(owner) == workflow_id),
                "Revision belongs to a different workflow"
            );
        }
        let draft = WorkflowEditDraft {
            document,
            base_revision_id,
            saved_at: legacy
                .map(|(_, date)| date.to_owned())
                .unwrap_or_else(|| Utc::now().to_rfc3339()),
        };
        let sql = if legacy.is_some() {
            // Retrying migration must never overwrite a newer SQLite stash.
            "INSERT INTO workflow_edit_drafts (workspace_id,draft_key,workflow_id,base_revision_id,document_json,saved_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,draft_key) DO NOTHING"
        } else {
            "INSERT INTO workflow_edit_drafts (workspace_id,draft_key,workflow_id,base_revision_id,document_json,saved_at) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,draft_key) DO UPDATE SET base_revision_id=excluded.base_revision_id,document_json=excluded.document_json,saved_at=excluded.saved_at"
        };
        sqlx::query(sql)
            .bind(&self.workspace)
            .bind(workflow_id.unwrap_or("new"))
            .bind(workflow_id)
            .bind(&draft.base_revision_id)
            .bind(serde_json::to_string(&draft.document)?)
            .bind(&draft.saved_at)
            .execute(&mut *tx)
            .await?;
        let row = sqlx::query("SELECT document_json,base_revision_id,saved_at FROM workflow_edit_drafts WHERE workspace_id=? AND draft_key=?")
            .bind(&self.workspace).bind(workflow_id.unwrap_or("new")).fetch_one(&mut *tx).await?;
        let result = WorkflowEditDraft {
            document: serde_json::from_str(row.try_get("document_json")?)?,
            base_revision_id: row.try_get("base_revision_id")?,
            saved_at: row.try_get("saved_at")?,
        };
        tx.commit().await?;
        Ok(result)
    }

    async fn remove(&self, workflow_id: Option<&str>) -> Result<()> {
        if let Some(id) = workflow_id {
            super::validate_id(id)?;
        }
        sqlx::query("DELETE FROM workflow_edit_drafts WHERE workspace_id=? AND draft_key=?")
            .bind(&self.workspace)
            .bind(workflow_id.unwrap_or("new"))
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}

pub async fn get_workflow_edit_draft(workflow_id: Option<String>) -> Result<Option<WorkflowEditDraft>> {
    EditDraftRepository::active()?.get(workflow_id.as_deref()).await
}

pub async fn save_workflow_edit_draft(
    workflow_id: Option<String>,
    document: Value,
    base_revision_id: Option<String>,
) -> Result<WorkflowEditDraft> {
    EditDraftRepository::active()?
        .persist(workflow_id.as_deref(), document, base_revision_id.as_deref(), None)
        .await
}

pub async fn import_workflow_edit_draft(
    workflow_id: Option<String>,
    document: Value,
    base_document: Value,
    saved_at: String,
) -> Result<WorkflowEditDraft> {
    EditDraftRepository::active()?
        .persist(
            workflow_id.as_deref(),
            document,
            None,
            Some((&base_document, &saved_at)),
        )
        .await
}

pub async fn remove_workflow_edit_draft(workflow_id: Option<String>) -> Result<()> {
    EditDraftRepository::active()?.remove(workflow_id.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::super::repository::WorkflowRepository;
    use super::*;
    use crate::config::IWorkflow;
    use serde_json::json;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    async fn pool(path: Option<&std::path::Path>) -> SqlitePool {
        let options = match path {
            Some(path) => SqliteConnectOptions::new().filename(path).create_if_missing(true),
            None => SqliteConnectOptions::new().in_memory(true),
        }
        .foreign_keys(true);
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap()
    }

    async fn initialize(pool: &SqlitePool) {
        sqlx::raw_sql(include_str!(
            "../../../resources/migrations/20261016100000_assistant_workspace.up.sql"
        ))
        .execute(pool)
        .await
        .unwrap();
        sqlx::raw_sql(include_str!(
            "../../../resources/migrations/20261027100000_workflow_edit_drafts.up.sql"
        ))
        .execute(pool)
        .await
        .unwrap();
    }

    fn document(name: &str) -> Value {
        json!({"nodes":[],"edges":[],"settings":{"name":name,"mode":"task","inputSchema":{"fields":[]}}})
    }

    async fn save_workflow(pool: &SqlitePool, id: &str, name: &str, revise: bool) -> String {
        let repository = WorkflowRepository::new(pool.clone(), "personal".into());
        let mut tx = repository.begin().await.unwrap();
        let now = Utc::now().to_rfc3339();
        let saved = repository
            .save(
                &mut tx,
                IWorkflow {
                    id: id.into(),
                    created_at: now.clone(),
                    updated_at: now,
                    document: document(name),
                    current_revision_id: None,
                },
                revise,
                "test",
                None,
                None,
            )
            .await
            .unwrap();
        repository.commit(tx).await.unwrap();
        saved.id
    }

    #[tokio::test]
    async fn separate_rows_upsert_isolate_and_leave_execution_definition_unchanged() {
        let pool = pool(None).await;
        initialize(&pool).await;
        let repository = EditDraftRepository::new(pool.clone(), "personal".into()).unwrap();
        let first = Uuid::now_v7().to_string();
        let second = Uuid::now_v7().to_string();
        let base = save_workflow(&pool, &first, "Official", false).await;
        save_workflow(&pool, &second, "Other", false).await;
        repository
            .persist(Some(&first), document("Temporary"), Some(&base), None)
            .await
            .unwrap();
        repository
            .persist(Some(&second), document("Other draft"), None, None)
            .await
            .unwrap();
        repository
            .persist(None, document("New unsaved"), None, None)
            .await
            .unwrap();
        repository
            .persist(Some(&first), document("Replaced temporary"), Some(&base), None)
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM workflow_edit_drafts")
                .fetch_one(&pool)
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            repository.get(Some(&first)).await.unwrap().unwrap().document,
            document("Replaced temporary")
        );
        let catalog = WorkflowRepository::new(pool.clone(), "personal".into());
        assert_eq!(catalog.list().await.unwrap().len(), 2);
        assert_eq!(catalog.get(&first).await.unwrap().document, document("Official"));
        assert_eq!(
            catalog.get(&first).await.unwrap().current_revision_id.as_deref(),
            Some(base.as_str())
        );
        repository.remove(Some(&first)).await.unwrap();
        assert!(repository.get(Some(&first)).await.unwrap().is_none());
        assert!(repository.get(Some(&second)).await.unwrap().is_some());
        assert!(repository.get(None).await.unwrap().is_some());
        catalog.delete(&second).await.unwrap();
        assert!(repository.get(Some(&second)).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn migration_retains_original_baseline_and_never_overwrites_a_newer_sqlite_stash() {
        let pool = pool(None).await;
        initialize(&pool).await;
        let repository = EditDraftRepository::new(pool.clone(), "personal".into()).unwrap();
        let id = Uuid::now_v7().to_string();
        let original = save_workflow(&pool, &id, "Original", false).await;
        let latest = save_workflow(&pool, &id, "Changed elsewhere", true).await;
        let baseline = document("Original");
        let migrated = repository
            .persist(
                Some(&id),
                document("Legacy editing"),
                None,
                Some((&baseline, "2026-10-27T00:00:00.000Z")),
            )
            .await
            .unwrap();
        assert_eq!(migrated.base_revision_id.as_deref(), Some(original.as_str()));
        let newer = repository
            .persist(Some(&id), document("New SQLite editing"), Some(&latest), None)
            .await
            .unwrap();
        let retry = repository
            .persist(
                Some(&id),
                document("Legacy editing"),
                None,
                Some((&baseline, "2026-10-27T00:00:00.000Z")),
            )
            .await
            .unwrap();
        assert_eq!(retry, newer);
        repository.remove(Some(&id)).await.unwrap();
        let unknown = repository
            .persist(
                Some(&id),
                document("Unknown old baseline"),
                None,
                Some((&document("History no longer retained"), "2026-10-27T00:00:00Z")),
            )
            .await
            .unwrap();
        assert!(unknown.base_revision_id.is_none());
    }

    #[tokio::test]
    async fn drafts_survive_reopening_and_reject_invalid_ownership_or_deleted_targets() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("drafts.sqlite");
        let initial = pool(Some(&path)).await;
        initialize(&initial).await;
        let repository = EditDraftRepository::new(initial.clone(), "personal".into()).unwrap();
        let draft = repository
            .persist(None, document("Restart me"), None, None)
            .await
            .unwrap();
        initial.close().await;
        let reopened = pool(Some(&path)).await;
        let repository = EditDraftRepository::new(reopened.clone(), "personal".into()).unwrap();
        assert_eq!(repository.get(None).await.unwrap(), Some(draft));
        assert!(EditDraftRepository::new(reopened.clone(), "team:test".into()).is_err());
        let id = Uuid::now_v7().to_string();
        assert!(
            repository
                .persist(Some(&id), document("Missing target"), None, None)
                .await
                .is_err()
        );
        let base = save_workflow(&reopened, &id, "Official", false).await;
        assert!(
            repository
                .persist(None, document("New"), Some(&base), None)
                .await
                .is_err()
        );
        let other = Uuid::now_v7().to_string();
        save_workflow(&reopened, &other, "Other", false).await;
        assert!(
            repository
                .persist(Some(&other), document("Wrong baseline"), Some(&base), None)
                .await
                .is_err()
        );
        WorkflowRepository::new(reopened.clone(), "personal".into())
            .delete(&id)
            .await
            .unwrap();
        assert!(
            repository
                .persist(Some(&id), document("Deleted"), None, None)
                .await
                .is_err()
        );
        repository.remove(None).await.unwrap();
        assert!(sqlx::query("INSERT INTO workflow_edit_drafts (workspace_id,draft_key,document_json,saved_at) VALUES ('personal','new','[]','now')")
            .execute(&reopened).await.is_err());
        assert!(sqlx::query("INSERT INTO workflow_edit_drafts (workspace_id,draft_key,document_json,saved_at) VALUES ('team:test','new',?, 'now')")
            .bind(document("Invalid scope").to_string()).execute(&reopened).await.is_err());
    }

    #[tokio::test]
    async fn an_old_baseline_token_does_not_block_revision_collection_or_later_saves() {
        let pool = pool(None).await;
        initialize(&pool).await;
        let id = Uuid::now_v7().to_string();
        let base = save_workflow(&pool, &id, "Original", false).await;
        let repository = EditDraftRepository::new(pool.clone(), "personal".into()).unwrap();
        repository
            .persist(Some(&id), document("Long lived edit"), Some(&base), None)
            .await
            .unwrap();
        for index in 0..52 {
            save_workflow(&pool, &id, &format!("Revision {index}"), true).await;
        }
        assert_eq!(
            repository
                .get(Some(&id))
                .await
                .unwrap()
                .unwrap()
                .base_revision_id
                .as_deref(),
            Some(base.as_str())
        );
        assert!(
            WorkflowRepository::new(pool.clone(), "personal".into())
                .revision(&base)
                .await
                .is_err()
        );
    }
}
