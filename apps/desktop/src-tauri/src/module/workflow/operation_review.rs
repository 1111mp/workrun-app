//! Human evidence is an explicit assertion, never inferred from a timeout.
use super::*;
use sqlx::Row;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum Decision {
    Completed { result: Value },
    NoEffect,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ReviewRequest {
    pub run_id: String,
    pub operation_id: String,
    pub expected_attempt: i64,
    pub stopped_confirmed: bool,
    pub evidence: String,
    pub decision: Decision,
}

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewSummary {
    pub decision: String,
    pub attempt_sequence: i64,
    pub created_at: String,
}
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Approval {
    pub id: String,
    pub status: String,
    pub target_name: String,
    pub created_at: String,
    #[sqlx(default)]
    pub arguments: Option<Value>,
}

fn encrypt(value: &Value, key: &[u8]) -> Result<String> {
    crate::config::encrypt_data_with_key(&value.to_string(), key)
        .map_err(|_| anyhow!("Cannot encrypt operation review"))
}

pub(crate) async fn inspect_review(pool: &sqlx::SqlitePool, operation_id: &str) -> Result<Option<ReviewSummary>> {
    Ok(sqlx::query_as("SELECT decision,attempt_sequence,created_at FROM workflow_operation_reviews WHERE operation_id=? ORDER BY attempt_sequence DESC LIMIT 1")
        .bind(operation_id).fetch_optional(pool).await?)
}
pub(crate) async fn inspect_approval(pool: &sqlx::SqlitePool, operation_id: &str) -> Result<Option<Approval>> {
    let mut approval:Option<Approval>=sqlx::query_as("SELECT id,status,target_name,created_at FROM workflow_compensation_approvals WHERE operation_id=? ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(operation_id).fetch_optional(pool).await?;
    if let Some(approval) = &mut approval
        && approval.status == "pending"
    {
        let ciphertext: String =
            sqlx::query_scalar("SELECT arguments_ciphertext FROM workflow_compensation_approvals WHERE id=?")
                .bind(&approval.id)
                .fetch_one(pool)
                .await?;
        if let Ok(key) = crate::utils::dirs::get_encryption_key()
            && let Ok(raw) = crate::config::decrypt_data_with_key(&ciphertext, &key)
            && let Ok(value) = serde_json::from_str::<Value>(&raw)
        {
            approval.arguments = Some(redact_json(&value));
        }
    }
    Ok(approval)
}

/// Persist approval for one future dispatch. Pre-dispatch retries may reuse a
/// grant, but mark_dispatched consumes it atomically with the dispatch marker.
pub(super) async fn require_approval(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    operation_id: &str,
    name: &str,
    args: &Value,
) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workflow_operations WHERE id=? AND purpose='compensation' AND input_digest=?)",
    )
    .bind(operation_id)
    .bind(operations::digest(args))
    .fetch_one(&mut *tx)
    .await?;
    if !valid {
        bail!("Approval arguments do not match the frozen compensation operation");
    }
    let current: Option<String> = sqlx::query_scalar(
        "SELECT status FROM workflow_compensation_approvals WHERE operation_id=? AND status IN ('pending','granted')",
    )
    .bind(operation_id)
    .fetch_optional(&mut *tx)
    .await?;
    let denied: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM workflow_compensation_approvals WHERE operation_id=? AND status='denied')",
    )
    .bind(operation_id)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("UPDATE workflow_operations SET approval_required=1 WHERE id=? AND purpose='compensation'")
        .bind(operation_id)
        .execute(&mut *tx)
        .await?;
    if current.is_none() && !denied {
        sqlx::query("INSERT INTO workflow_compensation_approvals (id,operation_id,status,target_name,arguments_ciphertext,created_at) VALUES (?,?,'pending',?,?,?)")
            .bind(uuid::Uuid::new_v4().to_string()).bind(operation_id).bind(name).bind(encrypt(args,key)?).bind(chrono::Utc::now().to_rfc3339()).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    if current.as_deref() != Some("granted") {
        bail!("Compensation tool requires approval of the original arguments");
    }
    Ok(())
}

