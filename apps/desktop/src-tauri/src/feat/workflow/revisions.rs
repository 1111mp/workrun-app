//! Immutable workflow definitions. The catalog contains only the current version;
//! older documents are loaded individually when a comparison is requested.
use super::validate_id;
use crate::config::IWorkflow;
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRevision {
    pub id: String,
    pub workflow_id: String,
    pub parent_revision_id: Option<String>,
    pub document: Value,
    pub created_at: String,
    pub workflow_created_at: String,
    pub source: String,
    pub operation_id: Option<String>,
}
impl WorkflowRevision {
    pub fn workflow(&self) -> IWorkflow {
        IWorkflow {
            id: self.workflow_id.clone(),
            created_at: self.workflow_created_at.clone(),
            updated_at: self.created_at.clone(),
            document: self.document.clone(),
            current_revision_id: Some(self.id.clone()),
        }
    }
}

pub struct RevisionStore {
    root: PathBuf,
}
impl RevisionStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    fn path(&self, id: &str) -> Result<PathBuf> {
        Ok(self.root.join(format!("{}.json", Uuid::parse_str(id)?)))
    }
    pub fn load(&self, id: &str) -> Result<WorkflowRevision> {
        let revision: WorkflowRevision = serde_json::from_slice(&std::fs::read(self.path(id)?)?)?;
        ensure!(revision.id == id, "Workflow revision identity mismatch");
        Ok(revision)
    }
    pub fn find(&self, id: &str) -> Result<Option<WorkflowRevision>> {
        match std::fs::read(self.path(id)?) {
            Ok(bytes) => {
                let revision: WorkflowRevision = serde_json::from_slice(&bytes)?;
                ensure!(revision.id == id, "Workflow revision identity mismatch");
                Ok(Some(revision))
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
    fn write(&self, revision: &WorkflowRevision) -> Result<()> {
        std::fs::create_dir_all(&self.root)?;
        let path = self.path(&revision.id)?;
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&serde_json::to_vec(revision)?)?;
        temporary.as_file().sync_all()?;
        match temporary.persist_noclobber(path) {
            Ok(_) => Ok(()),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(self.load(&revision.id)? == *revision, "Workflow revision is immutable");
                Ok(())
            },
            Err(error) => Err(error.error.into()),
        }
    }
    fn baseline(&self, workflow: &IWorkflow) -> Result<String> {
        if let Some(id) = &workflow.current_revision_id {
            let revision = self.load(id)?;
            ensure!(
                revision.workflow_id == workflow.id && revision.document == workflow.document,
                "Current workflow does not match its revision"
            );
            return Ok(id.clone());
        }
        // Old catalogs and imports have no version pointer. A deterministic ID
        // lets a failed catalog write retry without duplicating their baseline.
        let hash = hex::encode(Sha256::digest(serde_json::to_vec(workflow)?));
        let id = Uuid::parse_str(&hash[..32])?.to_string();
        self.write(&WorkflowRevision {
            id: id.clone(),
            workflow_id: workflow.id.clone(),
            parent_revision_id: None,
            document: workflow.document.clone(),
            created_at: workflow.updated_at.clone(),
            workflow_created_at: workflow.created_at.clone(),
            source: "existing".into(),
            operation_id: None,
        })?;
        Ok(id)
    }
    /// A saved operation is reusable only when its revision belongs to the
    /// committed chain. A file left by a failed catalog write is merely staged.
    pub fn saved_operation(
        &self,
        current: Option<&IWorkflow>,
        operation_id: &str,
        workflow_id: &str,
        document: &Value,
    ) -> Result<Option<WorkflowRevision>> {
        let Some(saved) = self.find(operation_id)? else {
            return Ok(None);
        };
        ensure!(
            saved.workflow_id == workflow_id
                && saved.operation_id.as_deref() == Some(operation_id)
                && &saved.document == document,
            "This operation already saved a different workflow definition"
        );
        let mut cursor = current.and_then(|workflow| workflow.current_revision_id.clone());
        let mut visited = std::collections::HashSet::new();
        while let Some(id) = cursor {
            ensure!(visited.insert(id.clone()), "Workflow revision cycle");
            let revision = self.load(&id)?;
            ensure!(
                revision.workflow_id == workflow_id,
                "Workflow revision belongs to another workflow"
            );
            if id == saved.id {
                return Ok(Some(saved));
            }
            cursor = revision.parent_revision_id;
        }
        Ok(None)
    }
    pub fn prepare(
        &self,
        before: Option<&IWorkflow>,
        workflow: &IWorkflow,
        source: &str,
        operation_id: Option<&str>,
    ) -> Result<WorkflowRevision> {
        validate_id(&workflow.id)?;
        if before.is_none() {
            ensure!(
                !self.root.join(format!("deleted-{}", workflow.id)).exists(),
                "Workflow was deleted"
            );
        }
        let parent_revision_id = before.map(|workflow| self.baseline(workflow)).transpose()?;
        let id = operation_id
            .map(str::to_owned)
            .unwrap_or_else(|| Uuid::now_v7().to_string());
        if let Some(staged) = self.find(&id)? {
            ensure!(
                staged.workflow_id == workflow.id
                    && staged.document == workflow.document
                    && staged.parent_revision_id == parent_revision_id
                    && staged.operation_id.as_deref() == operation_id,
                "Workflow changed since this revision was prepared"
            );
            return Ok(staged);
        }
        let revision = WorkflowRevision {
            id,
            workflow_id: workflow.id.clone(),
            parent_revision_id,
            document: workflow.document.clone(),
            created_at: workflow.updated_at.clone(),
            workflow_created_at: workflow.created_at.clone(),
            source: source.into(),
            operation_id: operation_id.map(str::to_owned),
        };
        self.write(&revision)?;
        Ok(revision)
    }
    pub fn mark_deleted(&self, workflow: &IWorkflow) -> Result<()> {
        let id = &workflow.id;
        validate_id(id)?;
        self.baseline(workflow)?;
        std::fs::create_dir_all(&self.root)?;
        std::fs::File::create(self.root.join(format!("deleted-{id}")))?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn workflow(id: &str, name: &str) -> IWorkflow {
        IWorkflow {
            id: id.into(),
            created_at: "created".into(),
            updated_at: "saved".into(),
            current_revision_id: None,
            document: json!({"settings":{"name":name},"nodes":[],"edges":[]}),
        }
    }
    #[test]
    fn versions_share_parents_and_retries_do_not_replace_later_edits() {
        let root = tempfile::tempdir().unwrap();
        let store = RevisionStore::new(root.path().into());
        let id = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let first = store.prepare(None, &workflow(&id, "Original"), "manual", None).unwrap();
        let second = store
            .prepare(
                Some(&first.workflow()),
                &workflow(&id, "Edited"),
                "conversation",
                Some(&operation),
            )
            .unwrap();
        let third = store
            .prepare(Some(&second.workflow()), &workflow(&id, "Later"), "manual", None)
            .unwrap();
        assert_eq!(second.parent_revision_id, Some(first.id.clone()));
        assert_eq!(third.parent_revision_id, Some(second.id.clone()));
        assert_eq!(
            store
                .saved_operation(Some(&third.workflow()), &operation, &id, &second.document)
                .unwrap(),
            Some(second.clone())
        );
        assert_eq!(store.load(&first.id).unwrap().document, first.document);
        assert!(
            store
                .saved_operation(Some(&third.workflow()), &operation, &id, &first.document)
                .is_err()
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 3);
    }
    #[test]
    fn staged_revisions_retry_safely_and_legacy_baselines_are_written_once() {
        let root = tempfile::tempdir().unwrap();
        let store = RevisionStore::new(root.path().into());
        let id = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let original = workflow(&id, "Legacy");
        let edited = workflow(&id, "Edited");
        let staged = store
            .prepare(Some(&original), &edited, "conversation", Some(&operation))
            .unwrap();
        assert!(
            store
                .saved_operation(Some(&original), &operation, &id, &edited.document)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .prepare(Some(&original), &edited, "conversation", Some(&operation))
                .unwrap(),
            staged
        );
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 2);
        assert!(
            store
                .prepare(
                    Some(&workflow(&id, "Concurrent edit")),
                    &edited,
                    "conversation",
                    Some(&operation)
                )
                .is_err()
        );
        assert!(store.load("../../outside").is_err());
        store.mark_deleted(&original).unwrap();
        assert!(store.prepare(None, &edited, "conversation", Some(&operation)).is_err());
    }
    #[tokio::test]
    async fn failed_catalog_commit_keeps_current_pointer_and_reuses_staged_snapshot() {
        use crate::config::{Draft, IWorkflows};
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("revisions");
        let store = RevisionStore::new(root.clone());
        let id = Uuid::new_v4().to_string();
        let operation = Uuid::new_v4().to_string();
        let original = store
            .prepare(None, &workflow(&id, "Original"), "manual", None)
            .unwrap()
            .workflow();
        let updated = workflow(&id, "Updated");
        let catalog = Draft::new(IWorkflows {
            workflows: vec![original.clone()],
        });
        let blocked = directory.path().join("blocked");
        std::fs::create_dir(&blocked).unwrap();
        let staged = store
            .prepare(Some(&original), &updated, "conversation", Some(&operation))
            .unwrap();
        let candidate = staged.workflow();
        let failed = catalog
            .with_data_modify(|mut data| async move {
                data.replace_workflow(candidate);
                crate::utils::help::save_json_atomic(&blocked, &data).await?;
                Ok((data, ()))
            })
            .await;
        assert!(failed.is_err());
        assert_eq!(
            catalog.data_arc().find_workflow(&id).unwrap().current_revision_id,
            original.current_revision_id
        );
        assert!(
            store
                .saved_operation(Some(&original), &operation, &id, &updated.document)
                .unwrap()
                .is_none()
        );
        let retry = store
            .prepare(Some(&original), &updated, "conversation", Some(&operation))
            .unwrap();
        assert_eq!(retry, staged);
        let path = directory.path().join("catalog.json");
        let candidate = retry.workflow();
        catalog
            .with_data_modify(|mut data| async move {
                data.replace_workflow(candidate);
                crate::utils::help::save_json_atomic(&path, &data).await?;
                Ok((data, ()))
            })
            .await
            .unwrap();
        let current = catalog.data_arc().find_workflow(&id).unwrap();
        assert_eq!(current.current_revision_id.as_deref(), Some(operation.as_str()));
        assert!(
            store
                .saved_operation(Some(&current), &operation, &id, &updated.document)
                .unwrap()
                .is_some()
        );
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 2);
    }
}
