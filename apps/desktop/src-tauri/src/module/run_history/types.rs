use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunRecord {
    pub id: String,
    pub target_type: RunTargetType,
    pub target_id: String,
    pub target_name: String,
    pub status: RunStatus,
    pub started_at: String,
    pub input: Option<Value>,
    pub output_view: Value,
    pub target_snapshot: Value,
    #[serde(default)]
    pub runtime: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinalizeRunRecord {
    pub status: RunStatus,
    pub ended_at: String,
    pub duration_ms: i64,
    pub output_view: Value,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendRunEvents {
    pub events: Vec<NewRunEvent>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewRunEvent {
    pub sequence: i64,
    pub event: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryQuery {
    pub target_type: Option<RunTargetType>,
    pub target_id: Option<String>,
    pub status: Option<RunStatus>,
    pub query: Option<String>,
    pub page_size: Option<i64>,
    pub cursor: Option<RunHistoryCursor>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryCursor {
    pub id: String,
    pub started_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunHistoryPage {
    pub items: Vec<RunRecordSummary>,
    pub next_cursor: Option<RunHistoryCursor>,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunTargetType {
    Workflow,
    App,
}

impl RunTargetType {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Workflow => "workflow",
            Self::App => "app",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Running,
    WaitingForInput,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl RunStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::WaitingForInput => "waiting_for_input",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecordSummary {
    pub id: String,
    pub target_type: String,
    pub target_id: String,
    pub target_name: String,
    pub status: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingActionKind {
    ToolApproval,
    HumanReview,
    AskUserQuestion,
}

impl PendingActionKind {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::ToolApproval => "tool_approval",
            Self::HumanReview => "human_review",
            Self::AskUserQuestion => "ask_user_question",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePendingAction {
    pub id: String,
    pub run_id: String,
    pub kind: PendingActionKind,
    pub payload: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingAction {
    pub id: String,
    pub run_id: String,
    pub kind: String,
    pub payload: Value,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    #[serde(flatten)]
    pub summary: RunRecordSummary,
    pub input: Option<Value>,
    pub output_view: Value,
    pub target_snapshot: Value,
    pub runtime: Value,
    pub events: Vec<StoredRunEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRunEvent {
    pub sequence: i64,
    pub event: Value,
    pub created_at: String,
}
