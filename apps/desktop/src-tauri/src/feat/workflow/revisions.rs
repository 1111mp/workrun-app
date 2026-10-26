//! Immutable workflow documents persisted by the SQLite repository.
use crate::config::IWorkflow;
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
