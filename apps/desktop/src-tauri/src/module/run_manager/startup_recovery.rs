//! Business startup recovery, performed before execution workers start.
use crate::{logging, utils::logging::Type};
use anyhow::Result;

/// Coordinates business recovery before execution workers start.
pub(crate) struct StartupRecovery;

impl StartupRecovery {
    /// Reconcile business state after database migration and before dispatch starts.
    /// Compensation plans take precedence over forward execution recovery.
    pub(crate) async fn recover() -> Result<()> {
        let pool = crate::core::db::DBManager::global().pool()?;
        Self::recover_in_pool(&pool).await
    }

    async fn recover_in_pool(pool: &sqlx::SqlitePool) -> Result<()> {
        // A native restart invalidates every renderer-owned claim before the
        // associated run and action are recovered below.
        sqlx::query(
            "UPDATE run_pending_actions SET claimed_by = NULL, claimed_at = NULL WHERE status = 'pending' AND claimed_by IS NOT NULL",
        )
        .execute(pool)
        .await?;

        // 1. Invalidate local execution ownership before rebuilding recovery jobs.
        // Running, waiting-for-input and queued Runs become interrupted. Also
        // close unfinished evaluation batches, expire stale pending actions and
        // release chat-session locks. A queued Run is not automatically restarted
        // just because it is marked interrupted; eligibility is checked below.
        Self::mark_incomplete_runs_interrupted(pool).await?;

        // 2. Invalidate the freshness of remote adapter observations, not the
        // remote execution itself. Submitted/working records become unknown;
        // task IDs, saved results and last-known states remain available. This
        // performs no GetTask or CancelTask request and proves no remote failure.
        crate::module::workflow::mark_remote_tasks_interrupted(pool).await?;

        // 3. Close unfinished Operation Attempts and recover common operation
        // facts independently of the graph checkpoint: a saved result means
        // succeeded; no dispatch (or confirmed no effect) means pending; dispatch
        // without a result means unknown. Applies to execution and compensation
        // operations, preserving the evidence that prevents blind resubmission.
        crate::module::workflow::operations::recover_interrupted(pool).await?;

        // 4. Close unfinished Run Attempts using the Run states established in
        // step 1, release stale recovery claims and retire jobs for terminal Runs.
        // Interrupted Runs with journaled Remote operations receive recovery jobs;
        // the worker still validates their checkpoint frontier before continuing.
        // Failed/stopped Runs are not automatically resumed, and no business work
        // is executed by this startup pass.
        crate::module::run_history::recovery::recover_startup(pool).await?;

        // 5. Reopen interrupted compensation plans/intents and block forward
        // recovery for any Run already entering compensation. This deliberately
        // runs after step 4 so compensation wins over forward recovery. Pending
        // intents are scheduling candidates, not permission to repeat effects:
        // the executor reuses committed results and checks unknown outcomes.
        crate::module::workflow::saga_scheduler::recover_startup(pool).await?;

        Ok(())
    }

