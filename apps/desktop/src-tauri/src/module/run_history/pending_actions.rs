use super::*;

impl RunHistoryStore {
    pub async fn create_pending_action(action: CreatePendingAction) -> Result<()> {
        if action.id.trim().is_empty() || action.run_id.trim().is_empty() {
            bail!("pending action id and run id are required");
        }
        let pool = DBManager::global().pool()?;
        let mut transaction = pool.begin().await?;
        sqlx::query(
            "INSERT INTO run_pending_actions (id, run_id, kind, payload_json, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
        )
        .bind(&action.id)
        .bind(&action.run_id)
        .bind(action.kind.as_str())
        .bind(action.payload.to_string())
        .bind(&action.created_at)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE run_records SET status = 'waiting_for_input', updated_at = ? WHERE id = ?")
            .bind(chrono::Utc::now().to_rfc3339())
            .bind(&action.run_id)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        Ok(())
    }

    pub async fn list_pending_actions(run_id: Option<&str>) -> Result<Vec<PendingAction>> {
        let pool = DBManager::global().pool()?;
        if let Some(run_id) = run_id {
            Self::ensure_active_workspace(run_id).await?;
        }
        let mut query = QueryBuilder::<Sqlite>::new(
            "SELECT id, run_id, kind, payload_json, status, created_at, resolution_json, resolved_at FROM run_pending_actions WHERE run_id IN (SELECT id FROM run_records WHERE workspace_id = ",
        );
        query.push_bind(crate::utils::dirs::active_workspace_id()).push(")");
        if let Some(run_id) = run_id {
            // A run view includes decisions and invalidated requests as history.
            query.push(" AND run_id = ").push_bind(run_id);
        } else {
            query.push(" AND status = 'pending'");
        }
        let rows = query
            .push(" ORDER BY created_at ASC, id ASC")
            .build()
            .fetch_all(&pool)
            .await?;
        rows.iter().map(pending_action_from_row).collect()
    }

    /// Viewing never reserves a request. Reserve only the explicitly submitted
    /// ID, before touching its checkpoint, so concurrent windows cannot apply
    /// two different decisions to the same workflow.
    pub async fn claim_pending_action(id: &str, claimant_id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        claim_pending_action_for_workspace(&pool, id, claimant_id, &crate::utils::dirs::active_workspace_id()).await
    }

    pub async fn release_pending_action(id: &str, claimant_id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        ensure_pending_action_workspace(&pool, id).await?;
        let result = sqlx::query(
            "UPDATE run_pending_actions SET claimed_by = NULL, claimed_at = NULL WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(id)
        .bind(claimant_id)
        .execute(&pool)
        .await?;
        if result.rows_affected() == 0 {
            bail!("pending action is no longer claimed by this coordinator: {id}");
        }
        Ok(())
    }

    pub async fn get_pending_action(id: &str) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        ensure_pending_action_workspace(&pool, id).await?;
        let row = sqlx::query("SELECT id, run_id, kind, payload_json, status, created_at, resolution_json, resolved_at FROM run_pending_actions WHERE id = ? AND status = 'pending'")
            .bind(id).fetch_optional(&pool).await?.context("Request is no longer pending")?;
        pending_action_from_row(&row)
    }

    pub async fn inspect_pending_action(id: &str, claimant_id: &str) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        ensure_pending_action_workspace(&pool, id).await?;
        let row = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at, resolution_json, resolved_at FROM run_pending_actions WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(id)
        .bind(claimant_id)
        .fetch_optional(&pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("pending action is no longer claimed by this coordinator: {id}"))?;
        pending_action_from_row(&row)
    }

    /// Resolve a claimed action and put its workflow back in the native queue.
    /// The resume recipe is persisted in the same transaction, so a renderer
    /// cannot race a dispatcher into resuming with stale confirmation data.
    pub async fn resolve_claimed_action_and_enqueue(
        id: &str,
        claimant_id: &str,
        resolution: Value,
        runtime: Value,
    ) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        ensure_pending_action_workspace(&pool, id).await?;
        resolve_claimed_action_and_enqueue_in_pool(&pool, id, claimant_id, resolution, runtime).await
    }

    /// Cancelling is only used for a paused run, so every unresolved prompt
    /// belonging to that run must become unavailable before it can be resumed.
    pub async fn cancel_pending_actions(run_id: &str) -> Result<()> {
        let pool = DBManager::global().pool()?;
        sqlx::query(
            "UPDATE run_pending_actions SET status = 'cancelled', resolved_at = ? WHERE run_id = ? AND status = 'pending'",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(run_id)
        .execute(&pool)
        .await?;
        Ok(())
    }
}

