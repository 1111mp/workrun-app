use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IWorkflow {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub document: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_revision_id: Option<String>,
}
