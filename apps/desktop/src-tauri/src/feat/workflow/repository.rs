use super::WorkflowRevision;
use crate::{config::IWorkflow, core::db::DBManager, utils::dirs};
use anyhow::{Context, Result, ensure};
use chrono::Utc;
use serde_json::Value;
use sqlx::{Row, Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct WorkflowRepository {
    pool: SqlitePool,
    workspace: String,
}

fn revision(row: sqlx::sqlite::SqliteRow) -> Result<WorkflowRevision> {
    Ok(WorkflowRevision {
        id: row.try_get("id")?,
        workflow_id: row.try_get("workflow_id")?,
        parent_revision_id: row.try_get("parent_revision_id")?,
        document: serde_json::from_str(row.try_get("document_json")?)?,
        created_at: row.try_get("created_at")?,
        workflow_created_at: row.try_get("workflow_created_at")?,
        source: row.try_get("source")?,
        operation_id: row.try_get("operation_id")?,
    })
}

impl WorkflowRepository {
    pub fn active() -> Result<Self> {
        Ok(Self::new(DBManager::global().pool()?, dirs::active_workspace_id()))
    }

    pub fn new(pool: SqlitePool, workspace: String) -> Self {
        Self { pool, workspace }
    }

    #[cfg(test)]
    pub async fn close(&self) {
        self.pool.close().await;
    }

    pub async fn begin(&self) -> Result<Transaction<'static, Sqlite>> {
        // Reserve the writer before reading the version, avoiding a read/upgrade race.
        Ok(self.pool.begin_with("BEGIN IMMEDIATE").await?)
    }

    pub async fn list(&self) -> Result<Vec<IWorkflow>> {
        let mut tx = self.pool.begin().await?;
        let result = self.list_in(&mut tx).await?;
        tx.commit().await?;
        Ok(result)
    }

    pub async fn list_in(&self, tx: &mut Transaction<'_, Sqlite>) -> Result<Vec<IWorkflow>> {
        sqlx::query("SELECT r.* FROM workflows w JOIN workflow_revisions r ON r.workspace_id=w.workspace_id AND r.workflow_id=w.id AND r.id=w.current_revision_id WHERE w.workspace_id=? AND w.deleted_at IS NULL ORDER BY w.created_at DESC,w.updated_at DESC,w.id")
            .bind(&self.workspace).fetch_all(&mut **tx).await?.into_iter()
            .map(|row| Ok(revision(row)?.workflow())).collect()
    }

    pub async fn get(&self, id: &str) -> Result<IWorkflow> {
        let row = sqlx::query("SELECT r.* FROM workflows w JOIN workflow_revisions r ON r.workspace_id=w.workspace_id AND r.workflow_id=w.id AND r.id=w.current_revision_id WHERE w.workspace_id=? AND w.id=? AND w.deleted_at IS NULL")
            .bind(&self.workspace).bind(id).fetch_optional(&self.pool).await?
            .context("Workflow is not in the catalog")?;
        Ok(revision(row)?.workflow())
    }

    /// Check the version under the same writer lock as the save. A renderer's
    /// earlier read cannot protect against an assistant update during confirmation.
    pub async fn update(&self, id: &str, document: Value, expected_revision_id: Option<&str>) -> Result<IWorkflow> {
        let mut tx = self.begin().await?;
        if let Some(expected) = expected_revision_id {
            let current: Option<String> = sqlx::query_scalar(
                "SELECT current_revision_id FROM workflows WHERE workspace_id=? AND id=? AND deleted_at IS NULL",
            )
            .bind(&self.workspace)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            ensure!(
                current.as_deref() == Some(expected),
                "Workflow changed while this update was being prepared. Read the latest workflow and try saving again."
            );
        }
        let now = Utc::now().to_rfc3339();
        let saved = self
            .save(
                &mut tx,
                IWorkflow {
                    id: id.into(),
                    created_at: now.clone(),
                    updated_at: now,
                    document,
                    current_revision_id: None,
                },
                true,
                "manual",
                None,
                None,
            )
            .await?;
        self.commit(tx).await?;
        Ok(saved.workflow())
    }

    pub async fn revision(&self, id: &str) -> Result<WorkflowRevision> {
        revision(
            sqlx::query("SELECT * FROM workflow_revisions WHERE workspace_id=? AND id=?")
                .bind(&self.workspace)
                .bind(id)
                .fetch_optional(&self.pool)
                .await?
                .context("Workflow revision is unavailable")?,
        )
    }

    pub async fn save(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        candidate: IWorkflow,
        revise: bool,
        source: &str,
        operation: Option<&str>,
        expected_document: Option<&Value>,
    ) -> Result<WorkflowRevision> {
        super::validate_id(&candidate.id)?;
        super::validate_document(&candidate.document, Some(&candidate.id))?;
        let existing = sqlx::query(
            "SELECT current_revision_id,created_at,deleted_at FROM workflows WHERE workspace_id=? AND id=?",
        )
        .bind(&self.workspace)
        .bind(&candidate.id)
        .fetch_optional(&mut **tx)
        .await?;
        if let Some(row) = &existing {
            ensure!(
                row.try_get::<Option<String>, _>("deleted_at")?.is_none(),
                "Workflow has been deleted"
            );
        }
        if let Some(operation) = operation
            && let Some(row) = sqlx::query("SELECT * FROM workflow_revisions WHERE workspace_id=? AND operation_id=?")
                .bind(&self.workspace)
                .bind(operation)
                .fetch_optional(&mut **tx)
                .await?
        {
            let saved = revision(row)?;
            ensure!(
                saved.workflow_id == candidate.id && saved.document == candidate.document,
                "This operation already saved a different workflow definition"
            );
            // Return the historical receipt without reverting a subsequent edit.
            return Ok(saved);
        }
        ensure!(
            existing.is_some() == revise,
            "Workflow creation/revision target does not match the catalog"
        );
        let parent: Option<String> = existing
            .as_ref()
            .map(|row| row.try_get("current_revision_id"))
            .transpose()?;
        if let Some(expected) = expected_document {
            let current: Option<String> = match &parent {
                Some(id) => {
                    sqlx::query_scalar("SELECT document_json FROM workflow_revisions WHERE workspace_id=? AND id=?")
                        .bind(&self.workspace)
                        .bind(id)
                        .fetch_optional(&mut **tx)
                        .await?
                },
                None => None,
            };
            ensure!(
                current
                    .as_deref()
                    .map(serde_json::from_str::<Value>)
                    .transpose()?
                    .as_ref()
                    == Some(expected),
                "Workflow changed while this update was being prepared. Read the latest workflow and prepare a new update."
            );
        }
        // Manual saves have no operation receipt to publish. Identical documents
        // must not create a new historical version just because Save was clicked.
        if operation.is_none()
            && let Some(parent) = &parent
        {
            let row = sqlx::query("SELECT * FROM workflow_revisions WHERE workspace_id=? AND id=?")
                .bind(&self.workspace)
                .bind(parent)
                .fetch_one(&mut **tx)
                .await?;
            let current = revision(row)?;
            if current.document == candidate.document {
                return Ok(current);
            }
        }
        let created: String = existing
            .as_ref()
            .map(|row| row.try_get("created_at"))
            .transpose()?
            .unwrap_or(candidate.created_at);
        let saved = WorkflowRevision {
            id: Uuid::now_v7().to_string(),
            workflow_id: candidate.id,
            parent_revision_id: parent,
            document: candidate.document,
            created_at: candidate.updated_at,
            workflow_created_at: created,
            source: source.into(),
            operation_id: operation.map(str::to_owned),
        };
        sqlx::query("INSERT INTO workflow_revisions (workspace_id,id,workflow_id,parent_revision_id,document_json,created_at,workflow_created_at,source,operation_id) VALUES (?,?,?,?,?,?,?,?,?)")
            .bind(&self.workspace).bind(&saved.id).bind(&saved.workflow_id).bind(&saved.parent_revision_id)
            .bind(serde_json::to_string(&saved.document)?).bind(&saved.created_at).bind(&saved.workflow_created_at)
            .bind(&saved.source).bind(&saved.operation_id).execute(&mut **tx).await?;
        sqlx::query("INSERT INTO workflows (workspace_id,id,current_revision_id,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET current_revision_id=excluded.current_revision_id,updated_at=excluded.updated_at")
            .bind(&self.workspace).bind(&saved.workflow_id).bind(&saved.id).bind(&saved.workflow_created_at).bind(&saved.created_at)
            .execute(&mut **tx).await?;
        Ok(saved)
    }

    /// Pin both sides of the diff in the same transaction that publishes the save.
    pub async fn retain_for_session(
        &self,
        tx: &mut Transaction<'_, Sqlite>,
        session_id: &str,
        saved: &WorkflowRevision,
    ) -> Result<()> {
        for id in saved.parent_revision_id.iter().chain(std::iter::once(&saved.id)) {
            sqlx::query(
                "INSERT OR IGNORE INTO workflow_revision_sessions (workspace_id,session_id,revision_id) VALUES (?,?,?)",
            )
            .bind(&self.workspace)
            .bind(session_id)
            .bind(id)
            .execute(&mut **tx)
            .await?;
        }
        Ok(())
    }

    /// The caller holds the conversation lease; the write transaction also excludes
    /// concurrent workflow saves and pins from other conversations during collection.
    pub async fn delete_session(&self, session_id: &str) -> Result<()> {
        let mut tx = self.begin().await?;
        sqlx::query("INSERT OR IGNORE INTO workflow_revision_gc (workspace_id,revision_id) SELECT workspace_id,revision_id FROM workflow_revision_sessions WHERE workspace_id=? AND session_id=?")
            .bind(&self.workspace).bind(session_id).execute(&mut *tx).await?;
        let deleted = sqlx::query("DELETE FROM assistant_sessions WHERE workspace_id=? AND id=?")
            .bind(&self.workspace)
            .bind(session_id)
            .execute(&mut *tx)
            .await?;
        ensure!(
            deleted.rows_affected() == 1,
            "Conversation was not found in this workspace"
        );
        self.commit(tx).await
    }

    /// Publish only after diff pins are installed. Recheck versions retained by a
    /// deleted conversation whenever a later save replaces a current pointer.
    pub async fn commit(&self, mut tx: Transaction<'_, Sqlite>) -> Result<()> {
        // Keep the latest 50 versions per workflow. Live diff references and the
        // current pointer are protected by the collector below, regardless of age.
        sqlx::query("INSERT OR IGNORE INTO workflow_revision_gc(workspace_id,revision_id) SELECT workspace_id,id FROM (SELECT workspace_id,id,ROW_NUMBER() OVER(PARTITION BY workflow_id ORDER BY created_at DESC,id DESC) AS position FROM workflow_revisions WHERE workspace_id=?) WHERE position>50")
            .bind(&self.workspace).execute(&mut *tx).await?;
        // Deleted identities prevent retries from resurrecting a removed workflow.
        // Their documents survive only while a conversation still references them.
        sqlx::query("INSERT OR IGNORE INTO workflow_revision_gc(workspace_id,revision_id) SELECT r.workspace_id,r.id FROM workflow_revisions r JOIN workflows w ON w.workspace_id=r.workspace_id AND w.id=r.workflow_id WHERE w.workspace_id=? AND w.deleted_at IS NOT NULL")
            .bind(&self.workspace).execute(&mut *tx).await?;
        let candidates: Vec<String> = sqlx::query_scalar("SELECT g.revision_id FROM workflow_revision_gc g WHERE g.workspace_id=? AND NOT EXISTS(SELECT 1 FROM workflows w WHERE w.workspace_id=g.workspace_id AND w.current_revision_id=g.revision_id) AND NOT EXISTS(SELECT 1 FROM workflow_revision_sessions s WHERE s.workspace_id=g.workspace_id AND s.revision_id=g.revision_id)")
            .bind(&self.workspace).fetch_all(&mut *tx).await?;
        for id in candidates {
            // Parent IDs describe lineage, not a live diff reference. Detach only
            // this metadata before removing an unreferenced immutable document.
            sqlx::query(
                "UPDATE workflow_revisions SET parent_revision_id=NULL WHERE workspace_id=? AND parent_revision_id=?",
            )
            .bind(&self.workspace)
            .bind(&id)
            .execute(&mut *tx)
            .await?;
            sqlx::query("DELETE FROM workflow_revisions WHERE workspace_id=? AND id=?")
                .bind(&self.workspace)
                .bind(&id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let mut tx = self.begin().await?;
        let result =
            sqlx::query("UPDATE workflows SET deleted_at=?,current_revision_id=NULL WHERE workspace_id=? AND id=? AND deleted_at IS NULL")
                .bind(Utc::now().to_rfc3339())
                .bind(&self.workspace)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        ensure!(result.rows_affected() == 1, "Workflow is not in the catalog");
        self.commit(tx).await
    }
}

#[cfg(test)]
pub(crate) mod tests;
