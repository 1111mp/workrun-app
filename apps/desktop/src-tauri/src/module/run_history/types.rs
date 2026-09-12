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
    pub duration_ms: Option<i64>,
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

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySpanKind {
    WorkflowNode,
    Agent,
    ModelCall,
    ToolCall,
}

impl TelemetrySpanKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::WorkflowNode => "workflow_node",
            Self::Agent => "agent",
            Self::ModelCall => "model_call",
            Self::ToolCall => "tool_call",
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TelemetrySpanStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl TelemetrySpanStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunSpan {
    pub id: String,
    pub run_id: String,
    pub parent_span_id: Option<String>,
    pub kind: TelemetrySpanKind,
    pub status: TelemetrySpanStatus,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_name: Option<String>,
    pub started_at: String,
    #[serde(default = "empty_json_object")]
    pub attributes: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishRunSpan {
    pub status: TelemetrySpanStatus,
    pub ended_at: String,
    pub duration_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub total_tokens_estimated: bool,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub audio_input_tokens: Option<i64>,
    pub audio_output_tokens: Option<i64>,
    pub estimated_cost_microusd: Option<i64>,
    pub is_byok: Option<bool>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    #[serde(default = "empty_json_object")]
    pub attributes: Value,
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

/// A local-only rollup for one workflow. Timestamps are RFC 3339 strings so
/// callers can use the same cursor and filtering convention as run history.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunObservabilityQuery {
    pub workflow_id: String,
    pub started_after: Option<String>,
    pub started_before: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunObservability {
    pub overall: MetricSummary,
    pub versions: Vec<VersionMetricSummary>,
    pub spans: Vec<SpanMetricSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricSummary {
    pub count: i64,
    pub completed_count: i64,
    pub failed_count: i64,
    pub cancelled_count: i64,
    pub success_rate: Option<f64>,
    pub average_duration_ms: Option<i64>,
    pub p50_duration_ms: Option<i64>,
    pub p95_duration_ms: Option<i64>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cache_read_tokens: i64,
    pub estimated_cost_microusd: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionMetricSummary {
    pub release_version: String,
    #[serde(flatten)]
    pub metrics: MetricSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpanMetricSummary {
    pub kind: String,
    pub node_id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_name: Option<String>,
    #[serde(flatten)]
    pub metrics: MetricSummary,
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
    pub release_id: Option<String>,
    pub release_version: Option<String>,
    pub app_version: Option<String>,
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
    pub spans: Vec<RunSpan>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRunEvent {
    pub sequence: i64,
    pub event: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSpan {
    pub id: String,
    pub run_id: String,
    pub parent_span_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub node_id: Option<String>,
    pub node_name: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub tool_name: Option<String>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub total_tokens: Option<i64>,
    pub total_tokens_estimated: bool,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub audio_input_tokens: Option<i64>,
    pub audio_output_tokens: Option<i64>,
    pub estimated_cost_microusd: Option<i64>,
    pub is_byok: Option<bool>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub attributes: Value,
}

fn empty_json_object() -> Value {
    Value::Object(Default::default())
}