// Keep the transaction callable against an isolated database for failure tests.
async fn resolve_claimed_action_and_enqueue_in_pool(
    pool: &sqlx::SqlitePool,
    id: &str,
    claimant_id: &str,
    resolution: Value,
    runtime: Value,
) -> Result<PendingAction> {
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    let run_id = sqlx::query_scalar::<_, String>("SELECT run_id FROM run_pending_actions WHERE id = ?")
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
    crate::module::workflow::saga_scheduler::ensure_continuable(&mut transaction, &run_id).await?;
    let result = sqlx::query(
            "UPDATE run_pending_actions SET status = 'resolved', resolved_at = ?, resolution_json = ? WHERE id = ? AND status = 'pending' AND claimed_by = ?",
        )
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(resolution.to_string())
        .bind(id)
        .bind(claimant_id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        bail!("pending action is no longer available: {id}");
    }
    let row = sqlx::query(
            "SELECT id, run_id, kind, payload_json, status, created_at, resolution_json, resolved_at FROM run_pending_actions WHERE id = ?",
        )
        .bind(id)
        .fetch_one(&mut *transaction)
        .await?;
    let action = pending_action_from_row(&row)?;
    let result = sqlx::query(
            "UPDATE run_records SET status = 'queued', ended_at = NULL, error = NULL, runtime_json = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_input'",
        )
        .bind(runtime.to_string())
        .bind(chrono::Utc::now().to_rfc3339())
        .bind(&action.run_id)
        .execute(&mut *transaction)
        .await?;
    if result.rows_affected() == 0 {
        bail!("workflow is no longer waiting for input: {}", action.run_id);
    }
    transaction.commit().await?;
    Ok(action)
}

pub(super) fn pending_action_from_row(row: &sqlx::sqlite::SqliteRow) -> Result<PendingAction> {
    Ok(PendingAction {
        id: row.try_get("id")?,
        run_id: row.try_get("run_id")?,
        kind: row.try_get("kind")?,
        payload: json_column(row.try_get("payload_json")?)?,
        status: row.try_get("status")?,
        created_at: row.try_get("created_at")?,
        resolution: row
            .try_get::<Option<String>, _>("resolution_json")?
            .map(json_column)
            .transpose()?,
        resolved_at: row.try_get("resolved_at")?,
    })
}

fn json_column(value: String) -> Result<Value> {
    serde_json::from_str(&value).context("stored run history contains invalid JSON")
}

async fn ensure_pending_action_workspace(pool: &sqlx::SqlitePool, id: &str) -> Result<()> {
    let owned: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.id = ? AND r.workspace_id = ?)")
        .bind(id).bind(crate::utils::dirs::active_workspace_id()).fetch_one(pool).await?;
    if !owned {
        bail!("pending action was not found in the active workspace: {id}");
    }
    Ok(())
}

pub(super) async fn claim_pending_action_for_workspace(
    pool: &sqlx::SqlitePool,
    id: &str,
    claimant_id: &str,
    workspace_id: &str,
) -> Result<()> {
    if claimant_id.trim().is_empty() {
        bail!("pending action claimant is required");
    }
    let result = sqlx::query(
        "UPDATE run_pending_actions SET claimed_by = ?, claimed_at = ? WHERE id = ? AND status = 'pending' AND claimed_by IS NULL AND run_id IN (SELECT id FROM run_records WHERE workspace_id = ? AND status = 'waiting_for_input') AND NOT EXISTS (SELECT 1 FROM run_pending_actions other WHERE other.run_id = run_pending_actions.run_id AND other.status = 'pending' AND other.claimed_by IS NOT NULL)",
    )
    .bind(claimant_id)
    .bind(chrono::Utc::now().to_rfc3339())
    .bind(id)
    .bind(workspace_id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        bail!("pending action is no longer available or is being submitted: {id}");
    }
    Ok(())
}

