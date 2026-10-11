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

    /// Atomically reserve the oldest unclaimed action for one UI coordinator.
    /// A transaction is necessary because multiple webviews may observe the
    /// same queue before either has rendered its Drawer.
    pub async fn claim_next_pending_action(claimant_id: &str) -> Result<Option<PendingAction>> {
        let pool = DBManager::global().pool()?;
        claim_next_pending_action_from_pool(&pool, claimant_id).await
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

    pub async fn resolve_pending_action(
        id: &str,
        claimant_id: Option<&str>,
        resolution: Value,
    ) -> Result<PendingAction> {
        let pool = DBManager::global().pool()?;
        ensure_pending_action_workspace(&pool, id).await?;
        let mut transaction = pool.begin().await?;
        // A claimed action may only be resolved by its owner. The unclaimed
        // branch preserves the existing command's compatibility for callers
        // that do not render a global approval surface.
        let mut query =
            QueryBuilder::<Sqlite>::new("UPDATE run_pending_actions SET status = 'resolved', resolved_at = ");
        query
            .push_bind(chrono::Utc::now().to_rfc3339())
            .push(", resolution_json = ")
            .push_bind(resolution.to_string())
            .push(" WHERE id = ")
            .push_bind(id)
            .push(" AND status = 'pending'");
        if let Some(claimant_id) = claimant_id {
            query.push(" AND claimed_by = ").push_bind(claimant_id);
        } else {
            query.push(" AND claimed_by IS NULL");
        }
        let result = query.build().execute(&mut *transaction).await?;
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
        transaction.commit().await?;
        Ok(action)
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
        let mut transaction = pool.begin().await?;
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

pub(super) async fn claim_next_pending_action_from_pool(
    pool: &sqlx::SqlitePool,
    claimant_id: &str,
) -> Result<Option<PendingAction>> {
    claim_next_pending_action_for_workspace(pool, claimant_id, &crate::utils::dirs::active_workspace_id()).await
}

pub(super) async fn claim_next_pending_action_for_workspace(
    pool: &sqlx::SqlitePool,
    claimant_id: &str,
    workspace_id: &str,
) -> Result<Option<PendingAction>> {
    if claimant_id.trim().is_empty() {
        bail!("pending action claimant is required");
    }
    // This read-then-write operation must reserve SQLite's single writer at
    // the start. A deferred transaction can read while the event writer owns
    // the write lock, then fail immediately when upgrading to UPDATE.
    let mut transaction = pool.begin_with("BEGIN IMMEDIATE").await?;
    // Renderer reloads retain their session claimant ID. Return its existing
    // reservation first, because the previous page may have been destroyed
    // before its asynchronous release command reached the native process.
    if let Some(row) = sqlx::query(
        "SELECT a.id, a.run_id, a.kind, a.payload_json, a.status, a.created_at, a.resolution_json, a.resolved_at FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.status = 'pending' AND a.claimed_by = ? AND r.workspace_id = ? AND r.status = 'waiting_for_input' ORDER BY a.created_at ASC, a.id ASC LIMIT 1",
    )
    .bind(claimant_id)
    .bind(workspace_id)
    .fetch_optional(&mut *transaction)
    .await?
    {
        transaction.commit().await?;
        return Ok(Some(pending_action_from_row(&row)?));
    }
    let claimed_at = chrono::Utc::now().to_rfc3339();
    let result = sqlx::query(
        "UPDATE run_pending_actions SET claimed_by = ?, claimed_at = ? WHERE id = (SELECT a.id FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.status = 'pending' AND a.claimed_by IS NULL AND r.workspace_id = ? AND r.status = 'waiting_for_input' ORDER BY a.created_at ASC, a.id ASC LIMIT 1) AND status = 'pending' AND claimed_by IS NULL",
    )
    .bind(claimant_id)
    .bind(&claimed_at)
    .bind(workspace_id)
    .execute(&mut *transaction)
    .await?;
    if result.rows_affected() == 0 {
        transaction.commit().await?;
        return Ok(None);
    }
    let row = sqlx::query(
        "SELECT a.id, a.run_id, a.kind, a.payload_json, a.status, a.created_at, a.resolution_json, a.resolved_at FROM run_pending_actions a JOIN run_records r ON r.id = a.run_id WHERE a.claimed_by = ? AND a.claimed_at = ? AND r.workspace_id = ? AND r.status = 'waiting_for_input'",
    )
    .bind(claimant_id)
    .bind(&claimed_at)
    .bind(workspace_id)
    .fetch_one(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(Some(pending_action_from_row(&row)?))
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

async fn claim_pending_action_for_workspace(
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
