//! Evaluation scoring adapter for Workrun workflow runs.
//!
//! Workrun owns execution and its durable run history. This module deliberately
//! only adapts a completed workflow's redacted output into `adk-eval` inputs,
//! so evaluations cannot create an execution path that bypasses Workrun safety.

use adk_eval::{
    ResponseMatchConfig, ResponseScorer, ToolTrajectoryConfig, ToolTrajectoryScorer, ToolUse,
    criteria::SimilarityAlgorithm,
};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::collections::{HashMap, HashSet};

use crate::{
    core::db::DBManager,
    module::{
        run_manager::{self, StartWorkflowRun},
        workflow::EvaluationExecutionProfile,
    },
};

fn empty_json_object() -> Value {
    json!({})
}

fn workflow_snapshot_fingerprint(snapshot: &Value) -> String {
    // A draft has no release version until publication. Hashing the immutable
    // snapshot lets the quality gate distinguish it from an earlier draft.
    format!("{:x}", Sha256::digest(snapshot.to_string().as_bytes()))
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationQualityGate {
    #[serde(default)]
    pub require_evaluation: bool,
    pub min_pass_rate: Option<f64>,
    pub max_cost_microusd: Option<i64>,
    pub max_duration_ms: Option<i64>,
    #[serde(default)]
    pub required_suite_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordQualityGateOverride {
    pub workflow_id: String,
    pub release_version: String,
    pub reason: String,
    pub gate_snapshot: Value,
    pub evaluation_snapshot: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityGateAuditSummary {
    pub id: String,
    pub release_version: String,
    pub actor: String,
    pub reason: String,
    pub gate_snapshot: Value,
    pub evaluation_snapshot: Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEvaluationSuite {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvaluationSuite {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationSuiteSummary {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    pub description: String,
    pub case_count: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEvaluationCase {
    pub id: String,
    pub suite_id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub position: i64,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub target_agent_id: Option<String>,
    #[serde(default = "empty_json_object")]
    pub input: Value,
    pub expectation: EvaluationExpectation,
    #[serde(default = "empty_json_object")]
    pub fixture: Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvaluationCase {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub enabled: bool,
    pub target_agent_id: Option<String>,
    #[serde(default = "empty_json_object")]
    pub input: Value,
    pub expectation: EvaluationExpectation,
    #[serde(default = "empty_json_object")]
    pub fixture: Value,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCaseSummary {
    pub id: String,
    pub suite_id: String,
    pub name: String,
    pub description: String,
    pub position: i64,
    pub enabled: bool,
    pub archived: bool,
    pub target_agent_id: Option<String>,
    pub input: Value,
    pub expectation: Value,
    pub fixture: Value,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEvaluationRun {
    pub id: String,
    pub suite_id: String,
    pub workflow_id: String,
    pub workflow_snapshot: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationRunSummary {
    pub id: String,
    pub suite_id: String,
    pub workflow_id: String,
    pub retry_of_run_id: Option<String>,
    pub status: String,
    pub total_cases: i64,
    pub started_at: String,
}

/// Durable aggregate for a completed or in-flight Suite execution. Counts and
/// usage are materialized here so the result page never has to infer history
/// from mutable Case definitions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationRunDetail {
    #[serde(flatten)]
    pub summary: EvaluationRunSummary,
    pub ended_at: Option<String>,
    pub duration_ms: Option<i64>,
    pub passed_cases: i64,
    pub failed_cases: i64,
    pub total_tokens: Option<i64>,
    pub estimated_cost_microusd: Option<i64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationVersionSummary {
    pub release_id: Option<String>,
    pub release_version: String,
    pub base_release_version: Option<String>,
    /// Releases compare by version; drafts compare by their immutable snapshot.
    pub comparison_key: String,
    pub run_count: i64,
    pub total_cases: i64,
    pub passed_cases: i64,
    pub total_duration_ms: i64,
    pub estimated_cost_microusd: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationVersionCaseDiff {
    pub case_id: String,
    pub name: String,
    pub baseline_verdict: Option<String>,
    pub candidate_verdict: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCriterionOutcome {
    pub criterion: String,
    pub passed: bool,
    pub score: f64,
    pub threshold: f64,
    pub expected: Value,
    pub actual: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationVersionCriterionDiff {
    pub key: String,
    pub baseline: Option<EvaluationCriterionOutcome>,
    pub candidate: Option<EvaluationCriterionOutcome>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationVersionCaseCriterionComparison {
    pub case_id: String,
    pub name: String,
    pub baseline_verdict: Option<String>,
    pub candidate_verdict: Option<String>,
    pub criteria: Vec<EvaluationVersionCriterionDiff>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedEvaluationCase {
    pub result_id: String,
    pub evaluation_run_id: String,
    pub evaluation_case_id: String,
    pub workflow_id: String,
    pub workflow_snapshot: Value,
    pub case_snapshot: EvaluationCaseSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationCaseResultSummary {
    pub id: String,
    pub evaluation_case_id: String,
    pub workflow_run_id: Option<String>,
    pub execution_status: String,
    pub verdict: String,
    pub score: Option<f64>,
    pub actual_output: Value,
    pub criteria_results: Value,
    pub normalized_trace: Value,
    pub failure_reason: Option<String>,
    pub duration_ms: Option<i64>,
    pub total_tokens: Option<i64>,
    pub estimated_cost_microusd: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EvaluationWorkflowSnapshot {
    target_name: String,
    target_snapshot: Value,
    dsl: Value,
    #[serde(default)]
    release_id: Option<String>,
    #[serde(default)]
    release_version: Option<String>,
}

/// Product storage for evaluation configuration. It deliberately does not read
/// normal user run history; history is only linked after an evaluation executes.
pub struct EvaluationStore;

impl EvaluationStore {
    pub async fn record_quality_gate_override(request: RecordQualityGateOverride) -> Result<()> {
        if request.workflow_id.trim().is_empty()
            || request.release_version.trim().is_empty()
            || request.reason.trim().is_empty()
        {
            bail!("workflow, release version, and override reason are required");
        }
        let pool = DBManager::global().pool()?;
        // Audit payloads are snapshots so later policy edits cannot rewrite why
        // a specific release was allowed through a failed gate.
        sqlx::query("INSERT INTO evaluation_quality_gate_audits (id, workflow_id, release_version, reason, gate_snapshot_json, evaluation_snapshot_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(request.workflow_id).bind(request.release_version).bind(request.reason).bind(request.gate_snapshot.to_string()).bind(request.evaluation_snapshot.to_string()).bind(chrono::Utc::now().to_rfc3339()).execute(&pool).await?;
        Ok(())
    }

    pub async fn list_quality_gate_audits(workflow_id: &str) -> Result<Vec<QualityGateAuditSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, release_version, actor, reason, gate_snapshot_json, evaluation_snapshot_json, created_at FROM evaluation_quality_gate_audits WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 50")
            .bind(workflow_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(QualityGateAuditSummary {
                    id: row.try_get("id")?,
                    release_version: row.try_get("release_version")?,
                    actor: row.try_get("actor")?,
                    reason: row.try_get("reason")?,
                    gate_snapshot: serde_json::from_str(&row.try_get::<String, _>("gate_snapshot_json")?)?,
                    evaluation_snapshot: serde_json::from_str(&row.try_get::<String, _>("evaluation_snapshot_json")?)?,
                    created_at: row.try_get("created_at")?,
                })
            })
            .collect()
    }
    pub async fn get_quality_gate(workflow_id: &str) -> Result<EvaluationQualityGate> {
        let pool = DBManager::global().pool()?;
        let value = sqlx::query("SELECT policy_json FROM evaluation_quality_gates WHERE workflow_id = ?")
            .bind(workflow_id)
            .fetch_optional(&pool)
            .await?
            .map(|row| row.try_get::<String, _>("policy_json"))
            .transpose()?;
        Ok(value
            .map(|json| serde_json::from_str(&json))
            .transpose()?
            .unwrap_or_default())
    }

    pub async fn update_quality_gate(workflow_id: &str, policy: EvaluationQualityGate) -> Result<()> {
        if workflow_id.trim().is_empty() {
            bail!("workflow id is required");
        }
        if policy.min_pass_rate.is_some_and(|value| !(0.0..=1.0).contains(&value)) {
            bail!("minimum pass rate must be between 0 and 1");
        }
        let pool = DBManager::global().pool()?;
        sqlx::query("INSERT INTO evaluation_quality_gates (workflow_id, policy_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(workflow_id) DO UPDATE SET policy_json = excluded.policy_json, updated_at = excluded.updated_at")
            .bind(workflow_id).bind(serde_json::to_string(&policy)?).bind(chrono::Utc::now().to_rfc3339()).execute(&pool).await?;
        Ok(())
    }
    /// Completes the linked Case after Run History is durable. Evaluation
    /// bookkeeping never changes the Workflow Run's terminal status.
    pub async fn complete_workflow_run(workflow_run_id: &str, completed: bool, error: Option<&str>) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let mut result = sqlx::query(
            "SELECT id, evaluation_run_id, case_snapshot_json FROM evaluation_case_results WHERE workflow_run_id = ?",
        )
        .bind(workflow_run_id)
        .fetch_optional(&pool)
        .await?;
        if result.is_none() {
            // The supervisor can finish a trivial workflow between creating
            // its history record and the coordinator's link update. The
            // runtime copy is durable at creation time, so recover that link
            // instead of leaving the Case permanently marked as running.
            let evaluation_result_id = sqlx::query_scalar::<_, Option<String>>(
                "SELECT json_extract(runtime_json, '$.evaluationResultId') FROM run_records WHERE id = ?",
            )
            .bind(workflow_run_id)
            .fetch_optional(&pool)
            .await?
            .flatten();
            if let Some(evaluation_result_id) = evaluation_result_id {
                sqlx::query(
                    "UPDATE evaluation_case_results SET workflow_run_id = ?, updated_at = ? WHERE id = ? AND workflow_run_id IS NULL",
                )
                .bind(workflow_run_id)
                .bind(chrono::Utc::now().to_rfc3339())
                .bind(evaluation_result_id)
                .execute(&pool)
                .await?;
                result = sqlx::query(
                    "SELECT id, evaluation_run_id, case_snapshot_json FROM evaluation_case_results WHERE workflow_run_id = ?",
                )
                .bind(workflow_run_id)
                .fetch_optional(&pool)
                .await?;
            }
        }
        let Some(result) = result else {
            return Ok(());
        };
        let result_id: String = result.try_get("id")?;
        let evaluation_run_id: String = result.try_get("evaluation_run_id")?;
        let evaluation_status: String = sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = ?")
            .bind(&evaluation_run_id)
            .fetch_one(&pool)
            .await?;
        if evaluation_status == "cancelled" {
            // A cancellation can race a workflow's final event. Preserve the
            // user's batch-level decision instead of scoring late output.
            sqlx::query("UPDATE evaluation_case_results SET execution_status = 'cancelled', verdict = 'skipped', failure_reason = ?, updated_at = ? WHERE id = ?")
                .bind("Evaluation batch was cancelled.")
                .bind(chrono::Utc::now().to_rfc3339())
                .bind(result_id)
                .execute(&pool)
                .await?;
            return Ok(());
        }
        let case: EvaluationCaseSummary = serde_json::from_str(&result.try_get::<String, _>("case_snapshot_json")?)?;
        let events = sqlx::query("SELECT event_json FROM run_events WHERE run_id = ? ORDER BY sequence ASC")
            .bind(workflow_run_id)
            .fetch_all(&pool)
            .await?;
        let event_values = events
            .into_iter()
            .filter_map(|row| serde_json::from_str::<Value>(&row.try_get::<String, _>("event_json").ok()?).ok())
            .collect::<Vec<_>>();
        let state = event_values
            .iter()
            .rev()
            .find_map(|event| event.get("state").cloned())
            .unwrap_or_else(|| json!({}));
        let metrics = workflow_run_metrics(&pool, workflow_run_id).await?;
        let (execution_status, verdict, score_value, criteria, trace, output, reason) = if completed {
            let expectation: EvaluationExpectation = serde_json::from_value(case.expectation)?;
            let score = score(&expectation, observe_workflow_output(&state, &event_values))?;
            let verdict = if score.passed { "passed" } else { "failed" };
            let score_value = score.criteria.iter().map(|item| item.score).sum::<f64>() / score.criteria.len() as f64;
            (
                "completed",
                verdict,
                Some(score_value),
                serde_json::to_value(score.criteria)?,
                serde_json::to_value(&score.observation)?,
                json!({ "text": score.observation.final_output }),
                None,
            )
        } else {
            (
                "failed",
                "error",
                None,
                json!([]),
                json!({}),
                json!({}),
                error.map(str::to_string),
            )
        };
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query("UPDATE evaluation_case_results SET execution_status = ?, verdict = ?, score = ?, criteria_results_json = ?, normalized_trace_json = ?, actual_output_json = ?, failure_reason = ?, duration_ms = ?, total_tokens = ?, estimated_cost_microusd = ?, updated_at = ? WHERE id = ?")
            .bind(execution_status).bind(verdict).bind(score_value).bind(criteria.to_string()).bind(trace.to_string()).bind(output.to_string()).bind(reason).bind(metrics.duration_ms).bind(metrics.total_tokens).bind(metrics.estimated_cost_microusd).bind(&now).bind(result_id)
            .execute(&pool).await?;
        refresh_run_aggregate(&pool, &evaluation_run_id, &now).await?;
        // Evaluation batches are native-owned. Once a workflow becomes
        // terminal, launch the next durable Case even if the editor is closed.
        Self::start_next_case(&evaluation_run_id).await?;
        Ok(())
    }

    pub async fn create_suite(request: CreateEvaluationSuite) -> Result<EvaluationSuiteSummary> {
        validate_suite(&request)?;
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO evaluation_suites (id, workflow_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.workflow_id)
        .bind(&request.name)
        .bind(&request.description)
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await?;
        Ok(EvaluationSuiteSummary {
            id: request.id,
            workflow_id: request.workflow_id,
            name: request.name,
            description: request.description,
            case_count: 0,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub async fn list_suites(workflow_id: &str) -> Result<Vec<EvaluationSuiteSummary>> {
        if workflow_id.trim().is_empty() {
            bail!("workflow id is required");
        }
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query(
            "SELECT suites.id, suites.workflow_id, suites.name, suites.description, suites.created_at, suites.updated_at, COUNT(cases.id) AS case_count FROM evaluation_suites AS suites LEFT JOIN evaluation_cases AS cases ON cases.suite_id = suites.id AND cases.deleted_at IS NULL WHERE suites.workflow_id = ? GROUP BY suites.id ORDER BY suites.name COLLATE NOCASE ASC, suites.id ASC",
        )
        .bind(workflow_id)
        .fetch_all(&pool)
        .await?;
        rows.into_iter().map(suite_from_row).collect()
    }

    pub async fn update_suite(request: UpdateEvaluationSuite) -> Result<EvaluationSuiteSummary> {
        if request.id.trim().is_empty() || request.name.trim().is_empty() {
            bail!("suite id and name are required");
        }
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        let updated =
            sqlx::query("UPDATE evaluation_suites SET name = ?, description = ?, updated_at = ? WHERE id = ?")
                .bind(&request.name)
                .bind(&request.description)
                .bind(&now)
                .bind(&request.id)
                .execute(&pool)
                .await?;
        if updated.rows_affected() == 0 {
            bail!("evaluation suite was not found");
        }
        let row = sqlx::query("SELECT suites.id, suites.workflow_id, suites.name, suites.description, suites.created_at, suites.updated_at, COUNT(cases.id) AS case_count FROM evaluation_suites AS suites LEFT JOIN evaluation_cases AS cases ON cases.suite_id = suites.id AND cases.deleted_at IS NULL WHERE suites.id = ? GROUP BY suites.id")
            .bind(&request.id).fetch_one(&pool).await?;
        suite_from_row(row)
    }

    /// Deleting a Suite intentionally removes its evaluation evidence, but
    /// preserves the linked Workflow Run history for independent inspection.
    pub async fn delete_suite(id: &str) -> Result<()> {
        if id.trim().is_empty() {
            bail!("suite id is required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        let exists = sqlx::query("SELECT 1 FROM evaluation_suites WHERE id = ?")
            .bind(id)
            .fetch_optional(&mut *transaction)
            .await?;
        if exists.is_none() {
            bail!("evaluation suite was not found");
        }
        // Runs cascade to Case Results, releasing the Case foreign-key guard.
        sqlx::query("DELETE FROM evaluation_runs WHERE suite_id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM evaluation_cases WHERE suite_id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("DELETE FROM evaluation_suites WHERE id = ?")
            .bind(id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn create_case(request: CreateEvaluationCase) -> Result<EvaluationCaseSummary> {
        validate_case(&request)?;
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO evaluation_cases (id, suite_id, name, description, position, enabled, target_agent_id, input_json, expectation_json, fixture_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.suite_id)
        .bind(&request.name)
        .bind(&request.description)
        // Deleted Cases retain their old positions for history, so allocate the
        // next active position instead of trusting a stale client-side count.
        .bind(sqlx::query_scalar::<_, i64>("SELECT COALESCE(MAX(position), -1) + 1 FROM evaluation_cases WHERE suite_id = ? AND deleted_at IS NULL").bind(&request.suite_id).fetch_one(&pool).await?)
        .bind(request.enabled)
        .bind(&request.target_agent_id)
        .bind(request.input.to_string())
        .bind(serde_json::to_string(&request.expectation)?)
        .bind(request.fixture.to_string())
        .bind(&now)
        .bind(&now)
        .execute(&pool)
        .await?;
        let created_position = sqlx::query_scalar::<_, i64>("SELECT position FROM evaluation_cases WHERE id = ?")
            .bind(&request.id)
            .fetch_one(&pool)
            .await?;
        Ok(EvaluationCaseSummary {
            id: request.id,
            suite_id: request.suite_id,
            name: request.name,
            description: request.description,
            position: created_position,
            enabled: request.enabled,
            archived: false,
            target_agent_id: request.target_agent_id,
            input: request.input,
            expectation: serde_json::to_value(request.expectation)?,
            fixture: request.fixture,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub async fn list_cases(suite_id: &str, include_archived: bool) -> Result<Vec<EvaluationCaseSummary>> {
        if suite_id.trim().is_empty() {
            bail!("suite id is required");
        }
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query(
            "SELECT id, suite_id, name, description, position, enabled, target_agent_id, input_json, expectation_json, fixture_json, deleted_at, created_at, updated_at FROM evaluation_cases WHERE suite_id = ? AND (? OR deleted_at IS NULL) ORDER BY deleted_at IS NOT NULL ASC, position ASC, id ASC",
        )
        .bind(suite_id).bind(include_archived)
        .fetch_all(&pool)
        .await?;
        rows.into_iter().map(case_from_row).collect()
    }

    pub async fn update_case(request: UpdateEvaluationCase) -> Result<EvaluationCaseSummary> {
        if request.id.trim().is_empty() || request.name.trim().is_empty() {
            bail!("case id and name are required");
        }
        request.expectation.validate()?;
        let pool = DBManager::global().pool()?;
        let now = chrono::Utc::now().to_rfc3339();
        let updated = sqlx::query("UPDATE evaluation_cases SET name = ?, description = ?, enabled = ?, target_agent_id = ?, input_json = ?, expectation_json = ?, fixture_json = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(&request.name).bind(&request.description).bind(request.enabled).bind(&request.target_agent_id).bind(request.input.to_string()).bind(serde_json::to_string(&request.expectation)?).bind(request.fixture.to_string()).bind(&now).bind(&request.id)
            .execute(&pool).await?;
        if updated.rows_affected() == 0 {
            bail!("evaluation case was not found");
        }
        let row = sqlx::query("SELECT id, suite_id, name, description, position, enabled, target_agent_id, input_json, expectation_json, fixture_json, deleted_at, created_at, updated_at FROM evaluation_cases WHERE id = ?")
            .bind(&request.id).fetch_one(&pool).await?;
        case_from_row(row)
    }

    pub async fn delete_case(id: &str) -> Result<()> {
        if id.trim().is_empty() {
            bail!("case id is required");
        }
        let pool = DBManager::global().pool()?;
        let deleted = sqlx::query("UPDATE evaluation_cases SET deleted_at = ?, enabled = 0, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
            .bind(chrono::Utc::now().to_rfc3339()).bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await?;
        if deleted.rows_affected() == 0 {
            bail!("evaluation case was not found");
        }
        Ok(())
    }

    pub async fn restore_case(id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        let restored = sqlx::query("UPDATE evaluation_cases SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ? AND deleted_at IS NOT NULL")
            .bind(chrono::Utc::now().to_rfc3339()).bind(id).execute(&pool).await?;
        if restored.rows_affected() == 0 {
            bail!("archived evaluation case was not found");
        }
        Ok(())
    }

    pub async fn reorder_cases(suite_id: &str, ids: &[String]) -> Result<()> {
        if suite_id.trim().is_empty() {
            bail!("suite id is required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        let existing = sqlx::query(
            "SELECT id FROM evaluation_cases WHERE suite_id = ? AND deleted_at IS NULL ORDER BY position, id",
        )
        .bind(suite_id)
        .fetch_all(&mut *transaction)
        .await?
        .into_iter()
        .map(|row| row.try_get::<String, _>("id"))
        .collect::<Result<Vec<_>, _>>()?;
        let mut expected = existing.clone();
        let mut received = ids.to_vec();
        expected.sort();
        received.sort();
        if expected != received {
            bail!("case order must contain every case in the suite exactly once");
        }
        // Move positions out of the unique range first so swapping adjacent
        // Cases never conflicts with `UNIQUE(suite_id, position)`.
        sqlx::query("UPDATE evaluation_cases SET position = -position - 1 WHERE suite_id = ? AND deleted_at IS NULL")
            .bind(suite_id)
            .execute(&mut *transaction)
            .await?;
        for (position, id) in ids.iter().enumerate() {
            sqlx::query("UPDATE evaluation_cases SET position = ?, updated_at = ? WHERE id = ?")
                .bind(position as i64)
                .bind(chrono::Utc::now().to_rfc3339())
                .bind(id)
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await?;
        Ok(())
    }

    /// Creates immutable records before any Case starts. Later Case edits must
    /// not alter the evidence or fixtures used by this Evaluation Run.
    pub async fn create_run(request: CreateEvaluationRun) -> Result<EvaluationRunSummary> {
        if request.id.trim().is_empty() || request.suite_id.trim().is_empty() || request.workflow_id.trim().is_empty() {
            bail!("evaluation run id, suite id, and workflow id are required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        let suite = sqlx::query("SELECT id, workflow_id, name, description FROM evaluation_suites WHERE id = ?")
            .bind(&request.suite_id)
            .fetch_optional(&mut *transaction)
            .await?
            .context("evaluation suite was not found")?;
        let suite_workflow_id: String = suite.try_get("workflow_id")?;
        if suite_workflow_id != request.workflow_id {
            bail!("evaluation suite does not belong to the requested workflow");
        }
        let cases = sqlx::query(
            "SELECT id, suite_id, name, description, position, enabled, target_agent_id, input_json, expectation_json, fixture_json, deleted_at, created_at, updated_at FROM evaluation_cases WHERE suite_id = ? AND enabled = 1 AND deleted_at IS NULL ORDER BY position ASC, id ASC",
        )
        .bind(&request.suite_id)
        .fetch_all(&mut *transaction)
        .await?;
        if cases.is_empty() {
            bail!("evaluation suite has no enabled cases");
        }
        let cases = cases.into_iter().map(case_from_row).collect::<Result<Vec<_>>>()?;
        let now = chrono::Utc::now().to_rfc3339();
        let suite_snapshot = json!({
            "id": suite.try_get::<String, _>("id")?,
            "workflowId": suite_workflow_id,
            "name": suite.try_get::<String, _>("name")?,
            "description": suite.try_get::<String, _>("description")?,
        });
        let workflow_fingerprint = workflow_snapshot_fingerprint(&request.workflow_snapshot);
        sqlx::query(
            "INSERT INTO evaluation_runs (id, suite_id, workflow_id, status, workflow_snapshot_json, workflow_fingerprint, suite_snapshot_json, execution_profile_json, started_at, total_cases, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&request.id)
        .bind(&request.suite_id)
        .bind(&request.workflow_id)
        .bind(request.workflow_snapshot.to_string())
        .bind(workflow_fingerprint)
        .bind(suite_snapshot.to_string())
        .bind(json!({ "mode": "evaluation", "fixturePolicy": "exact_match_only" }).to_string())
        .bind(&now)
        .bind(cases.len() as i64)
        .bind(&now)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
        for case in &cases {
            sqlx::query(
                "INSERT INTO evaluation_case_results (id, evaluation_run_id, evaluation_case_id, case_snapshot_json, execution_status, verdict, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?)",
            )
            .bind(uuid::Uuid::new_v4().to_string())
            .bind(&request.id)
            .bind(&case.id)
            .bind(serde_json::to_string(case)?)
            .bind(&now)
            .bind(&now)
            .execute(&mut *transaction)
            .await?;
        }
        transaction.commit().await?;
        let summary = EvaluationRunSummary {
            id: request.id,
            suite_id: request.suite_id,
            workflow_id: request.workflow_id,
            retry_of_run_id: None,
            status: "queued".to_string(),
            total_cases: cases.len() as i64,
            started_at: now,
        };
        // The batch exists before execution begins, so closing the editor
        // cannot strand a newly created evaluation in the queued state.
        Self::start_next_case(&summary.id).await?;
        Ok(summary)
    }

    /// Starts a fresh batch from immutable evidence, rather than from today's
    /// Case definitions. That keeps a retry attributable to the same inputs
    /// that produced the original failure.
    pub async fn retry_failed_cases(source_run_id: &str, id: String) -> Result<EvaluationRunSummary> {
        if source_run_id.trim().is_empty() || id.trim().is_empty() {
            bail!("source evaluation run id and retry run id are required");
        }
        let pool = DBManager::global().pool()?;
        let summary = retry_failed_cases_in_pool(&pool, source_run_id, id).await?;
        Self::start_next_case(&summary.id).await?;
        Ok(summary)
    }

    pub async fn claim_next_case(evaluation_run_id: &str) -> Result<Option<ClaimedEvaluationCase>> {
        if evaluation_run_id.trim().is_empty() {
            bail!("evaluation run id is required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        let run = sqlx::query(
            "SELECT workflow_id, workflow_snapshot_json FROM evaluation_runs WHERE id = ? AND status IN ('queued', 'running')",
        )
        .bind(evaluation_run_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(run) = run else {
            transaction.commit().await?;
            return Ok(None);
        };
        let result = sqlx::query(
            "SELECT id, evaluation_case_id, case_snapshot_json FROM evaluation_case_results WHERE evaluation_run_id = ? AND execution_status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1",
        )
        .bind(evaluation_run_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(result) = result else {
            transaction.commit().await?;
            return Ok(None);
        };
        let now = chrono::Utc::now().to_rfc3339();
        let result_id: String = result.try_get("id")?;
        let updated = sqlx::query(
            "UPDATE evaluation_case_results SET execution_status = 'running', updated_at = ? WHERE id = ? AND execution_status = 'queued'",
        )
        .bind(&now)
        .bind(&result_id)
        .execute(&mut *transaction)
        .await?;
        if updated.rows_affected() == 0 {
            transaction.commit().await?;
            return Ok(None);
        }
        sqlx::query("UPDATE evaluation_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'")
            .bind(&now)
            .bind(evaluation_run_id)
            .execute(&mut *transaction)
            .await?;
        let claimed = ClaimedEvaluationCase {
            result_id,
            evaluation_run_id: evaluation_run_id.to_string(),
            evaluation_case_id: result.try_get("evaluation_case_id")?,
            workflow_id: run.try_get("workflow_id")?,
            workflow_snapshot: serde_json::from_str(&run.try_get::<String, _>("workflow_snapshot_json")?)?,
            case_snapshot: serde_json::from_str(&result.try_get::<String, _>("case_snapshot_json")?)?,
        };
        transaction.commit().await?;
        Ok(Some(claimed))
    }

    pub async fn start_next_case(evaluation_run_id: &str) -> Result<Option<ClaimedEvaluationCase>> {
        // Claiming is durable so two coordinators cannot run the same case. A
        // malformed historical fixture must therefore become a Case error,
        // rather than leaving the claimed Case running forever.
        loop {
            let Some(claimed) = Self::claim_next_case(evaluation_run_id).await? else {
                return Ok(None);
            };
            match Self::start_claimed_case(&claimed).await {
                Ok(()) => return Ok(Some(claimed)),
                Err(error) => {
                    let message = error.to_string();
                    log::warn!(
                        "failed to start evaluation case {}: {message:#}",
                        claimed.evaluation_case_id
                    );
                    Self::fail_case_start(&claimed, &message).await?;
                },
            }
        }
    }

    pub async fn cancel_run(evaluation_run_id: &str) -> Result<()> {
        if evaluation_run_id.trim().is_empty() {
            bail!("evaluation run id is required");
        }
        let pool = DBManager::global().pool()?;
        let workflow_run_ids = cancel_run_in_pool(&pool, evaluation_run_id).await?;
        for workflow_run_id in workflow_run_ids {
            // Cancellation is asynchronous for an active graph. The terminal
            // callback observes the cancelled Evaluation status above, so a
            // late event cannot revive this batch or start another Case.
            if let Err(error) = run_manager::cancel_waiting_workflow(&workflow_run_id).await {
                log::warn!("failed to cancel evaluation workflow run {workflow_run_id}: {error:#}");
            }
        }
        Ok(())
    }

    async fn start_claimed_case(claimed: &ClaimedEvaluationCase) -> Result<()> {
        let snapshot: EvaluationWorkflowSnapshot = serde_json::from_value(claimed.workflow_snapshot.clone())
            .context("evaluation workflow snapshot is invalid")?;
        if snapshot.target_name.trim().is_empty() {
            bail!("evaluation workflow snapshot needs targetName");
        }
        let profile: EvaluationExecutionProfile = serde_json::from_value(claimed.case_snapshot.fixture.clone())
            .context("evaluation case fixture is invalid")?;
        let workflow_run_id = uuid::Uuid::new_v4().to_string();
        run_manager::start_workflow(StartWorkflowRun {
            run_id: workflow_run_id.clone(),
            target_id: claimed.workflow_id.clone(),
            target_name: snapshot.target_name,
            input: claimed.case_snapshot.input.clone(),
            output_view: json!({}),
            target_snapshot: snapshot.target_snapshot,
            release_id: snapshot.release_id,
            release_version: snapshot.release_version,
            dsl: snapshot.dsl,
            initial_state: claimed.case_snapshot.input.clone(),
            thread_id: format!(
                "evaluation/{}/{}",
                claimed.evaluation_run_id, claimed.evaluation_case_id
            ),
            evaluation_profile: Some(profile),
            evaluation_result_id: Some(claimed.result_id.clone()),
        })
        .await?;
        let pool = DBManager::global().pool()?;
        sqlx::query("UPDATE evaluation_case_results SET workflow_run_id = ?, updated_at = ? WHERE id = ?")
            .bind(workflow_run_id)
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&claimed.result_id)
            .execute(&pool)
            .await?;
        Ok(())
    }

    async fn fail_case_start(claimed: &ClaimedEvaluationCase, reason: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        fail_case_start_in_pool(&pool, &claimed.evaluation_run_id, &claimed.result_id, reason).await
    }

    pub async fn list_case_results(evaluation_run_id: &str) -> Result<Vec<EvaluationCaseResultSummary>> {
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, evaluation_case_id, workflow_run_id, execution_status, verdict, score, actual_output_json, criteria_results_json, normalized_trace_json, failure_reason, duration_ms, total_tokens, estimated_cost_microusd FROM evaluation_case_results WHERE evaluation_run_id = ? ORDER BY created_at ASC, id ASC")
            .bind(evaluation_run_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(EvaluationCaseResultSummary {
                    id: row.try_get("id")?,
                    evaluation_case_id: row.try_get("evaluation_case_id")?,
                    workflow_run_id: row.try_get("workflow_run_id")?,
                    execution_status: row.try_get("execution_status")?,
                    verdict: row.try_get("verdict")?,
                    score: row.try_get("score")?,
                    actual_output: serde_json::from_str(&row.try_get::<String, _>("actual_output_json")?)?,
                    criteria_results: serde_json::from_str(&row.try_get::<String, _>("criteria_results_json")?)?,
                    normalized_trace: serde_json::from_str(&row.try_get::<String, _>("normalized_trace_json")?)?,
                    failure_reason: row.try_get("failure_reason")?,
                    duration_ms: row.try_get("duration_ms")?,
                    total_tokens: row.try_get("total_tokens")?,
                    estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
                })
            })
            .collect()
    }

    pub async fn inspect_run(evaluation_run_id: &str) -> Result<EvaluationRunDetail> {
        if evaluation_run_id.trim().is_empty() {
            bail!("evaluation run id is required");
        }
        let pool = DBManager::global().pool()?;
        let row = sqlx::query("SELECT id, suite_id, workflow_id, retry_of_run_id, status, total_cases, started_at, ended_at, duration_ms, passed_cases, failed_cases, total_tokens, estimated_cost_microusd, error FROM evaluation_runs WHERE id = ?")
            .bind(evaluation_run_id)
            .fetch_optional(&pool)
            .await?
            .context("evaluation run was not found")?;
        Ok(EvaluationRunDetail {
            summary: EvaluationRunSummary {
                id: row.try_get("id")?,
                suite_id: row.try_get("suite_id")?,
                workflow_id: row.try_get("workflow_id")?,
                retry_of_run_id: row.try_get("retry_of_run_id")?,
                status: row.try_get("status")?,
                total_cases: row.try_get("total_cases")?,
                started_at: row.try_get("started_at")?,
            },
            ended_at: row.try_get("ended_at")?,
            duration_ms: row.try_get("duration_ms")?,
            passed_cases: row.try_get("passed_cases")?,
            failed_cases: row.try_get("failed_cases")?,
            total_tokens: row.try_get("total_tokens")?,
            estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
            error: row.try_get("error")?,
        })
    }

    pub async fn list_runs(suite_id: &str) -> Result<Vec<EvaluationRunDetail>> {
        if suite_id.trim().is_empty() {
            bail!("suite id is required");
        }
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, suite_id, workflow_id, retry_of_run_id, status, total_cases, started_at, ended_at, duration_ms, passed_cases, failed_cases, total_tokens, estimated_cost_microusd, error FROM evaluation_runs WHERE suite_id = ? ORDER BY started_at DESC, id DESC LIMIT 30")
            .bind(suite_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(EvaluationRunDetail {
                    summary: EvaluationRunSummary {
                        id: row.try_get("id")?,
                        suite_id: row.try_get("suite_id")?,
                        workflow_id: row.try_get("workflow_id")?,
                        retry_of_run_id: row.try_get("retry_of_run_id")?,
                        status: row.try_get("status")?,
                        total_cases: row.try_get("total_cases")?,
                        started_at: row.try_get("started_at")?,
                    },
                    ended_at: row.try_get("ended_at")?,
                    duration_ms: row.try_get("duration_ms")?,
                    passed_cases: row.try_get("passed_cases")?,
                    failed_cases: row.try_get("failed_cases")?,
                    total_tokens: row.try_get("total_tokens")?,
                    estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
                    error: row.try_get("error")?,
                })
            })
            .collect()
    }

    pub async fn summarize_versions(suite_id: &str) -> Result<Vec<EvaluationVersionSummary>> {
        if suite_id.trim().is_empty() {
            bail!("suite id is required");
        }
        let pool = DBManager::global().pool()?;
        // Draft snapshots predate releases, so they deliberately form a
        // separate comparable cohort instead of being attributed to a release.
        let rows = sqlx::query("SELECT json_extract(workflow_snapshot_json, '$.releaseId') AS release_id, COALESCE(json_extract(workflow_snapshot_json, '$.releaseVersion'), 'draft') AS release_version, json_extract(workflow_snapshot_json, '$.baseReleaseVersion') AS base_release_version, workflow_fingerprint, COUNT(*) AS run_count, SUM(total_cases) AS total_cases, SUM(passed_cases) AS passed_cases, SUM(COALESCE(duration_ms, 0)) AS total_duration_ms, SUM(COALESCE(estimated_cost_microusd, 0)) AS estimated_cost_microusd FROM evaluation_runs WHERE suite_id = ? AND retry_of_run_id IS NULL GROUP BY release_id, release_version, base_release_version, workflow_fingerprint ORDER BY MAX(started_at) DESC")
            .bind(suite_id).fetch_all(&pool).await?;
        rows.into_iter()
            .map(|row| {
                Ok(EvaluationVersionSummary {
                    release_id: row.try_get("release_id")?,
                    release_version: row.try_get("release_version")?,
                    base_release_version: row.try_get("base_release_version")?,
                    comparison_key: {
                        let release_id: Option<String> = row.try_get("release_id")?;
                        if release_id.is_some() {
                            row.try_get("release_version")?
                        } else {
                            row.try_get("workflow_fingerprint")?
                        }
                    },
                    run_count: row.try_get("run_count")?,
                    total_cases: row.try_get("total_cases")?,
                    passed_cases: row.try_get("passed_cases")?,
                    total_duration_ms: row.try_get("total_duration_ms")?,
                    estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
                })
            })
            .collect()
    }

    pub async fn compare_versions(
        suite_id: &str,
        baseline: &str,
        candidate: &str,
    ) -> Result<Vec<EvaluationVersionCaseDiff>> {
        let pool = DBManager::global().pool()?;
        let latest_sql = "SELECT id FROM evaluation_runs WHERE suite_id = ? AND retry_of_run_id IS NULL AND (workflow_fingerprint = ? OR (json_extract(workflow_snapshot_json, '$.releaseId') IS NOT NULL AND COALESCE(json_extract(workflow_snapshot_json, '$.releaseVersion'), 'draft') = ?)) ORDER BY started_at DESC, id DESC LIMIT 1";
        let baseline_run = sqlx::query_scalar::<_, String>(latest_sql)
            .bind(suite_id)
            .bind(baseline)
            .bind(baseline)
            .fetch_optional(&pool)
            .await?;
        let candidate_run = sqlx::query_scalar::<_, String>(latest_sql)
            .bind(suite_id)
            .bind(candidate)
            .bind(candidate)
            .fetch_optional(&pool)
            .await?;
        let read_cases = |run_id: Option<String>| async {
            let Some(run_id) = run_id else {
                return Ok::<HashMap<String, (String, String)>, sqlx::Error>(HashMap::new());
            };
            let rows = sqlx::query("SELECT evaluation_case_id, case_snapshot_json, verdict FROM evaluation_case_results WHERE evaluation_run_id = ?")
                .bind(run_id).fetch_all(&pool).await?;
            Ok(rows
                .into_iter()
                .map(|row| {
                    let id: String = row.try_get("evaluation_case_id")?;
                    let snapshot: Value =
                        serde_json::from_str(&row.try_get::<String, _>("case_snapshot_json")?).unwrap_or_default();
                    Ok((
                        id,
                        (
                            snapshot
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("评测用例")
                                .to_string(),
                            row.try_get("verdict")?,
                        ),
                    ))
                })
                .collect::<Result<HashMap<_, _>, sqlx::Error>>()?)
        };
        let before = read_cases(baseline_run).await?;
        let after = read_cases(candidate_run).await?;
        let ids: HashSet<_> = before.keys().chain(after.keys()).cloned().collect();
        Ok(ids
            .into_iter()
            .filter_map(|id| {
                let base = before.get(&id);
                let next = after.get(&id);
                let failed = |value: Option<&(String, String)>| {
                    value.is_some_and(|(_, verdict)| matches!(verdict.as_str(), "failed" | "error"))
                };
                let kind = match (base, next) {
                    (None, Some(_)) => "added",
                    (Some(_), None) => "removed",
                    _ if !failed(base) && failed(next) => "regressed",
                    _ if failed(base) && !failed(next) => "fixed",
                    _ if failed(base) && failed(next) => "persistent_failure",
                    _ => return None,
                };
                Some(EvaluationVersionCaseDiff {
                    case_id: id,
                    name: next.or(base).map(|value| value.0.clone()).unwrap_or_default(),
                    baseline_verdict: base.map(|value| value.1.clone()),
                    candidate_verdict: next.map(|value| value.1.clone()),
                    kind: kind.to_string(),
                })
            })
            .collect())
    }

    pub async fn compare_version_case_criteria(
        suite_id: &str,
        baseline: &str,
        candidate: &str,
        case_id: &str,
    ) -> Result<EvaluationVersionCaseCriterionComparison> {
        let pool = DBManager::global().pool()?;
        let latest_sql = "SELECT id FROM evaluation_runs WHERE suite_id = ? AND retry_of_run_id IS NULL AND (workflow_fingerprint = ? OR (json_extract(workflow_snapshot_json, '$.releaseId') IS NOT NULL AND COALESCE(json_extract(workflow_snapshot_json, '$.releaseVersion'), 'draft') = ?)) ORDER BY started_at DESC, id DESC LIMIT 1";
        let baseline_run = sqlx::query_scalar::<_, String>(latest_sql)
            .bind(suite_id)
            .bind(baseline)
            .bind(baseline)
            .fetch_optional(&pool)
            .await?;
        let candidate_run = sqlx::query_scalar::<_, String>(latest_sql)
            .bind(suite_id)
            .bind(candidate)
            .bind(candidate)
            .fetch_optional(&pool)
            .await?;
        let read_result = |run_id: Option<String>| async {
            let Some(run_id) = run_id else {
                return Ok::<Option<(String, String, Vec<CriterionResult>)>, sqlx::Error>(None);
            };
            let row = sqlx::query("SELECT case_snapshot_json, verdict, criteria_results_json FROM evaluation_case_results WHERE evaluation_run_id = ? AND evaluation_case_id = ? LIMIT 1")
                .bind(run_id).bind(case_id).fetch_optional(&pool).await?;
            row.map(|row| {
                let snapshot: Value =
                    serde_json::from_str(&row.try_get::<String, _>("case_snapshot_json")?).unwrap_or_default();
                let criteria =
                    serde_json::from_str(&row.try_get::<String, _>("criteria_results_json")?).unwrap_or_default();
                Ok((
                    snapshot
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("评测用例")
                        .to_string(),
                    row.try_get("verdict")?,
                    criteria,
                ))
            })
            .transpose()
        };
        let before = read_result(baseline_run).await?;
        let after = read_result(candidate_run).await?;
        let name = after
            .as_ref()
            .or(before.as_ref())
            .map(|result| result.0.clone())
            .unwrap_or_default();
        let criteria = compare_criteria(
            before.as_ref().map(|result| result.2.as_slice()).unwrap_or_default(),
            after.as_ref().map(|result| result.2.as_slice()).unwrap_or_default(),
        );
        Ok(EvaluationVersionCaseCriterionComparison {
            case_id: case_id.to_string(),
            name,
            baseline_verdict: before.map(|result| result.1),
            candidate_verdict: after.map(|result| result.1),
            criteria,
        })
    }

    pub async fn latest_run_for_workflow(workflow_id: &str) -> Result<Option<EvaluationRunDetail>> {
        if workflow_id.trim().is_empty() {
            bail!("workflow id is required");
        }
        let pool = DBManager::global().pool()?;
        let row = sqlx::query("SELECT id, suite_id, workflow_id, retry_of_run_id, status, total_cases, started_at, ended_at, duration_ms, passed_cases, failed_cases, total_tokens, estimated_cost_microusd, error FROM evaluation_runs WHERE workflow_id = ? ORDER BY started_at DESC, id DESC LIMIT 1")
            .bind(workflow_id).fetch_optional(&pool).await?;
        row.map(|row| {
            Ok(EvaluationRunDetail {
                summary: EvaluationRunSummary {
                    id: row.try_get("id")?,
                    suite_id: row.try_get("suite_id")?,
                    workflow_id: row.try_get("workflow_id")?,
                    retry_of_run_id: row.try_get("retry_of_run_id")?,
                    status: row.try_get("status")?,
                    total_cases: row.try_get("total_cases")?,
                    started_at: row.try_get("started_at")?,
                },
                ended_at: row.try_get("ended_at")?,
                duration_ms: row.try_get("duration_ms")?,
                passed_cases: row.try_get("passed_cases")?,
                failed_cases: row.try_get("failed_cases")?,
                total_tokens: row.try_get("total_tokens")?,
                estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
                error: row.try_get("error")?,
            })
        })
        .transpose()
    }

    /// Returns the newest full run for each Suite that evaluated this exact draft.
    /// Keeping one run per Suite makes required-suite quality gates independent
    /// of which Suite happened to finish most recently.
    pub async fn latest_runs_for_workflow_snapshot(
        workflow_id: &str,
        workflow_snapshot: &Value,
    ) -> Result<Vec<EvaluationRunDetail>> {
        if workflow_id.trim().is_empty() {
            bail!("workflow id is required");
        }
        let pool = DBManager::global().pool()?;
        let rows = sqlx::query("SELECT id, suite_id, workflow_id, retry_of_run_id, status, total_cases, started_at, ended_at, duration_ms, passed_cases, failed_cases, total_tokens, estimated_cost_microusd, error FROM evaluation_runs WHERE workflow_id = ? AND workflow_fingerprint = ? AND retry_of_run_id IS NULL ORDER BY started_at DESC, id DESC")
            .bind(workflow_id)
            .bind(workflow_snapshot_fingerprint(workflow_snapshot))
            .fetch_all(&pool)
            .await?;
        let mut seen_suites = HashSet::new();
        let mut runs = Vec::new();
        for row in rows {
            let suite_id: String = row.try_get("suite_id")?;
            if !seen_suites.insert(suite_id.clone()) {
                continue;
            }
            runs.push(EvaluationRunDetail {
                summary: EvaluationRunSummary {
                    id: row.try_get("id")?,
                    suite_id: row.try_get("suite_id")?,
                    workflow_id: row.try_get("workflow_id")?,
                    retry_of_run_id: row.try_get("retry_of_run_id")?,
                    status: row.try_get("status")?,
                    total_cases: row.try_get("total_cases")?,
                    started_at: row.try_get("started_at")?,
                },
                ended_at: row.try_get("ended_at")?,
                duration_ms: row.try_get("duration_ms")?,
                passed_cases: row.try_get("passed_cases")?,
                failed_cases: row.try_get("failed_cases")?,
                total_tokens: row.try_get("total_tokens")?,
                estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
                error: row.try_get("error")?,
            });
        }
        Ok(runs)
    }
}

#[derive(Default)]
struct WorkflowRunMetrics {
    duration_ms: Option<i64>,
    total_tokens: Option<i64>,
    estimated_cost_microusd: Option<i64>,
}

async fn workflow_run_metrics(pool: &sqlx::SqlitePool, workflow_run_id: &str) -> Result<WorkflowRunMetrics> {
    let row = sqlx::query(
        "SELECT duration_ms, (SELECT SUM(CASE WHEN total_tokens IS NOT NULL THEN total_tokens WHEN input_tokens IS NOT NULL OR output_tokens IS NOT NULL THEN COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0) END) FROM run_spans WHERE run_id = run_records.id AND kind = 'model_call') AS total_tokens, (SELECT SUM(estimated_cost_microusd) FROM run_spans WHERE run_id = run_records.id AND kind = 'model_call') AS estimated_cost_microusd FROM run_records WHERE id = ?",
    )
    .bind(workflow_run_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else {
        return Ok(WorkflowRunMetrics::default());
    };
    Ok(WorkflowRunMetrics {
        duration_ms: row.try_get("duration_ms")?,
        total_tokens: row.try_get("total_tokens")?,
        estimated_cost_microusd: row.try_get("estimated_cost_microusd")?,
    })
}

async fn refresh_run_aggregate(pool: &sqlx::SqlitePool, evaluation_run_id: &str, now: &str) -> Result<()> {
    let row = sqlx::query(
        "SELECT started_at, total_cases, (SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id AND verdict != 'pending') AS completed_cases, (SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id AND verdict = 'passed') AS passed_cases, (SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id AND verdict IN ('failed', 'error')) AS failed_cases, (SELECT SUM(total_tokens) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id) AS total_tokens, (SELECT SUM(estimated_cost_microusd) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id) AS estimated_cost_microusd FROM evaluation_runs WHERE id = ?",
    )
    .bind(evaluation_run_id)
    .fetch_one(pool)
    .await?;
    let started_at: String = row.try_get("started_at")?;
    let total_cases: i64 = row.try_get("total_cases")?;
    let completed_cases: i64 = row.try_get("completed_cases")?;
    let is_terminal = total_cases > 0 && completed_cases == total_cases;
    let duration_ms = is_terminal
        .then(|| chrono::DateTime::parse_from_rfc3339(&started_at).ok())
        .flatten()
        .map(|started_at| {
            (chrono::Utc::now() - started_at.with_timezone(&chrono::Utc))
                .num_milliseconds()
                .max(0)
        });
    sqlx::query("UPDATE evaluation_runs SET status = ?, ended_at = CASE WHEN ? THEN ? ELSE ended_at END, duration_ms = CASE WHEN ? THEN ? ELSE duration_ms END, passed_cases = ?, failed_cases = ?, total_tokens = ?, estimated_cost_microusd = ?, updated_at = ? WHERE id = ?")
        .bind(if is_terminal { "completed" } else { "running" })
        .bind(is_terminal).bind(now)
        .bind(is_terminal).bind(duration_ms)
        .bind(row.try_get::<i64, _>("passed_cases")?)
        .bind(row.try_get::<i64, _>("failed_cases")?)
        .bind(row.try_get::<Option<i64>, _>("total_tokens")?)
        .bind(row.try_get::<Option<i64>, _>("estimated_cost_microusd")?)
        .bind(now).bind(evaluation_run_id)
        .execute(pool).await?;
    Ok(())
}

async fn fail_case_start_in_pool(
    pool: &sqlx::SqlitePool,
    evaluation_run_id: &str,
    result_id: &str,
    reason: &str,
) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE evaluation_case_results SET execution_status = 'failed', verdict = 'error', failure_reason = ?, updated_at = ? WHERE id = ? AND execution_status = 'running'")
        .bind(reason).bind(&now).bind(result_id).execute(pool).await?;
    refresh_run_aggregate(pool, evaluation_run_id, &now).await
}

async fn cancel_run_in_pool(pool: &sqlx::SqlitePool, evaluation_run_id: &str) -> Result<Vec<String>> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let status = sqlx::query_scalar::<_, String>("SELECT status FROM evaluation_runs WHERE id = ?")
        .bind(evaluation_run_id)
        .fetch_optional(&mut *transaction)
        .await?
        .context("evaluation run was not found")?;
    if !matches!(status.as_str(), "queued" | "running") {
        bail!("only a queued or running evaluation can be cancelled");
    }
    let workflow_run_ids = sqlx::query_scalar::<_, Option<String>>(
        "SELECT workflow_run_id FROM evaluation_case_results WHERE evaluation_run_id = ? AND execution_status = 'running'",
    )
    .bind(evaluation_run_id)
    .fetch_all(&mut *transaction)
    .await?
    .into_iter()
    .flatten()
    .collect();
    sqlx::query("UPDATE evaluation_runs SET status = 'cancelled', ended_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), error = ?, updated_at = ? WHERE id = ?")
        .bind(&now).bind(&now).bind("Cancelled by user.").bind(&now).bind(evaluation_run_id)
        .execute(&mut *transaction).await?;
    sqlx::query("UPDATE evaluation_case_results SET execution_status = 'cancelled', verdict = 'skipped', failure_reason = ?, updated_at = ? WHERE evaluation_run_id = ? AND execution_status = 'queued'")
        .bind("Evaluation batch was cancelled.").bind(&now).bind(evaluation_run_id)
        .execute(&mut *transaction).await?;
    transaction.commit().await?;
    Ok(workflow_run_ids)
}

async fn retry_failed_cases_in_pool(
    pool: &sqlx::SqlitePool,
    source_run_id: &str,
    id: String,
) -> Result<EvaluationRunSummary> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut transaction = pool.begin().await?;
    let source = sqlx::query(
        "SELECT suite_id, workflow_id, status, workflow_snapshot_json, workflow_fingerprint, suite_snapshot_json, execution_profile_json FROM evaluation_runs WHERE id = ?",
    )
    .bind(source_run_id)
    .fetch_optional(&mut *transaction)
    .await?
    .context("source evaluation run was not found")?;
    let source_status: String = source.try_get("status")?;
    if matches!(source_status.as_str(), "queued" | "running") {
        bail!("only a finished evaluation run can be retried");
    }
    let cases = sqlx::query(
        "SELECT evaluation_case_id, case_snapshot_json FROM evaluation_case_results WHERE evaluation_run_id = ? AND verdict IN ('failed', 'error') ORDER BY created_at ASC, id ASC",
    )
    .bind(source_run_id)
    .fetch_all(&mut *transaction)
    .await?;
    if cases.is_empty() {
        bail!("evaluation run has no failed or errored cases to retry");
    }
    let suite_id: String = source.try_get("suite_id")?;
    let workflow_id: String = source.try_get("workflow_id")?;
    sqlx::query(
        "INSERT INTO evaluation_runs (id, suite_id, workflow_id, retry_of_run_id, status, workflow_snapshot_json, workflow_fingerprint, suite_snapshot_json, execution_profile_json, started_at, total_cases, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&suite_id)
    .bind(&workflow_id)
    .bind(source_run_id)
    .bind(source.try_get::<String, _>("workflow_snapshot_json")?)
    .bind(source.try_get::<String, _>("workflow_fingerprint")?)
    .bind(source.try_get::<String, _>("suite_snapshot_json")?)
    .bind(source.try_get::<String, _>("execution_profile_json")?)
    .bind(&now)
    .bind(cases.len() as i64)
    .bind(&now)
    .bind(&now)
    .execute(&mut *transaction)
    .await?;
    for case in &cases {
        sqlx::query(
            "INSERT INTO evaluation_case_results (id, evaluation_run_id, evaluation_case_id, case_snapshot_json, execution_status, verdict, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'pending', ?, ?)",
        )
        .bind(uuid::Uuid::new_v4().to_string())
        .bind(&id)
        .bind(case.try_get::<String, _>("evaluation_case_id")?)
        .bind(case.try_get::<String, _>("case_snapshot_json")?)
        .bind(&now)
        .bind(&now)
        .execute(&mut *transaction)
        .await?;
    }
    transaction.commit().await?;
    Ok(EvaluationRunSummary {
        id,
        suite_id,
        workflow_id,
        retry_of_run_id: Some(source_run_id.to_string()),
        status: "queued".to_string(),
        total_cases: cases.len() as i64,
        started_at: now,
    })
}

fn validate_suite(request: &CreateEvaluationSuite) -> Result<()> {
    if request.id.trim().is_empty() || request.workflow_id.trim().is_empty() || request.name.trim().is_empty() {
        bail!("suite id, workflow id, and name are required");
    }
    Ok(())
}

fn suite_from_row(row: sqlx::sqlite::SqliteRow) -> Result<EvaluationSuiteSummary> {
    Ok(EvaluationSuiteSummary {
        id: row.try_get("id")?,
        workflow_id: row.try_get("workflow_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        case_count: row.try_get("case_count")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

fn validate_case(request: &CreateEvaluationCase) -> Result<()> {
    if request.id.trim().is_empty() || request.suite_id.trim().is_empty() || request.name.trim().is_empty() {
        bail!("case id, suite id, and name are required");
    }
    if request.position < 0 {
        bail!("case position cannot be negative");
    }
    request.expectation.validate()
}

fn case_from_row(row: sqlx::sqlite::SqliteRow) -> Result<EvaluationCaseSummary> {
    Ok(EvaluationCaseSummary {
        id: row.try_get("id")?,
        suite_id: row.try_get("suite_id")?,
        name: row.try_get("name")?,
        description: row.try_get("description")?,
        position: row.try_get("position")?,
        enabled: row.try_get("enabled")?,
        archived: row.try_get::<Option<String>, _>("deleted_at")?.is_some(),
        target_agent_id: row.try_get("target_agent_id")?,
        input: serde_json::from_str(&row.try_get::<String, _>("input_json")?)?,
        expectation: serde_json::from_str(&row.try_get::<String, _>("expectation_json")?)?,
        fixture: serde_json::from_str(&row.try_get::<String, _>("fixture_json")?)?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

/// A deterministic first-version expectation for one evaluation case.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationExpectation {
    #[serde(default)]
    pub assertions: Vec<EvaluationAssertion>,
}

/// Structured output checks use a deliberately small JSONPath subset. Keeping
/// paths to object keys makes assertions deterministic and easy to explain in
/// the result page; array selectors can be added without changing Case data.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum EvaluationAssertion {
    Text {
        #[serde(default = "default_assertion_id")]
        id: String,
        algorithm: SimilarityAlgorithm,
        expected: String,
        threshold: f64,
    },
    JsonPath {
        #[serde(default = "default_assertion_id")]
        id: String,
        path: String,
        operator: JsonPathOperator,
        expected: Value,
    },
    ToolTrajectory {
        #[serde(default = "default_assertion_id")]
        id: String,
        tools: Vec<ToolUse>,
        #[serde(default)]
        config: ToolTrajectoryConfig,
    },
    NodeTrajectory {
        #[serde(default = "default_assertion_id")]
        id: String,
        // Older builds persisted Rust's snake_case field names. Keep reading
        // them while making the JSON contract match the desktop camelCase API.
        #[serde(default, alias = "must_execute")]
        must_execute: Vec<String>,
        #[serde(default, alias = "must_not_execute")]
        must_not_execute: Vec<String>,
        #[serde(default, alias = "ordered_nodes")]
        ordered_nodes: Vec<String>,
        #[serde(default = "default_true", alias = "require_completed")]
        require_completed: bool,
    },
    Route {
        #[serde(default = "default_assertion_id")]
        id: String,
        node_id: String,
        expected_route: String,
    },
    NodeOutput {
        #[serde(default = "default_assertion_id")]
        id: String,
        node_id: String,
        path: String,
        operator: JsonPathOperator,
        expected: Value,
    },
    NodeText {
        #[serde(default = "default_assertion_id")]
        id: String,
        node_id: String,
        algorithm: SimilarityAlgorithm,
        expected: String,
        threshold: f64,
    },
    NodeToolTrajectory {
        #[serde(default = "default_assertion_id")]
        id: String,
        node_id: String,
        tools: Vec<ToolUse>,
        #[serde(default)]
        config: ToolTrajectoryConfig,
    },
    Safety {
        #[serde(default = "default_assertion_id")]
        id: String,
        target: SafetyAssertionTarget,
        #[serde(default)]
        field_paths: Vec<String>,
        #[serde(default)]
        forbidden_text: Vec<String>,
    },
}

fn default_assertion_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JsonPathOperator {
    Exists,
    Equals,
    NotEquals,
    Contains,
    NotContains,
}

/// Safety checks use only the redacted evidence projection so evaluation does
/// not create an additional unredacted store for detecting disclosures.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SafetyAssertionTarget {
    FinalOutput,
    ToolArguments,
    ToolResults,
}

/// The run data that is meaningful to deterministic ADK evaluation criteria.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEvaluationObservation {
    pub final_output: String,
    pub tool_uses: Vec<ToolUse>,
    pub node_executions: Vec<WorkflowNodeExecution>,
    pub routes: Vec<WorkflowRouteExecution>,
    pub node_outputs: Vec<WorkflowNodeOutput>,
    pub node_messages: Vec<WorkflowNodeMessage>,
    pub node_tool_uses: Vec<WorkflowNodeToolUse>,
}

/// A `node_start` is the source of truth for control flow. Completion is
/// joined by `(node, step)` so a retry remains a separate, inspectable event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeExecution {
    pub node_id: String,
    pub step: i64,
    pub completed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRouteExecution {
    pub node_id: String,
    pub route: String,
    pub label: Option<String>,
    pub condition: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeOutput {
    pub node_id: String,
    pub output: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeMessage {
    pub node_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeToolUse {
    pub node_id: String,
    pub tool: ToolUse,
}

/// One criterion is persisted independently so the eventual Result page can
/// explain why a case failed instead of reducing it to a single boolean.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CriterionResult {
    pub criterion: String,
    pub score: f64,
    pub threshold: f64,
    pub passed: bool,
    pub expected: Value,
    pub actual: Value,
}

fn criterion_outcome(criterion: &CriterionResult) -> EvaluationCriterionOutcome {
    EvaluationCriterionOutcome {
        criterion: criterion.criterion.clone(),
        passed: criterion.passed,
        score: criterion.score,
        threshold: criterion.threshold,
        expected: criterion.expected.clone(),
        actual: criterion.actual.clone(),
    }
}

fn criterion_match_key(criterion: &CriterionResult) -> String {
    let kind = criterion.criterion.split(':').next().unwrap_or_default();
    let expected = if matches!(kind, "toolTrajectory" | "nodeToolTrajectory") {
        // A tool-result assertion can be added after a release without making
        // it a different trajectory. Match the call identity (tool + args)
        // so the version view can compare both frozen results side by side.
        tool_trajectory_match_value(&criterion.expected)
    } else {
        criterion.expected.clone()
    };
    format!(
        "{kind}:{}",
        serde_json::to_string(&expected).unwrap_or_default()
    )
}

fn tool_trajectory_match_value(expected: &Value) -> Value {
    let normalize_tool = |tool: &Value| {
        let mut tool = tool.clone();
        if let Some(tool) = tool.as_object_mut() {
            tool.remove("expected_response");
            tool.remove("expectedResponse");
        }
        tool
    };
    match expected {
        Value::Array(tools) => Value::Array(tools.iter().map(normalize_tool).collect()),
        Value::Object(_) => {
            let mut value = expected.clone();
            if let Some(tools) = value.get_mut("tools").and_then(Value::as_array_mut) {
                for tool in tools {
                    if let Some(tool) = tool.as_object_mut() {
                        tool.remove("expected_response");
                        tool.remove("expectedResponse");
                    }
                }
            }
            value
        },
        _ => expected.clone(),
    }
}

fn compare_criteria(
    baseline: &[CriterionResult],
    candidate: &[CriterionResult],
) -> Vec<EvaluationVersionCriterionDiff> {
    let mut remaining = candidate.iter().collect::<Vec<_>>();
    let mut differences = Vec::new();
    for before in baseline {
        let index = remaining
            .iter()
            .position(|after| after.criterion == before.criterion)
            // Assertions stored before stable IDs were introduced receive a new
            // ID while being evaluated. Match those historical results by their
            // immutable rule definition, so they remain comparable.
            .or_else(|| {
                remaining
                    .iter()
                    .position(|after| criterion_match_key(after) == criterion_match_key(before))
            });
        let after = index.map(|index| remaining.remove(index));
        let kind = match after {
            Some(after) if before.passed && !after.passed => "regressed",
            Some(after) if !before.passed && after.passed => "fixed",
            Some(after) if !before.passed && !after.passed => "persistent_failure",
            Some(_) => "persistent_pass",
            None => "removed",
        };
        differences.push(EvaluationVersionCriterionDiff {
            key: before.criterion.clone(),
            baseline: Some(criterion_outcome(before)),
            candidate: after.map(criterion_outcome),
            kind: kind.to_string(),
        });
    }
    differences.extend(remaining.into_iter().map(|after| EvaluationVersionCriterionDiff {
        key: after.criterion.clone(),
        baseline: None,
        candidate: Some(criterion_outcome(after)),
        kind: "added".to_string(),
    }));
    differences.sort_by(|left, right| left.key.cmp(&right.key));
    differences
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvaluationScore {
    pub passed: bool,
    pub criteria: Vec<CriterionResult>,
    pub observation: WorkflowEvaluationObservation,
}

impl EvaluationExpectation {
    pub fn validate(&self) -> Result<()> {
        if self.assertions.is_empty() {
            bail!("an evaluation case needs at least one assertion");
        }
        for assertion in &self.assertions {
            match assertion {
                EvaluationAssertion::Text { threshold, .. } if !(0.0..=1.0).contains(threshold) => {
                    bail!("text assertion threshold must be between 0 and 1");
                },
                EvaluationAssertion::Safety {
                    field_paths,
                    forbidden_text,
                    ..
                } => {
                    if field_paths.is_empty() && forbidden_text.is_empty() {
                        bail!("a safety assertion needs a field path or forbidden text");
                    }
                    if field_paths.iter().any(|path| !path.starts_with("$.")) {
                        bail!("safety field paths must start with `$.`");
                    }
                },
                EvaluationAssertion::NodeTrajectory {
                    must_execute,
                    must_not_execute,
                    ordered_nodes,
                    ..
                } => {
                    let all_nodes = must_execute.iter().chain(must_not_execute).chain(ordered_nodes);
                    if all_nodes.clone().any(|node| node.trim().is_empty()) {
                        bail!("node trajectory assertions cannot contain an empty node id");
                    }
                    let required = must_execute.iter().collect::<HashSet<_>>();
                    if must_not_execute.iter().any(|node| required.contains(node)) {
                        bail!("a node cannot be both required and forbidden");
                    }
                },
                EvaluationAssertion::Route {
                    node_id,
                    expected_route,
                    ..
                } if node_id.trim().is_empty() || expected_route.trim().is_empty() => {
                    bail!("a route assertion needs a node and an expected route");
                },
                EvaluationAssertion::NodeOutput { node_id, path, .. }
                    if node_id.trim().is_empty() || !path.starts_with("$.") =>
                {
                    bail!("a node output assertion needs a node and a `$.` path");
                },
                EvaluationAssertion::NodeText { node_id, threshold, .. }
                    if node_id.trim().is_empty() || !(0.0..=1.0).contains(threshold) =>
                {
                    bail!("a node text assertion needs a node and a threshold between 0 and 1");
                },
                EvaluationAssertion::NodeToolTrajectory { node_id, tools, .. }
                    if node_id.trim().is_empty() || tools.is_empty() =>
                {
                    bail!("a node tool trajectory needs a node and at least one tool");
                },
                _ => {},
            }
        }
        Ok(())
    }
}

/// Scores a completed Workrun execution without re-running the workflow.
pub fn score(
    expectation: &EvaluationExpectation,
    observation: WorkflowEvaluationObservation,
) -> Result<EvaluationScore> {
    expectation.validate()?;
    let mut criteria = Vec::new();

    for assertion in expectation.assertions.clone() {
        match assertion {
            EvaluationAssertion::Text {
                id,
                algorithm,
                expected,
                threshold,
            } => {
                let scorer = ResponseScorer::with_config(ResponseMatchConfig {
                    algorithm,
                    ..Default::default()
                });
                let score = scorer.score(&expected, &observation.final_output);
                criteria.push(CriterionResult {
                    criterion: format!("text:{id}"),
                    score,
                    threshold,
                    passed: score >= threshold,
                    expected: Value::String(expected),
                    actual: Value::String(observation.final_output.clone()),
                });
            },
            EvaluationAssertion::JsonPath {
                id,
                path,
                operator,
                expected,
            } => criteria.push(score_json_path_assertion(
                &id,
                &path,
                &operator,
                &expected,
                &observation.final_output,
            )),
            EvaluationAssertion::ToolTrajectory { id, tools, config } => {
                let scorer = ToolTrajectoryScorer::with_config(config);
                let comparison = scorer.compare(&tools, &observation.tool_uses);
                // `adk-eval` deliberately treats expected_response as fixture
                // metadata. Workrun also uses it as an assertion so a model
                // cannot call the right tool and then ignore or invent its data.
                let response_mismatches = comparison
                    .matched
                    .iter()
                    .filter_map(|(expected, actual)| {
                        expected.expected_response.as_ref().and_then(|expected_response| {
                            (actual.expected_response.as_ref() != Some(expected_response)).then(|| {
                                json!({
                                    "tool": expected.name,
                                    "expected": expected_response,
                                    "actual": actual.expected_response,
                                })
                            })
                        })
                    })
                    .collect::<Vec<_>>();
                criteria.push(CriterionResult {
                    criterion: format!("toolTrajectory:{id}"),
                    score: comparison.score,
                    threshold: 1.0,
                    passed: comparison.score == 1.0 && response_mismatches.is_empty(),
                    expected: serde_json::to_value(&tools)?,
                    actual: json!({
                        "toolUses": observation.tool_uses,
                        "missing": comparison.missing,
                        "extra": comparison.extra,
                        "responseMismatches": response_mismatches,
                    }),
                });
            },
            EvaluationAssertion::NodeTrajectory {
                id,
                must_execute,
                must_not_execute,
                ordered_nodes,
                require_completed,
            } => criteria.push(score_node_trajectory_assertion(
                &id,
                &must_execute,
                &must_not_execute,
                &ordered_nodes,
                require_completed,
                &observation.node_executions,
            )),
            EvaluationAssertion::Route {
                id,
                node_id,
                expected_route,
            } => criteria.push(score_route_assertion(
                &id,
                &node_id,
                &expected_route,
                &observation.routes,
            )),
            EvaluationAssertion::NodeOutput {
                id,
                node_id,
                path,
                operator,
                expected,
            } => criteria.push(score_node_output_assertion(
                &id,
                &node_id,
                &path,
                &operator,
                &expected,
                &observation.node_outputs,
            )),
            EvaluationAssertion::NodeText {
                id,
                node_id,
                algorithm,
                expected,
                threshold,
            } => criteria.push(score_node_text_assertion(
                &id,
                &node_id,
                algorithm,
                &expected,
                threshold,
                &observation.node_messages,
            )),
            EvaluationAssertion::NodeToolTrajectory {
                id,
                node_id,
                tools,
                config,
            } => criteria.push(score_node_tool_trajectory_assertion(
                &id,
                &node_id,
                &tools,
                config,
                &observation.node_tool_uses,
            )),
            EvaluationAssertion::Safety {
                id,
                target,
                field_paths,
                forbidden_text,
            } => criteria.push(score_safety_assertion(
                &id,
                &target,
                &field_paths,
                &forbidden_text,
                &observation,
            )),
        }
    }

    Ok(EvaluationScore {
        passed: criteria.iter().all(|criterion| criterion.passed),
        criteria,
        observation,
    })
}

fn score_node_tool_trajectory_assertion(
    id: &str,
    node_id: &str,
    expected: &[ToolUse],
    config: ToolTrajectoryConfig,
    uses: &[WorkflowNodeToolUse],
) -> CriterionResult {
    let actual = uses
        .iter()
        .filter(|use_| use_.node_id == node_id)
        .map(|use_| use_.tool.clone())
        .collect::<Vec<_>>();
    let comparison = ToolTrajectoryScorer::with_config(config).compare(expected, &actual);
    let passed = comparison.score == 1.0;
    CriterionResult {
        criterion: format!("nodeToolTrajectory:{id}"),
        score: comparison.score,
        threshold: 1.0,
        passed,
        expected: json!({ "nodeId": node_id, "tools": expected }),
        actual: json!({ "nodeId": node_id, "toolUses": actual, "missing": comparison.missing, "extra": comparison.extra }),
    }
}

fn score_node_text_assertion(
    id: &str,
    node_id: &str,
    algorithm: SimilarityAlgorithm,
    expected: &str,
    threshold: f64,
    messages: &[WorkflowNodeMessage],
) -> CriterionResult {
    let actual = messages
        .iter()
        .rev()
        .find(|message| message.node_id == node_id)
        .map(|message| message.content.clone())
        .unwrap_or_default();
    let score = ResponseScorer::with_config(ResponseMatchConfig {
        algorithm,
        ..Default::default()
    })
    .score(expected, &actual);
    CriterionResult {
        criterion: format!("nodeText:{id}"),
        score,
        threshold,
        passed: score >= threshold,
        expected: json!({ "nodeId": node_id, "text": expected }),
        actual: Value::String(actual),
    }
}

fn score_node_output_assertion(
    id: &str,
    node_id: &str,
    path: &str,
    operator: &JsonPathOperator,
    expected: &Value,
    node_outputs: &[WorkflowNodeOutput],
) -> CriterionResult {
    let output = node_outputs
        .iter()
        .rev()
        .find(|output| output.node_id == node_id)
        .map(|output| &output.output);
    let actual = output.and_then(|output| json_path_value(output, path)).cloned();
    let passed = match operator {
        JsonPathOperator::Exists => actual.is_some(),
        JsonPathOperator::Equals => actual.as_ref().is_some_and(|actual| actual == expected),
        JsonPathOperator::NotEquals => actual.as_ref().is_some_and(|actual| actual != expected),
        JsonPathOperator::Contains => actual.as_ref().is_some_and(|actual| json_contains(actual, expected)),
        JsonPathOperator::NotContains => actual.as_ref().is_some_and(|actual| !json_contains(actual, expected)),
    };
    CriterionResult {
        criterion: format!("nodeOutput:{id}"),
        score: if passed { 1.0 } else { 0.0 },
        threshold: 1.0,
        passed,
        expected: json!({ "nodeId": node_id, "path": path, "operator": operator, "value": expected }),
        actual: actual.unwrap_or_else(|| json!({ "nodeId": node_id, "error": "path was not found" })),
    }
}

fn score_route_assertion(
    id: &str,
    node_id: &str,
    expected_route: &str,
    routes: &[WorkflowRouteExecution],
) -> CriterionResult {
    // A control node can be retried. The final matching trace entry reflects
    // the route that ultimately advanced the workflow.
    let actual = routes.iter().rev().find(|route| route.node_id == node_id);
    let passed = actual.is_some_and(|route| route.route == expected_route);
    CriterionResult {
        criterion: format!("route:{id}"),
        score: if passed { 1.0 } else { 0.0 },
        threshold: 1.0,
        passed,
        expected: json!({ "nodeId": node_id, "route": expected_route }),
        actual: actual
            .map(|route| serde_json::to_value(route).expect("route execution is serializable"))
            .unwrap_or_else(|| json!({ "nodeId": node_id, "route": null })),
    }
}

fn score_node_trajectory_assertion(
    id: &str,
    must_execute: &[String],
    must_not_execute: &[String],
    ordered_nodes: &[String],
    require_completed: bool,
    executions: &[WorkflowNodeExecution],
) -> CriterionResult {
    let executed = executions
        .iter()
        .map(|execution| execution.node_id.as_str())
        .collect::<Vec<_>>();
    let missing = must_execute
        .iter()
        .filter(|node| !executed.contains(&node.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let forbidden = must_not_execute
        .iter()
        .filter(|node| executed.contains(&node.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let incomplete = if require_completed {
        must_execute
            .iter()
            .filter(|node| {
                !executions
                    .iter()
                    .any(|execution| execution.node_id == **node && execution.completed)
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let mut next_index = 0;
    let mut out_of_order = Vec::new();
    for node in ordered_nodes {
        match executed[next_index..].iter().position(|actual| *actual == node) {
            Some(index) => next_index += index + 1,
            None => out_of_order.push(node.clone()),
        }
    }
    let passed = missing.is_empty() && forbidden.is_empty() && incomplete.is_empty() && out_of_order.is_empty();
    CriterionResult {
        criterion: format!("nodeTrajectory:{id}"),
        score: if passed { 1.0 } else { 0.0 },
        threshold: 1.0,
        passed,
        expected: json!({
            "mustExecute": must_execute,
            "mustNotExecute": must_not_execute,
            "orderedNodes": ordered_nodes,
            "requireCompleted": require_completed,
        }),
        actual: json!({
            "nodeExecutions": executions,
            "missing": missing,
            "forbidden": forbidden,
            "incomplete": incomplete,
            "outOfOrder": out_of_order,
        }),
    }
}

fn score_safety_assertion(
    id: &str,
    target: &SafetyAssertionTarget,
    field_paths: &[String],
    forbidden_text: &[String],
    observation: &WorkflowEvaluationObservation,
) -> CriterionResult {
    let values = match target {
        SafetyAssertionTarget::FinalOutput => serde_json::from_str(&observation.final_output)
            .ok()
            .into_iter()
            .collect::<Vec<_>>(),
        SafetyAssertionTarget::ToolArguments => observation.tool_uses.iter().map(|tool| tool.args.clone()).collect(),
        SafetyAssertionTarget::ToolResults => observation
            .tool_uses
            .iter()
            .filter_map(|tool| tool.expected_response.clone())
            .collect(),
    };
    let text = match target {
        SafetyAssertionTarget::FinalOutput => observation.final_output.clone(),
        _ => serde_json::to_string(&values).unwrap_or_default(),
    };
    let present_fields = field_paths
        .iter()
        .filter_map(|path| {
            let matches = values
                .iter()
                .filter(|value| json_path_value(value, path).is_some())
                .count();
            (matches > 0).then(|| json!({ "path": path, "matches": matches }))
        })
        .collect::<Vec<_>>();
    let forbidden_matches = forbidden_text
        .iter()
        .filter_map(|forbidden| {
            let matches = text.matches(forbidden).count();
            (matches > 0).then(|| json!({ "text": forbidden, "matches": matches }))
        })
        .collect::<Vec<_>>();
    let passed = present_fields.is_empty() && forbidden_matches.is_empty();
    CriterionResult {
        criterion: format!("safety:{id}"),
        score: if passed { 1.0 } else { 0.0 },
        threshold: 1.0,
        passed,
        expected: json!({
            "target": target,
            "fieldPaths": field_paths,
            "forbiddenText": forbidden_text,
        }),
        // Do not echo a matched value: a failed safety result must not become
        // another disclosure channel.
        actual: json!({
            "presentFields": present_fields,
            "forbiddenMatches": forbidden_matches,
        }),
    }
}

fn score_json_path_assertion(
    id: &str,
    path: &str,
    operator: &JsonPathOperator,
    expected: &Value,
    final_output: &str,
) -> CriterionResult {
    let output = serde_json::from_str::<Value>(final_output);
    let actual = output
        .as_ref()
        .ok()
        .and_then(|value| json_path_value(value, path))
        .cloned();
    let passed = match operator {
        JsonPathOperator::Exists => actual.is_some(),
        JsonPathOperator::Equals => actual.as_ref().is_some_and(|actual| actual == expected),
        JsonPathOperator::NotEquals => actual.as_ref().is_some_and(|actual| actual != expected),
        JsonPathOperator::Contains => actual.as_ref().is_some_and(|actual| json_contains(actual, expected)),
        JsonPathOperator::NotContains => actual.as_ref().is_some_and(|actual| !json_contains(actual, expected)),
    };
    CriterionResult {
        criterion: format!("jsonPath:{id}"),
        score: if passed { 1.0 } else { 0.0 },
        threshold: 1.0,
        passed,
        expected: json!({ "path": path, "operator": operator, "value": expected }),
        actual: actual.unwrap_or_else(|| {
            json!({ "error": output.err().map(|error| error.to_string()).unwrap_or_else(|| "path was not found".to_string()) })
        }),
    }
}

fn json_path_value<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut keys = path.strip_prefix("$.")?.split('.');
    keys.try_fold(value, |current, key| current.as_object()?.get(key))
}

fn json_contains(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::String(actual), Value::String(expected)) => actual.contains(expected),
        (Value::Array(actual), expected) => actual.contains(expected),
        _ => actual == expected,
    }
}

/// Combines the redacted output trace with durable node lifecycle events. Tool
/// assertions only need output trace, but control-flow assertions must retain
/// the runtime's actual scheduling order.
pub fn observe_workflow_output(state: &Value, events: &[Value]) -> WorkflowEvaluationObservation {
    let trace = workflow_trace(state);
    let tool_uses = trace
        .iter()
        .flat_map(|entry| entry.get("toolCalls").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|call| {
            Some(ToolUse {
                name: call.get("tool")?.as_str()?.to_string(),
                args: call.get("input").cloned().unwrap_or_else(|| json!({})),
                expected_response: call.get("result").cloned(),
            })
        })
        .collect();
    let final_output = trace
        .iter()
        .rev()
        .flat_map(|entry| entry.get("messages").and_then(Value::as_array).into_iter().flatten())
        .filter_map(|message| message.get("content").and_then(Value::as_str))
        .next()
        .or_else(|| {
            state.get("messages").and_then(Value::as_array).and_then(|messages| {
                messages
                    .iter()
                    .rev()
                    .find_map(|message| message.get("content").and_then(Value::as_str))
            })
        })
        .unwrap_or_default()
        .to_string();

    WorkflowEvaluationObservation {
        final_output,
        tool_uses,
        node_executions: observe_node_executions(events),
        routes: observe_routes(trace.clone()),
        node_outputs: observe_node_outputs(trace.clone()),
        node_messages: observe_node_messages(trace.clone()),
        node_tool_uses: observe_node_tool_uses(trace),
    }
}

fn observe_node_tool_uses(trace: Vec<&Value>) -> Vec<WorkflowNodeToolUse> {
    trace
        .into_iter()
        .flat_map(|entry| {
            let Some(node_id) = entry.get("nodeId").and_then(Value::as_str) else {
                return Vec::new();
            };
            entry
                .get("toolCalls")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|call| {
                    Some(WorkflowNodeToolUse {
                        node_id: node_id.to_string(),
                        tool: ToolUse {
                            name: call.get("tool")?.as_str()?.to_string(),
                            args: call.get("input").cloned().unwrap_or_else(|| json!({})),
                            expected_response: call.get("result").cloned(),
                        },
                    })
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn observe_node_messages(trace: Vec<&Value>) -> Vec<WorkflowNodeMessage> {
    trace
        .into_iter()
        .flat_map(|entry| {
            let Some(node_id) = entry.get("nodeId").and_then(Value::as_str) else {
                return Vec::new();
            };
            entry
                .get("messages")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|message| message.get("content").and_then(Value::as_str))
                .map(|content| WorkflowNodeMessage {
                    node_id: node_id.to_string(),
                    content: content.to_string(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn observe_node_outputs(trace: Vec<&Value>) -> Vec<WorkflowNodeOutput> {
    trace
        .into_iter()
        .filter_map(|entry| {
            let node_id = entry.get("nodeId")?.as_str()?.to_string();
            // Most executable nodes publish a `result`. For agent nodes the
            // message trace itself is the observable output surface.
            let output = entry.get("result").cloned().unwrap_or_else(|| entry.clone());
            Some(WorkflowNodeOutput { node_id, output })
        })
        .collect()
}

fn observe_routes(trace: Vec<&Value>) -> Vec<WorkflowRouteExecution> {
    trace
        .into_iter()
        .filter(|entry| matches!(entry.get("type").and_then(Value::as_str), Some("if_else" | "switch")))
        .filter_map(|entry| {
            Some(WorkflowRouteExecution {
                node_id: entry.get("nodeId")?.as_str()?.to_string(),
                route: entry.pointer("/result/route")?.as_str()?.to_string(),
                label: entry
                    .pointer("/result/label")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
                condition: entry
                    .pointer("/result/condition")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned),
            })
        })
        .collect()
}

fn observe_node_executions(events: &[Value]) -> Vec<WorkflowNodeExecution> {
    let mut executions = Vec::new();
    for event in events {
        let Some(event_type) = event.get("type").and_then(Value::as_str) else {
            continue;
        };
        let Some(node_id) = event.get("node").and_then(Value::as_str) else {
            continue;
        };
        let step = event.get("step").and_then(Value::as_i64).unwrap_or_default();
        match event_type {
            "node_start" => executions.push(WorkflowNodeExecution {
                node_id: node_id.to_string(),
                step,
                completed: false,
            }),
            "node_end" => {
                if let Some(execution) = executions
                    .iter_mut()
                    .rev()
                    .find(|execution| execution.node_id == node_id && execution.step == step && !execution.completed)
                {
                    execution.completed = true;
                }
            },
            _ => {},
        }
    }
    executions
}

fn workflow_trace(state: &Value) -> Vec<&Value> {
    state
        .get("workflow")
        .and_then(|workflow| workflow.get("workflow.trace").or_else(|| workflow.get("trace")))
        .or_else(|| state.get("workflow.trace"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn retry_copies_only_failed_case_snapshots_from_a_finished_run() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE evaluation_runs (id TEXT PRIMARY KEY, suite_id TEXT NOT NULL, workflow_id TEXT NOT NULL, retry_of_run_id TEXT, status TEXT NOT NULL, workflow_snapshot_json TEXT NOT NULL, workflow_fingerprint TEXT NOT NULL, suite_snapshot_json TEXT NOT NULL, execution_profile_json TEXT NOT NULL, started_at TEXT NOT NULL, total_cases INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE evaluation_case_results (id TEXT PRIMARY KEY, evaluation_run_id TEXT NOT NULL, evaluation_case_id TEXT NOT NULL, case_snapshot_json TEXT NOT NULL, execution_status TEXT NOT NULL, verdict TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, suite_id, workflow_id, status, workflow_snapshot_json, workflow_fingerprint, suite_snapshot_json, execution_profile_json, started_at, total_cases, created_at, updated_at) VALUES ('source', 'suite', 'workflow', 'completed', '{\"name\":\"frozen\"}', 'fingerprint', '{}', '{}', '2026-01-01T00:00:00Z', 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, evaluation_case_id, case_snapshot_json, execution_status, verdict, created_at, updated_at) VALUES ('failed', 'source', 'case-failed', '{\"input\":\"frozen failure\"}', 'completed', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('error', 'source', 'case-error', '{\"input\":\"frozen error\"}', 'failed', 'error', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('passed', 'source', 'case-passed', '{}', 'completed', 'passed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')")
            .execute(&pool).await.unwrap();

        let retry = retry_failed_cases_in_pool(&pool, "source", "retry".to_string())
            .await
            .unwrap();

        assert_eq!(retry.total_cases, 2);
        assert_eq!(retry.retry_of_run_id.as_deref(), Some("source"));
        let retry_source: Option<String> =
            sqlx::query_scalar("SELECT retry_of_run_id FROM evaluation_runs WHERE id = 'retry'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(retry_source.as_deref(), Some("source"));
        let cases: Vec<(String, String, String, String)> = sqlx::query_as("SELECT evaluation_case_id, case_snapshot_json, execution_status, verdict FROM evaluation_case_results WHERE evaluation_run_id = 'retry' ORDER BY evaluation_case_id")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(
            cases,
            vec![
                (
                    "case-error".to_string(),
                    "{\"input\":\"frozen error\"}".to_string(),
                    "queued".to_string(),
                    "pending".to_string()
                ),
                (
                    "case-failed".to_string(),
                    "{\"input\":\"frozen failure\"}".to_string(),
                    "queued".to_string(),
                    "pending".to_string()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn failed_case_start_is_terminal_and_does_not_strand_its_run() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE evaluation_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, total_cases INTEGER NOT NULL, status TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, passed_cases INTEGER NOT NULL DEFAULT 0, failed_cases INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER, estimated_cost_microusd INTEGER, updated_at TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE evaluation_case_results (id TEXT PRIMARY KEY, evaluation_run_id TEXT NOT NULL, execution_status TEXT NOT NULL, verdict TEXT NOT NULL, total_tokens INTEGER, estimated_cost_microusd INTEGER, failure_reason TEXT, updated_at TEXT)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, started_at, total_cases, status) VALUES ('run-1', '2026-01-01T00:00:00Z', 1, 'running')")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, execution_status, verdict) VALUES ('result-1', 'run-1', 'running', 'pending')")
            .execute(&pool).await.unwrap();

        fail_case_start_in_pool(&pool, "run-1", "result-1", "fixture is invalid")
            .await
            .unwrap();

        let case: (String, String, String) = sqlx::query_as(
            "SELECT execution_status, verdict, failure_reason FROM evaluation_case_results WHERE id = 'result-1'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let run: (String, i64) = sqlx::query_as("SELECT status, failed_cases FROM evaluation_runs WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(case, ("failed".into(), "error".into(), "fixture is invalid".into()));
        assert_eq!(run, ("completed".into(), 1));
    }

    #[tokio::test]
    async fn cancelling_a_run_skips_queued_cases_and_returns_active_workflow_ids() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE evaluation_runs (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, status TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, error TEXT, updated_at TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE evaluation_case_results (id TEXT PRIMARY KEY, evaluation_run_id TEXT NOT NULL, workflow_run_id TEXT, execution_status TEXT NOT NULL, verdict TEXT NOT NULL, failure_reason TEXT, updated_at TEXT)").execute(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO evaluation_runs (id, started_at, status) VALUES ('run-1', '2026-01-01T00:00:00Z', 'running')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, workflow_run_id, execution_status, verdict) VALUES ('active', 'run-1', 'workflow-1', 'running', 'pending'), ('queued', 'run-1', NULL, 'queued', 'pending')").execute(&pool).await.unwrap();

        let workflow_run_ids = cancel_run_in_pool(&pool, "run-1").await.unwrap();

        let status: String = sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let queued: (String, String) =
            sqlx::query_as("SELECT execution_status, verdict FROM evaluation_case_results WHERE id = 'queued'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(workflow_run_ids, vec!["workflow-1"]);
        assert_eq!(status, "cancelled");
        assert_eq!(queued, ("cancelled".into(), "skipped".into()));
    }

    #[test]
    fn compares_criteria_by_rule_definition_when_historical_ids_changed() {
        let baseline = CriterionResult {
            criterion: "jsonPath:old-generated-id".to_string(),
            score: 1.0,
            threshold: 1.0,
            passed: true,
            expected: json!({ "path": "$.decision", "operator": "equals", "value": "通过" }),
            actual: json!("通过"),
        };
        let candidate = CriterionResult {
            criterion: "jsonPath:new-generated-id".to_string(),
            score: 0.0,
            threshold: 1.0,
            passed: false,
            expected: baseline.expected.clone(),
            actual: json!("拒绝"),
        };

        let comparison = compare_criteria(&[baseline], &[candidate]);

        assert_eq!(comparison.len(), 1);
        assert_eq!(comparison[0].kind, "regressed");
        assert!(comparison[0].baseline.as_ref().is_some_and(|item| item.passed));
        assert!(comparison[0].candidate.as_ref().is_some_and(|item| !item.passed));
    }

    #[test]
    fn compares_tool_trajectories_when_only_the_result_assertion_changed() {
        let baseline = CriterionResult {
            criterion: "toolTrajectory:old-generated-id".to_string(),
            score: 1.0,
            threshold: 1.0,
            passed: true,
            expected: json!([{
                "name": "lookup_order",
                "args": { "orderId": "42" },
                "expected_response": null,
            }]),
            actual: json!({ "toolUses": [] }),
        };
        let candidate = CriterionResult {
            criterion: "toolTrajectory:new-generated-id".to_string(),
            score: 1.0,
            threshold: 1.0,
            passed: true,
            expected: json!([{
                "name": "lookup_order",
                "args": { "orderId": "42" },
                "expected_response": { "status": "high_risk" },
            }]),
            actual: json!({ "toolUses": [] }),
        };

        let comparison = compare_criteria(&[baseline], &[candidate]);

        assert_eq!(comparison.len(), 1);
        assert_eq!(comparison[0].kind, "persistent_pass");
        assert!(comparison[0].baseline.is_some());
        assert!(comparison[0].candidate.is_some());
    }

    #[test]
    fn observes_workrun_agent_trace_and_scores_with_adk_eval() {
        let state = json!({
            "workflow": {
                "workflow.trace": [{
                    "messages": [{ "role": "assistant", "content": "订单 42 已取消" }],
                    "toolCalls": [{
                        "tool": "cancel_order",
                        "input": { "orderId": "42" },
                        "result": { "cancelled": true }
                    }]
                }]
            }
        });
        let expectation = EvaluationExpectation {
            assertions: vec![
                EvaluationAssertion::Text {
                    id: "response".to_string(),
                    algorithm: SimilarityAlgorithm::Contains,
                    expected: "订单 42".to_string(),
                    threshold: 1.0,
                },
                EvaluationAssertion::ToolTrajectory {
                    id: "tool".to_string(),
                    tools: vec![ToolUse::new("cancel_order").with_args(json!({ "orderId": "42" }))],
                    config: ToolTrajectoryConfig {
                        strict_order: true,
                        strict_args: true,
                    },
                },
            ],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();

        assert!(score.passed);
        assert_eq!(score.observation.final_output, "订单 42 已取消");
        assert_eq!(score.observation.tool_uses.len(), 1);
        assert!(score.criteria.iter().all(|criterion| criterion.passed));
    }

    #[test]
    fn scores_node_trajectory_from_durable_lifecycle_events() {
        let events = vec![
            json!({ "type": "node_start", "node": "intent", "step": 1 }),
            json!({ "type": "node_end", "node": "intent", "step": 1 }),
            json!({ "type": "node_start", "node": "refund", "step": 2 }),
            json!({ "type": "node_end", "node": "refund", "step": 2 }),
        ];
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::NodeTrajectory {
                id: "refund-route".to_string(),
                must_execute: vec!["intent".to_string(), "refund".to_string()],
                must_not_execute: vec!["manual-review".to_string()],
                ordered_nodes: vec!["intent".to_string(), "refund".to_string()],
                require_completed: true,
            }],
        };

        let score = score(&expectation, observe_workflow_output(&json!({}), &events)).unwrap();

        assert!(score.passed);
        assert_eq!(score.observation.node_executions.len(), 2);
        assert!(score.observation.node_executions.iter().all(|node| node.completed));
    }

    #[test]
    fn reports_forbidden_and_incomplete_nodes_in_the_trajectory_evidence() {
        let events = vec![
            json!({ "type": "node_start", "node": "intent", "step": 1 }),
            json!({ "type": "node_start", "node": "manual-review", "step": 2 }),
        ];
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::NodeTrajectory {
                id: "automatic-route".to_string(),
                must_execute: vec!["intent".to_string()],
                must_not_execute: vec!["manual-review".to_string()],
                ordered_nodes: vec!["intent".to_string()],
                require_completed: true,
            }],
        };

        let score = score(&expectation, observe_workflow_output(&json!({}), &events)).unwrap();

        assert!(!score.passed);
        assert_eq!(score.criteria[0].actual["forbidden"], json!(["manual-review"]));
        assert_eq!(score.criteria[0].actual["incomplete"], json!(["intent"]));
    }

    #[test]
    fn reports_nodes_that_do_not_follow_the_required_order() {
        let events = vec![
            json!({ "type": "node_start", "node": "refund", "step": 1 }),
            json!({ "type": "node_end", "node": "refund", "step": 1 }),
            json!({ "type": "node_start", "node": "intent", "step": 2 }),
            json!({ "type": "node_end", "node": "intent", "step": 2 }),
        ];
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::NodeTrajectory {
                id: "ordered-route".to_string(),
                must_execute: vec![],
                must_not_execute: vec![],
                ordered_nodes: vec!["intent".to_string(), "refund".to_string()],
                require_completed: false,
            }],
        };

        let score = score(&expectation, observe_workflow_output(&json!({}), &events)).unwrap();

        assert!(!score.passed);
        assert_eq!(score.criteria[0].actual["outOfOrder"], json!(["refund"]));
    }

    #[test]
    fn scores_the_route_recorded_by_a_control_node() {
        let state = json!({
            "workflow": {
                "workflow.trace": [{
                    "nodeId": "risk-check",
                    "type": "switch",
                    "result": {
                        "route": "case:approved",
                        "label": "Approved",
                        "condition": "risk < 0.2"
                    }
                }]
            }
        });
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::Route {
                id: "approved-route".to_string(),
                node_id: "risk-check".to_string(),
                expected_route: "case:approved".to_string(),
            }],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();

        assert!(score.passed);
        assert_eq!(score.observation.routes[0].label.as_deref(), Some("Approved"));
    }

    #[test]
    fn fails_when_a_control_node_takes_another_route() {
        let state = json!({
            "workflow": {
                "workflow.trace": [{
                    "nodeId": "eligibility",
                    "type": "if_else",
                    "result": { "route": "false", "label": "Manual review" }
                }]
            }
        });
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::Route {
                id: "automatic-route".to_string(),
                node_id: "eligibility".to_string(),
                expected_route: "true".to_string(),
            }],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();

        assert!(!score.passed);
        assert_eq!(score.criteria[0].actual["route"], json!("false"));
    }

    #[test]
    fn scores_an_output_field_from_the_selected_node() {
        let state = json!({
            "workflow": {
                "workflow.trace": [{
                    "nodeId": "risk-check",
                    "type": "process",
                    "result": { "riskLevel": "low", "score": 0.1 }
                }]
            }
        });
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::NodeOutput {
                id: "risk-level".to_string(),
                node_id: "risk-check".to_string(),
                path: "$.riskLevel".to_string(),
                operator: JsonPathOperator::Equals,
                expected: json!("low"),
            }],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();

        assert!(score.passed);
        assert_eq!(score.observation.node_outputs[0].output["score"], json!(0.1));
    }

    #[test]
    fn scores_the_last_assistant_message_from_an_agent_node() {
        let state = json!({
            "workflow": {
                "workflow.trace": [{
                    "nodeId": "summarizer",
                    "type": "agent",
                    "messages": [{ "role": "assistant", "content": "Order 42 is approved." }]
                }]
            }
        });
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::NodeText {
                id: "approval-summary".to_string(),
                node_id: "summarizer".to_string(),
                algorithm: SimilarityAlgorithm::Contains,
                expected: "approved".to_string(),
                threshold: 1.0,
            }],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();

        assert!(score.passed);
        assert_eq!(score.observation.node_messages[0].content, "Order 42 is approved.");
    }

    #[test]
    fn preserves_node_trajectory_fields_from_the_desktop_json_contract() {
        let expectation: EvaluationExpectation = serde_json::from_value(json!({
            "assertions": [{
                "kind": "node_trajectory",
                "id": "route",
                "mustExecute": ["intent"],
                "mustNotExecute": ["manual-review"],
                "orderedNodes": ["intent", "refund"],
                "requireCompleted": true
            }]
        }))
        .unwrap();

        let saved = serde_json::to_value(expectation).unwrap();

        assert_eq!(saved["assertions"][0]["mustExecute"], json!(["intent"]));
        assert_eq!(saved["assertions"][0]["mustNotExecute"], json!(["manual-review"]));
        assert_eq!(saved["assertions"][0]["orderedNodes"], json!(["intent", "refund"]));
        assert!(saved["assertions"][0].get("must_execute").is_none());
    }

    #[test]
    fn reads_node_trajectory_saved_by_an_older_snake_case_build() {
        let expectation: EvaluationExpectation = serde_json::from_value(json!({
            "assertions": [{
                "kind": "node_trajectory",
                "must_execute": ["intent"],
                "ordered_nodes": ["intent"]
            }]
        }))
        .unwrap();

        let saved = serde_json::to_value(expectation).unwrap();

        assert_eq!(saved["assertions"][0]["mustExecute"], json!(["intent"]));
        assert_eq!(saved["assertions"][0]["orderedNodes"], json!(["intent"]));
    }

    #[test]
    fn preserves_tool_trajectory_options_from_the_desktop_json_contract() {
        // ToolUse and ToolTrajectoryConfig are supplied by adk-eval. Their
        // serde contract is snake_case even though Workrun's outer assertion
        // object is camelCase, so verify the exact JSON saved by the desktop.
        let expectation: EvaluationExpectation = serde_json::from_value(json!({
            "assertions": [{
                "kind": "tool_trajectory",
                "id": "order-lookup",
                "tools": [{
                    "name": "lookup_order",
                    "args": { "orderId": "42" },
                    "expected_response": { "status": "high_risk" }
                }],
                "config": { "strict_order": true, "strict_args": true }
            }]
        }))
        .unwrap();

        let saved = serde_json::to_value(expectation).unwrap();

        assert_eq!(saved["assertions"][0]["config"]["strict_args"], true);
        assert_eq!(
            saved["assertions"][0]["tools"][0]["expected_response"],
            json!({ "status": "high_risk" })
        );
    }

    #[test]
    fn rejects_a_tool_call_when_its_fixture_result_does_not_match() {
        let state = json!({
            "workflow": { "workflow.trace": [{ "toolCalls": [{
                "tool": "lookup_customer",
                "input": { "email": "a@example.com" },
                "result": { "found": false }
            }]}]}
        });
        let expected_tool = ToolUse {
            name: "lookup_customer".to_string(),
            args: json!({ "email": "a@example.com" }),
            expected_response: Some(json!({ "found": true })),
        };
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::ToolTrajectory {
                id: "crm-fixture".to_string(),
                tools: vec![expected_tool],
                config: ToolTrajectoryConfig::default(),
            }],
        };

        let score = score(&expectation, observe_workflow_output(&state, &[])).unwrap();
        assert!(!score.passed);
        assert_eq!(score.criteria[0].score, 1.0);
        assert_eq!(
            score.criteria[0].actual["responseMismatches"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn rejects_sensitive_tool_result_fields_without_echoing_the_value() {
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::Safety {
                id: "no-customer-email".to_string(),
                target: SafetyAssertionTarget::ToolResults,
                field_paths: vec!["$.customer.email".to_string()],
                forbidden_text: vec!["secret-token".to_string()],
            }],
        };
        let observation = WorkflowEvaluationObservation {
            final_output: "ok".to_string(),
            tool_uses: vec![ToolUse {
                name: "crm.lookup".to_string(),
                args: json!({}),
                expected_response: Some(json!({
                    "customer": { "email": "customer@example.com" },
                    "token": "secret-token"
                })),
            }],
            node_executions: vec![],
            routes: vec![],
            node_outputs: vec![],
            node_messages: vec![],
            node_tool_uses: vec![],
        };

        let score = score(&expectation, observation).unwrap();
        assert!(!score.passed);
        assert_eq!(score.criteria[0].actual["presentFields"][0]["path"], "$.customer.email");
        assert!(score.criteria[0].actual.to_string().contains("customer@example.com") == false);
    }

    #[test]
    fn reports_the_missing_tool_as_a_failed_criterion() {
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::ToolTrajectory {
                id: "required-tool".to_string(),
                tools: vec![ToolUse::new("cancel_order")],
                config: ToolTrajectoryConfig::default(),
            }],
        };

        let score = score(
            &expectation,
            WorkflowEvaluationObservation {
                final_output: String::new(),
                tool_uses: vec![],
                node_executions: vec![],
                routes: vec![],
                node_outputs: vec![],
                node_messages: vec![],
                node_tool_uses: vec![],
            },
        )
        .unwrap();

        assert!(!score.passed);
        assert_eq!(score.criteria[0].criterion, "toolTrajectory:required-tool");
        assert_eq!(score.criteria[0].actual["missing"][0]["name"], "cancel_order");
    }

    #[test]
    fn distinguishes_a_json_decision_from_a_substring_match() {
        let expectation = EvaluationExpectation {
            assertions: vec![EvaluationAssertion::JsonPath {
                id: "decision-is-approved".to_string(),
                path: "$.decision".to_string(),
                operator: JsonPathOperator::Equals,
                expected: json!("通过"),
            }],
        };
        let score = score(
            &expectation,
            WorkflowEvaluationObservation {
                final_output: json!({ "decision": "不通过" }).to_string(),
                tool_uses: vec![],
                node_executions: vec![],
                routes: vec![],
                node_outputs: vec![],
                node_messages: vec![],
                node_tool_uses: vec![],
            },
        )
        .unwrap();

        assert!(!score.passed);
        assert_eq!(score.criteria[0].criterion, "jsonPath:decision-is-approved");
        assert_eq!(score.criteria[0].actual, json!("不通过"));
    }

    #[test]
    fn fingerprints_distinguish_workflow_drafts() {
        let baseline = json!({ "dsl": { "nodes": [{ "id": "one" }] } });
        let changed = json!({ "dsl": { "nodes": [{ "id": "two" }] } });

        assert_eq!(
            workflow_snapshot_fingerprint(&baseline),
            workflow_snapshot_fingerprint(&baseline),
        );
        assert_ne!(
            workflow_snapshot_fingerprint(&baseline),
            workflow_snapshot_fingerprint(&changed),
        );
    }
}