#[cfg(test)]
mod selected_action_tests {
    use super::*;

    #[tokio::test]
    async fn selected_claims_skip_queue_order_and_exclude_other_windows_and_workspaces() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE run_records (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT, status TEXT, claimed_by TEXT, claimed_at TEXT)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO run_records VALUES ('first', 'personal', 'waiting_for_input'), ('second', 'personal', 'waiting_for_input'), ('team', 'team:default', 'waiting_for_input'), ('cancelled', 'personal', 'cancelled')").execute(&pool).await.unwrap();
        for id in ["first", "second", "team", "cancelled"] {
            sqlx::query("INSERT INTO run_pending_actions (id, run_id, status) VALUES (?, ?, 'pending')")
                .bind(id)
                .bind(id)
                .execute(&pool)
                .await
                .unwrap();
        }
        // A newer request may be submitted without touching the oldest one.
        claim_pending_action_for_workspace(&pool, "second", "window-a", "personal")
            .await
            .unwrap();
        let oldest_owner: Option<String> =
            sqlx::query_scalar("SELECT claimed_by FROM run_pending_actions WHERE id = 'first'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(oldest_owner.is_none());
        sqlx::query("INSERT INTO run_pending_actions (id, run_id, status) VALUES ('same-run', 'second', 'pending')")
            .execute(&pool)
            .await
            .unwrap();
        // Different prompts must not mutate one checkpoint concurrently either.
        assert!(
            claim_pending_action_for_workspace(&pool, "same-run", "window-b", "personal")
                .await
                .is_err()
        );
        assert!(
            claim_pending_action_for_workspace(&pool, "second", "window-b", "personal")
                .await
                .is_err()
        );
        assert!(
            claim_pending_action_for_workspace(&pool, "second", "window-a", "personal")
                .await
                .is_err()
        );
        assert!(
            claim_pending_action_for_workspace(&pool, "team", "window-a", "personal")
                .await
                .is_err()
        );
        assert!(
            claim_pending_action_for_workspace(&pool, "cancelled", "window-a", "personal")
                .await
                .is_err()
        );
        sqlx::query("UPDATE run_pending_actions SET status = 'resolved', claimed_by = NULL WHERE id = 'second'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            claim_pending_action_for_workspace(&pool, "second", "window-b", "personal")
                .await
                .is_err()
        );
        claim_pending_action_for_workspace(&pool, "first", "window-b", "personal")
            .await
            .unwrap();
    }
}

#[cfg(test)]
mod resolution_tests {
    use super::*;
    use serde_json::json;