#[cfg(test)]
pub(crate) async fn decide_approval(pool: &sqlx::SqlitePool, run_id: &str, id: &str, approved: bool) -> Result<()> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let available:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_compensation_approvals p JOIN workflow_operations o ON o.id=p.operation_id JOIN workflow_abandonments b ON b.run_id=? WHERE p.id=? AND p.status='pending' AND b.status='blocked' AND o.purpose='compensation' AND o.execution_id=? AND o.status!='running' AND (o.dispatched_at IS NULL OR o.confirmed_no_effect=1))")
        .bind(run_id).bind(id).bind(format!("compensation:{run_id}")).fetch_one(&mut *tx).await?;
    if !available {
        bail!("Compensation approval is stale or execution is still stopping");
    }
    sqlx::query("UPDATE workflow_compensation_approvals SET status=?,resolved_at=? WHERE id=? AND status='pending'")
        .bind(if approved { "granted" } else { "denied" })
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if approved {
        reopen(&mut tx, run_id).await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn reopen(tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>, run_id: &str) -> Result<()> {
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE workflow_abandonments SET status='pending',last_error=NULL,next_check_at=?,updated_at=? WHERE run_id=? AND status='blocked'")
        .bind(&now).bind(&now).bind(run_id).execute(&mut **tx).await?;
    sqlx::query("UPDATE workflow_compensation_intents SET status='pending',last_error=NULL,updated_at=? WHERE status IN ('failed','blocked') AND mode='compensatable' AND operation_id IN (SELECT operation_id FROM workflow_operation_attempts WHERE run_id=?)")
        .bind(now).bind(run_id).execute(&mut **tx).await?;
    Ok(())
}

pub(crate) async fn resolve(
    pool: &sqlx::SqlitePool,
    key: &[u8],
    request: &ReviewRequest,
    verify: impl Fn(&Value) -> Result<()>,
) -> Result<()> {
    if !request.stopped_confirmed || request.evidence.trim().is_empty() || request.evidence.len() > 8000 {
        bail!("Confirm all related execution has stopped and provide reconciliation evidence (maximum 8000 bytes)");
    }
    if serde_json::to_vec(&request.decision)?.len() > 2 * 1024 * 1024 {
        bail!("Imported result exceeds 2 MiB");
    }
    if let Decision::Completed { result } = &request.decision {
        verify(result)?;
    }
    let evidence = encrypt(
        &json!({"evidence":request.evidence,"stoppedConfirmed":true,"decision":request.decision}),
        key,
    )?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row=sqlx::query("SELECT o.*,r.status AS run_status FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id JOIN run_records r ON r.id=a.run_id WHERE o.id=? AND a.run_id=? LIMIT 1")
        .bind(&request.operation_id).bind(&request.run_id).fetch_one(&mut *tx).await?;
    let active:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_operations o JOIN workflow_operation_attempts a ON a.operation_id=o.id WHERE a.run_id=? AND o.status='running') OR EXISTS(SELECT 1 FROM workflow_abandonments WHERE run_id=? AND status IN ('pending','running'))")
        .bind(&request.run_id).bind(&request.run_id).fetch_one(&mut *tx).await?;
    if active
        || matches!(
            row.get::<String, _>("run_status").as_str(),
            "queued" | "running" | "waiting_for_input"
        )
    {
        bail!("Stop execution and wait until the original task and compensation worker are inactive");
    }
    let sequence: i64 =
        sqlx::query_scalar("SELECT MAX(sequence) FROM workflow_operation_attempts WHERE operation_id=?")
            .bind(&request.operation_id)
            .fetch_one(&mut *tx)
            .await?;
    if sequence != request.expected_attempt
        || row.get::<Option<String>, _>("result_json").is_some()
        || !matches!(row.get::<String, _>("status").as_str(), "unknown" | "failed")
        || row.get::<Option<String>, _>("dispatched_at").is_none()
    {
        bail!("Operation changed or already has a confirmed outcome; refresh before reconciling");
    }
    let adapter: String = row.get("adapter");
    if adapter == "subworkflow" {
        bail!("Reconcile child leaf operations individually; container receipts cannot hide descendant effects");
    }
    let purpose: String = row.get("purpose");
    let now = chrono::Utc::now().to_rfc3339();
    let decision = match &request.decision {
        Decision::NoEffect => {
            sqlx::query("UPDATE workflow_operations SET confirmed_no_effect=1,status='pending',adapter_record_id=NULL,last_error_retryable=NULL,updated_at=? WHERE id=?")
                .bind(&now).bind(&request.operation_id).execute(&mut *tx).await?;
            "no_effect"
        },
        Decision::Completed { result } => {
            let saved = if purpose == "compensation" {
                json!({"compensationResultCiphertext":encrypt(result,key)?})
            } else {
                encode_result(&adapter, result, key)?
            };
            let intent: bool =
                sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM workflow_compensation_intents WHERE operation_id=?)")
                    .bind(&request.operation_id)
                    .fetch_one(&mut *tx)
                    .await?;
            if purpose == "execution" && intent {
                saga::capture_outcome(&mut tx, key, &request.operation_id, &saved).await?;
            }
            sqlx::query("UPDATE workflow_operations SET status='succeeded',confirmed_no_effect=0,result_json=?,last_error_retryable=NULL,updated_at=? WHERE id=?")
                .bind(saved.to_string()).bind(&now).bind(&request.operation_id).execute(&mut *tx).await?;
            "completed"
        },
    };
    // Preserve every original attempt and remote identity. A no-effect decision
    // permits a future attempt, not mutation of the historical dispatch fact.
    sqlx::query("INSERT INTO workflow_operation_reviews (id,operation_id,run_id,attempt_sequence,decision,evidence_ciphertext,remote_record_id,created_at) VALUES (?,?,?,?,?,?,?,?)")
        .bind(uuid::Uuid::new_v4().to_string()).bind(&request.operation_id).bind(&request.run_id).bind(sequence).bind(decision).bind(evidence).bind(row.get::<Option<String>,_>("adapter_record_id")).bind(&now).execute(&mut *tx).await?;
    reopen(&mut tx, &request.run_id).await?;
    tx.commit().await?;
    Ok(())
}