    async fn mark_incomplete_runs_interrupted(pool: &sqlx::SqlitePool) -> Result<()> {
        // A native restart destroys running execution sessions and their paused
        // in-memory execution owners. Mark records first; the journal-aware
        // recovery scheduler validates durable checkpoints before continuing
        // the same task. Unjournaled executors remain a manual decision.
        let recovered_at = chrono::Utc::now().to_rfc3339();
        let active_runs = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status IN ('running', 'waiting_for_input')",
        )
        .bind(&recovered_at)
        .bind("Execution ended when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        let queued_runs = sqlx::query(
            "UPDATE run_records SET status = 'interrupted', ended_at = ?, error = ?, updated_at = ? WHERE status = 'queued'",
        )
        .bind(&recovered_at)
        .bind("Execution did not start before Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        // Evaluation batches cannot survive a native restart: a queued batch
        // may have crashed before it created its first workflow Run. Close by
        // batch status, not only by Run linkage, so no history entry waits
        // forever for a coordinator that no longer exists.
        sqlx::query(
            "UPDATE evaluation_case_results SET execution_status = 'failed', verdict = 'error', failure_reason = ?, updated_at = ? WHERE execution_status = 'running' AND evaluation_run_id IN (SELECT id FROM evaluation_runs WHERE status IN ('queued', 'running'))",
        )
        .bind("Evaluation execution ended when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE evaluation_case_results SET execution_status = 'cancelled', verdict = 'skipped', failure_reason = ?, updated_at = ? WHERE execution_status = 'queued' AND evaluation_run_id IN (SELECT id FROM evaluation_runs WHERE status IN ('queued', 'running'))",
        )
        .bind("Evaluation batch stopped when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE evaluation_runs SET status = 'failed', ended_at = ?, duration_ms = CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER), failed_cases = (SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = evaluation_runs.id AND verdict IN ('failed', 'error')), error = ?, updated_at = ? WHERE status IN ('queued', 'running')",
        )
        .bind(&recovered_at)
        .bind(&recovered_at)
        .bind("Evaluation batch stopped when Workrun restarted.")
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        // A pending action only has meaning while its native session is alive.
        // Expire it with the recovered run so the global attention queue cannot
        // offer a decision that can no longer be applied.
        sqlx::query(
            "UPDATE run_pending_actions SET status = 'expired' WHERE status = 'pending' AND run_id IN (SELECT id FROM run_records WHERE status = 'interrupted' AND error = 'Execution ended when Workrun restarted.')",
        )
        .execute(pool)
        .await?;
        let interrupted = active_runs.rows_affected() + queued_runs.rows_affected();
        // Chat sessions must not retain a lock for a native execution that was
        // interrupted during restart; their transcript remains recoverable.
        sqlx::query(
            "UPDATE chat_turns SET status = 'interrupted', completed_at = ? WHERE run_id IN (SELECT id FROM run_records WHERE status = 'interrupted' AND error IN ('Execution ended when Workrun restarted.', 'Execution did not start before Workrun restarted.'))",
        )
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        sqlx::query(
            "UPDATE chat_sessions SET active_run_id = NULL, updated_at = ? WHERE active_run_id IN (SELECT id FROM run_records WHERE status = 'interrupted' AND error IN ('Execution ended when Workrun restarted.', 'Execution did not start before Workrun restarted.'))",
        )
        .bind(&recovered_at)
        .execute(pool)
        .await?;
        if interrupted > 0 {
            logging!(
                info,
                Type::Setup,
                "Marked {} incomplete run(s) as interrupted",
                interrupted
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::StartupRecovery;
    use sqlx::sqlite::SqlitePoolOptions;

    #[tokio::test]
    async fn restart_interrupts_active_and_queued_runs() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE run_records (id TEXT PRIMARY KEY, status TEXT NOT NULL, ended_at TEXT, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE run_pending_actions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL)",
        )
        .execute(&pool)
        .await
        .unwrap();
        // Recovery updates chat turn/session locks alongside run records.
        // Keep this lightweight test schema aligned with that contract.
        sqlx::query("CREATE TABLE chat_turns (run_id TEXT PRIMARY KEY, status TEXT NOT NULL, completed_at TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, active_run_id TEXT, updated_at TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "CREATE TABLE evaluation_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER, failed_cases INTEGER NOT NULL DEFAULT 0, error TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "CREATE TABLE evaluation_case_results (id TEXT PRIMARY KEY, evaluation_run_id TEXT NOT NULL, workflow_run_id TEXT, execution_status TEXT NOT NULL, verdict TEXT NOT NULL, failure_reason TEXT, updated_at TEXT)",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-1', 'waiting_for_input')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO run_records (id, status) VALUES ('run-2', 'queued')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, status, started_at) VALUES ('evaluation-1', 'running', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_runs (id, status, started_at) VALUES ('evaluation-2', 'queued', '2026-01-01T00:00:00Z')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, workflow_run_id, execution_status, verdict) VALUES ('case-1', 'evaluation-1', 'run-1', 'running', 'pending'), ('case-2', 'evaluation-1', NULL, 'queued', 'pending')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO evaluation_case_results (id, evaluation_run_id, workflow_run_id, execution_status, verdict) VALUES ('case-3', 'evaluation-2', NULL, 'queued', 'pending')")
            .execute(&pool)
            .await
            .unwrap();
        for (id, kind) in [
            ("question", "ask_user_question"),
            ("review", "human_review"),
            ("approval", "tool_approval"),
        ] {
            sqlx::query("INSERT INTO run_pending_actions (id, run_id, kind, status) VALUES (?, 'run-1', ?, 'pending')")
                .bind(id)
                .bind(kind)
                .execute(&pool)
                .await
                .unwrap();
        }

        StartupRecovery::mark_incomplete_runs_interrupted(&pool).await.unwrap();

        let status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
        let expired: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM run_pending_actions WHERE run_id = 'run-1' AND status = 'expired'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(status, "interrupted");
        assert_eq!(expired, 3);
        let queued_status: String = sqlx::query_scalar("SELECT status FROM run_records WHERE id = 'run-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(queued_status, "interrupted");
        let queued_error: String = sqlx::query_scalar("SELECT error FROM run_records WHERE id = 'run-2'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(queued_error, "Execution did not start before Workrun restarted.");
        let evaluation_status: String =
            sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = 'evaluation-1'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let failed_cases: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM evaluation_case_results WHERE evaluation_run_id = 'evaluation-1' AND verdict IN ('error', 'skipped')")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(evaluation_status, "failed");
        assert_eq!(failed_cases, 2);
        let queued_evaluation_status: String =
            sqlx::query_scalar("SELECT status FROM evaluation_runs WHERE id = 'evaluation-2'")
                .fetch_one(&pool)
                .await
                .unwrap();
        let queued_case: (String, String) =
            sqlx::query_as("SELECT execution_status, verdict FROM evaluation_case_results WHERE id = 'case-3'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(queued_evaluation_status, "failed");
        assert_eq!(queued_case, ("cancelled".to_string(), "skipped".to_string()));
    }
}