    async fn pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE run_records (id TEXT PRIMARY KEY, workspace_id TEXT, status TEXT, ended_at TEXT, error TEXT, runtime_json TEXT, updated_at TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT, kind TEXT, payload_json TEXT, status TEXT, created_at TEXT, claimed_by TEXT, claimed_at TEXT, resolved_at TEXT, resolution_json TEXT)").execute(&pool).await.unwrap();
        sqlx::query("CREATE TABLE workflow_abandonments (run_id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO run_records VALUES ('run', 'personal', 'waiting_for_input', 'old-end', 'old-error', '{}', NULL)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO run_pending_actions (id, run_id, kind, payload_json, status, created_at) VALUES ('action', 'run', 'human_review', '{}', 'pending', '2026-10-11')").execute(&pool).await.unwrap();
        claim_pending_action_for_workspace(&pool, "action", "owner", "personal")
            .await
            .unwrap();
        pool
    }

    async fn resolve(pool: &sqlx::SqlitePool, owner: &str) -> Result<PendingAction> {
        resolve_claimed_action_and_enqueue_in_pool(
            pool,
            "action",
            owner,
            json!({"approved": true}),
            json!({"resume": true, "pendingCheckpointUpdate":{"updates":[["approved",true]],"workflowContext":null}}),
        )
        .await
    }

    async fn assert_unresolved(pool: &sqlx::SqlitePool, run_status: &str) {
        let action: (String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT status, resolution_json, resolved_at FROM run_pending_actions WHERE id = 'action'")
                .fetch_one(pool)
                .await
                .unwrap();
        assert_eq!(action, ("pending".into(), None, None));
        let run: (String, String) = sqlx::query_as("SELECT status, runtime_json FROM run_records WHERE id = 'run'")
            .fetch_one(pool)
            .await
            .unwrap();
        assert_eq!(run, (run_status.into(), "{}".into()));
    }

    #[tokio::test]
    async fn persistence_failure_rolls_back_decision_and_allows_retry() {
        let pool = pool().await;
        // Fail after the action UPDATE, at the second write in the transaction.
        sqlx::query("CREATE TRIGGER fail_enqueue BEFORE UPDATE OF status ON run_records WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'injected enqueue failure'); END").execute(&pool).await.unwrap();
        let error = resolve(&pool, "owner").await.unwrap_err();
        assert!(error.to_string().contains("injected enqueue failure"));
        assert_unresolved(&pool, "waiting_for_input").await;
        sqlx::query("DROP TRIGGER fail_enqueue").execute(&pool).await.unwrap();
        let action = resolve(&pool, "owner").await.unwrap();
        assert_eq!(action.status, "resolved");
        assert_eq!(action.resolution, Some(json!({"approved": true})));
        let runtime: String = sqlx::query_scalar("SELECT runtime_json FROM run_records WHERE id = 'run'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&runtime).unwrap()["pendingCheckpointUpdate"]["updates"],
            json!([["approved", true]])
        );
        assert!(action.resolved_at.is_some());
        let run: (String, String, Option<String>, Option<String>) =
            sqlx::query_as("SELECT status, runtime_json, ended_at, error FROM run_records WHERE id = 'run'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(run, ("queued".into(), runtime, None, None));
    }

    #[tokio::test]
    async fn cancellation_after_claim_cannot_be_overwritten_by_submission() {
        let pool = pool().await;
        // Exercise the gap after cancellation changes the run but before its
        // pending actions are invalidated: the run CAS must roll back approval.
        sqlx::query("UPDATE run_records SET status = 'cancelled' WHERE id = 'run'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            resolve(&pool, "owner")
                .await
                .unwrap_err()
                .to_string()
                .contains("no longer waiting")
        );
        assert_unresolved(&pool, "cancelled").await;
    }

    #[tokio::test]
    async fn wrong_owner_and_expired_requests_cannot_enqueue() {
        let pool = pool().await;
        assert!(resolve(&pool, "other-window").await.is_err());
        assert_unresolved(&pool, "waiting_for_input").await;
        sqlx::query("UPDATE run_pending_actions SET status = 'expired' WHERE id = 'action'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(resolve(&pool, "owner").await.is_err());
        let state: (String, Option<String>) =
            sqlx::query_as("SELECT status, resolution_json FROM run_pending_actions WHERE id = 'action'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(state, ("expired".into(), None));
        let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(status, "waiting_for_input");
    }

    #[tokio::test]
    async fn compensation_started_after_claim_blocks_submission() {
        let pool = pool().await;
        sqlx::query("INSERT INTO workflow_abandonments VALUES ('run')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            resolve(&pool, "owner")
                .await
                .unwrap_err()
                .to_string()
                .contains("compensation")
        );
        assert_unresolved(&pool, "waiting_for_input").await;
    }

    #[tokio::test]
    async fn concurrent_duplicate_submissions_commit_only_once() {
        let pool = pool().await;
        let (first, second) = tokio::join!(resolve(&pool, "owner"), resolve(&pool, "owner"));
        assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
        let action: (String, String) =
            sqlx::query_as("SELECT status, resolution_json FROM run_pending_actions WHERE id = 'action'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(action, ("resolved".into(), json!({"approved": true}).to_string()));
    }
}