fn encode_result(adapter: &str, result: &Value, key: &[u8]) -> Result<Value> {
    Ok(match adapter {
        "tool" => json!({"toolResultCiphertext":encrypt(result,key)?}),
        "process" => {
            if !result["result"].is_object() || result["exitCode"] != 0 {
                bail!("Process receipt requires exitCode 0 and an object result");
            }
            json!({"processResultCiphertext":encrypt(result,key)?})
        },
        "remote_agent" => {
            if !result["response"].is_string() || !result["artifacts"].is_array() {
                bail!("Remote receipt requires response text and artifacts array");
            }
            let mut result = result.clone();
            result["messages"] = json!([{"role":"assistant","content":result["response"]}]);
            redact_json(&result)
        },
        _ => bail!("Adapter does not support manual result import"),
    })
}

#[cfg(test)]
mod tests {
    use super::super::operations::Operation;
    use super::*;

    async fn uncertain(pool: &sqlx::SqlitePool) -> String {
        let mut op = Operation::enter(
            pool.clone(),
            "business",
            "leaf",
            "run-1",
            "tool",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        op.mark_dispatched().await.unwrap();
        op.finish(None, "unknown", Some("connection lost")).await.unwrap();
        sqlx::query("UPDATE run_records SET status='failed' WHERE id='run-1'")
            .execute(pool)
            .await
            .unwrap();
        op.id.clone()
    }
    fn request(id: String, decision: Decision) -> ReviewRequest {
        ReviewRequest {
            run_id: "run-1".into(),
            operation_id: id,
            expected_attempt: 1,
            stopped_confirmed: true,
            evidence: "Provider audit confirms operation stopped".into(),
            decision,
        }
    }

    #[tokio::test]
    async fn confirmed_no_effect_preserves_identity_and_requires_fresh_dispatch() {
        let pool = remote_tasks::test_pool().await;
        let id = uncertain(&pool).await;
        let review = request(id.clone(), Decision::NoEffect);
        resolve(&pool, &[7; 32], &review, |_| Ok(())).await.unwrap();
        assert!(resolve(&pool, &[7; 32], &review, |_| Ok(())).await.is_err());
        let mut next = Operation::enter(
            pool.clone(),
            "business",
            "leaf",
            "run-1",
            "tool",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        assert_eq!(next.id, id);
        assert!(next.can_submit);
        next.mark_dispatched().await.unwrap();
        let cleared: bool = sqlx::query_scalar("SELECT confirmed_no_effect FROM workflow_operations WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!cleared);
        next.finish(None, "unknown", None).await.unwrap();
        assert!(resolve(&pool, &[7; 32], &review, |_| Ok(())).await.is_err());
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM workflow_operation_attempts WHERE operation_id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
    }

    #[tokio::test]
    async fn imported_success_reuses_result_without_overwriting_attempt_history() {
        let pool = remote_tasks::test_pool().await;
        let id = uncertain(&pool).await;
        let review = request(
            id.clone(),
            Decision::Completed {
                result: json!({"resourceId":"original"}),
            },
        );
        assert!(
            resolve(&pool, &[7; 32], &review, |_| bail!("missing artifact"))
                .await
                .is_err()
        );
        resolve(&pool, &[7; 32], &review, |_| Ok(())).await.unwrap();
        let mut next = Operation::enter(
            pool.clone(),
            "business",
            "leaf",
            "run-1",
            "tool",
            &json!({}),
            &json!({}),
        )
        .await
        .unwrap();
        assert!(!next.can_submit);
        let raw = crate::config::decrypt_data_with_key(
            next.result.as_ref().unwrap()["toolResultCiphertext"].as_str().unwrap(),
            &[7; 32],
        )
        .unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap()["resourceId"], "original");
        let saved = next.result.clone().unwrap();
        next.finish(Some(&saved), "succeeded", None).await.unwrap();
        let history: String =
            sqlx::query_scalar("SELECT status FROM workflow_operation_attempts WHERE operation_id=? AND sequence=1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(history, "unknown");
        let evidence: String = sqlx::query_scalar("SELECT evidence_ciphertext FROM workflow_operation_reviews")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(!evidence.contains("Provider audit"));
    }

    #[tokio::test]
    async fn review_rejects_active_tasks_and_rolls_back_with_audit_failure() {
        let pool = remote_tasks::test_pool().await;
        let id = uncertain(&pool).await;
        let review = request(id.clone(), Decision::NoEffect);
        sqlx::query("UPDATE run_records SET status='running' WHERE id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(resolve(&pool, &[7; 32], &review, |_| Ok(())).await.is_err());
        sqlx::query("UPDATE run_records SET status='failed' WHERE id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TRIGGER reject_review BEFORE INSERT ON workflow_operation_reviews BEGIN SELECT RAISE(ABORT,'audit unavailable'); END;").execute(&pool).await.unwrap();
        assert!(resolve(&pool, &[7; 32], &review, |_| Ok(())).await.is_err());
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_operations WHERE id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "unknown");
    }

    #[tokio::test]
    async fn approval_is_bound_to_arguments_and_consumed_once_at_dispatch() {
        let pool = remote_tasks::test_pool().await;
        sqlx::query("INSERT INTO workflow_abandonments (run_id,status,requested_at,updated_at,next_check_at) VALUES ('run-1','blocked','now','now','now')").execute(&pool).await.unwrap();
        let mut op = Operation::enter_compensation(
            pool.clone(),
            "run-1",
            "intent",
            "tool",
            &json!({"id":"original"}),
            &json!({}),
        )
        .await
        .unwrap();
        assert!(
            require_approval(&pool, &[7; 32], &op.id, "Delete", &json!({"id":"different"}))
                .await
                .is_err()
        );
        assert!(
            require_approval(&pool, &[7; 32], &op.id, "Delete", &json!({"id":"original"}))
                .await
                .is_err()
        );
        assert!(op.mark_dispatched().await.is_err());
        op.finish(None, "unknown", None).await.unwrap();
        let id: String = sqlx::query_scalar("SELECT id FROM workflow_compensation_approvals")
            .fetch_one(&pool)
            .await
            .unwrap();
        decide_approval(&pool, "run-1", &id, true).await.unwrap();
        operations::recover_interrupted(&pool).await.unwrap();
        saga_scheduler::recover_startup(&pool).await.unwrap();
        let mut resumed = Operation::enter_compensation(
            pool.clone(),
            "run-1",
            "intent",
            "tool",
            &json!({"id":"original"}),
            &json!({}),
        )
        .await
        .unwrap();
        require_approval(&pool, &[7; 32], &resumed.id, "Delete", &json!({"id":"original"}))
            .await
            .unwrap();
        sqlx::query("UPDATE workflow_operations SET compensation_required=1 WHERE id=?")
            .bind(&resumed.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(resumed.mark_dispatched().await.is_err());
        let retained: String = sqlx::query_scalar("SELECT status FROM workflow_compensation_approvals WHERE id=?")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(retained, "granted");
        sqlx::query("UPDATE workflow_operations SET compensation_required=0 WHERE id=?")
            .bind(&resumed.id)
            .execute(&pool)
            .await
            .unwrap();
        resumed.mark_dispatched().await.unwrap();
        assert!(resumed.mark_dispatched().await.is_err());
        resumed.finish(None, "unknown", None).await.unwrap();
        assert!(decide_approval(&pool, "run-1", &id, true).await.is_err());
        let status: String = sqlx::query_scalar("SELECT status FROM workflow_compensation_approvals WHERE id=?")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "consumed");
        sqlx::query("UPDATE workflow_abandonments SET status='blocked' WHERE run_id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE run_records SET status='failed' WHERE id='run-1'")
            .execute(&pool)
            .await
            .unwrap();
        let mut review = request(resumed.id.clone(), Decision::NoEffect);
        review.expected_attempt = 2;
        resolve(&pool, &[7; 32], &review, |_| Ok(())).await.unwrap();
        let mut retry = Operation::enter_compensation(
            pool.clone(),
            "run-1",
            "intent",
            "tool",
            &json!({"id":"original"}),
            &json!({}),
        )
        .await
        .unwrap();
        assert!(retry.can_submit);
        assert!(
            require_approval(&pool, &[7; 32], &retry.id, "Delete", &json!({"id":"original"}))
                .await
                .is_err()
        );
        assert!(retry.mark_dispatched().await.is_err());
        retry.finish(None, "unknown", None).await.unwrap();
        let statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM workflow_compensation_approvals ORDER BY created_at")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(statuses, ["consumed", "pending"]);
    }
}
