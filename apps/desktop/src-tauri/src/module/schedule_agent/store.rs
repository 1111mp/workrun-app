//! Native schedule views and optimistic, atomic changes shared by the task center and agent.
use crate::module::{assistant::catalog::Catalog, schedule};
use anyhow::{Context, Result, ensure};
use chrono::Utc;
use serde_json::{Value, json};
use sqlx::{Row, SqlitePool};

pub(super) struct SchedulingStore {
    pool: SqlitePool,
    workspace: String,
}

impl SchedulingStore {
    pub fn new(pool: SqlitePool, workspace: String) -> Self {
        Self { pool, workspace }
    }

    pub fn workspace(&self) -> &str {
        &self.workspace
    }

    pub fn ensure_active(&self) -> Result<()> {
        ensure!(
            crate::utils::dirs::active_workspace_id() == self.workspace,
            "Workspace changed"
        );
        Ok(())
    }
    pub async fn list(&self) -> Result<Value> {
        let rows = sqlx::query("SELECT s.*, (SELECT COALESCE(r.status, o.status) FROM schedule_occurrences o LEFT JOIN run_records r ON r.id=o.run_id AND r.workspace_id=s.workspace_id WHERE o.schedule_id=s.id ORDER BY o.scheduled_for DESC LIMIT 1) AS last_status FROM schedules s WHERE s.workspace_id=? ORDER BY s.enabled DESC, s.next_run_at, s.id")
            .bind(&self.workspace).fetch_all(&self.pool).await?;
        Ok(json!(rows.iter().map(Self::view).collect::<Result<Vec<_>>>()?))
    }

    fn view(row: &sqlx::sqlite::SqliteRow) -> Result<Value> {
        let recipe: Value = serde_json::from_str(row.try_get("execution_recipe_json")?)?;
        Ok(json!({
            "id":row.try_get::<String,_>("id")?, "name":row.try_get::<String,_>("name")?,
            "targetType":row.try_get::<String,_>("target_type")?, "targetId":row.try_get::<String,_>("target_id")?,
            "targetName":row.try_get::<String,_>("target_name")?, "cronExpression":row.try_get::<String,_>("cron_expression")?,
            "timezone":row.try_get::<String,_>("timezone")?, "enabled":row.try_get::<bool,_>("enabled")?,
            "nextRunAt":row.try_get::<String,_>("next_run_at")?, "lastRunAt":row.try_get::<Option<String>,_>("last_run_at")?,
            "lastError":row.try_get::<Option<String>,_>("last_error")?, "version":row.try_get::<String,_>("updated_at")?,
            "lastStatus":row.try_get::<Option<String>,_>("last_status").ok().flatten(),
            "input":recipe.get("input"), "source":recipe.get("source"),
            "scheduleKind":row.try_get::<String,_>("schedule_kind")?, "runAt":row.try_get::<Option<String>,_>("run_at")?,
            "finishedAt":row.try_get::<Option<String>,_>("finished_at")?, "finishReason":row.try_get::<Option<String>,_>("finish_reason")?
        }))
    }

    pub async fn raw(&self, id: &str) -> Result<Value> {
        let row = sqlx::query("SELECT * FROM schedules WHERE workspace_id=? AND id=?")
            .bind(&self.workspace)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .context("Schedule was not found in this workspace")?;
        let mut value = Self::view(&row)?;
        value["snapshot"] = serde_json::from_str(row.try_get("target_snapshot_json")?)?;
        value["recipe"] = serde_json::from_str(row.try_get("execution_recipe_json")?)?;
        Ok(value)
    }

    pub async fn detail(&self, id: &str) -> Result<Value> {
        let mut value = self.raw(id).await?;
        value.as_object_mut().unwrap().remove("snapshot");
        value.as_object_mut().unwrap().remove("recipe");
        let rows = sqlx::query("SELECT o.*, r.status AS run_status, r.error AS run_error FROM schedule_occurrences o LEFT JOIN run_records r ON r.id=o.run_id AND r.workspace_id=? WHERE o.schedule_id=? ORDER BY o.scheduled_for DESC LIMIT 30")
            .bind(&self.workspace).bind(id).fetch_all(&self.pool).await?;
        value["occurrences"] = json!(rows.iter().map(|r| -> Result<Value> { Ok(json!({
            "id":r.try_get::<String,_>("id")?, "scheduledFor":r.try_get::<String,_>("scheduled_for")?,
            "status":r.try_get::<Option<String>,_>("run_status")?.unwrap_or(r.try_get("status")?),
            "runId":r.try_get::<Option<String>,_>("run_id")?, "reason":r.try_get::<Option<String>,_>("reason")?,
            "error":r.try_get::<Option<String>,_>("error")?.or(r.try_get::<Option<String>,_>("run_error")?)
        })) }).collect::<Result<Vec<_>>>()?);
        Ok(value)
    }

    pub async fn inspect_target(catalog: &Catalog, kind: &str, id: &str) -> Result<Value> {
        let encoded: String = url::form_urlencoded::byte_serialize(id.as_bytes()).collect();
        if kind == "app" {
            let app = crate::feat::process_node_inspect(id).await?;
            let reason = if !matches!(
                app.install_status,
                crate::module::process_node::ProcessNodeInstallStatus::Installed
            ) {
                Some("Install this App before scheduling it.")
            } else if app.definition.kind != crate::config::ProcessNodeKind::Workflow {
                Some("This App is a tool for Agents and cannot run independently on a schedule.")
            } else {
                None
            };
            Ok(
                json!({"id":id,"kind":"app","name":app.definition.name,"snapshot":app.definition,"inputSchema":{},"acceptsInput":false,"schedulable":reason.is_none(),"reason":reason,"action":{"label":"Open App","url":format!("/apps/{}",encoded)}}),
            )
        } else {
            ensure!(kind == "workflow", "Unknown target type");
            let workflow = catalog.resolve(id).await?;
            let document = &workflow["document"];
            let reason = schedule::validate_unattended_workflow(document).err().map(|_| "This workflow contains human review or user question nodes. Scheduled workflows must finish without interactive input.");
            // Verify that the saved graph is a valid execution definition, without installing or running it.
            crate::module::assistant::catalog::document_dsl(&workflow)?;
            Ok(json!({"id":id,"kind":"workflow","name":document["settings"]["name"],
                "snapshot":document,"inputSchema":crate::module::assistant::catalog::parameters(&document["settings"]),"schedulable":reason.is_none(),"reason":reason,"action":{"label":"Open workflow","url":format!("/workflows/{}",encoded)}}))
        }
    }

    pub async fn target(catalog: &Catalog, kind: &str, id: &str) -> Result<Value> {
        let selected = Self::inspect_target(catalog, kind, id).await?;
        ensure!(
            selected["schedulable"] == true,
            "{}",
            selected["reason"].as_str().unwrap_or("This target cannot be scheduled")
        );
        Ok(selected)
    }

    fn new_recipe(&self, kind: &str) -> Result<Value> {
        if kind == "workflow" {
            Ok(serde_json::to_value(schedule::WorkflowExecutionRecipe {
                team_model_owner: crate::module::team_model::stored_owner(&self.workspace),
                source: if self.workspace.starts_with("team:") {
                    schedule::WorkflowScheduleSource::LatestPublished
                } else {
                    schedule::WorkflowScheduleSource::LatestLocal
                },
                input: json!({}),
                initial_state: json!({}),
                editor_mode: Some("custom".into()),
            })?)
        } else {
            Ok(json!({"editorMode":"custom"}))
        }
    }

    pub async fn preview(&self, catalog: &Catalog, args: &Value) -> Result<Value> {
        let operation = args["operation"].as_str().context("operation is required")?;
        ensure!(
            ["create", "update", "pause", "resume", "delete"].contains(&operation),
            "Unsupported schedule operation"
        );
        let before = if operation == "create" {
            Value::Null
        } else {
            self.raw(args["id"].as_str().context("Schedule ID is required")?)
                .await?
        };
        if let Some(expected) = args["version"].as_str() {
            ensure!(
                before["version"] == expected,
                "Schedule changed. Refresh and preview again."
            );
        }
        let mut after = before.clone();
        if operation == "create" {
            let kind = args["targetType"].as_str().context("Choose an App or Workflow")?;
            let id = args["targetId"].as_str().context("Choose an App or Workflow")?;
            let selected = Self::target(catalog, kind, id).await?;
            after = json!({"id":uuid::Uuid::new_v4().to_string(), "targetType":kind,"targetId":id,
                "targetName":selected["name"],"snapshot":selected["snapshot"],"enabled":true,
                "recipe":self.new_recipe(kind)?});
        }
        if matches!(operation, "update" | "resume") && after["recipe"]["source"]["kind"] != "published_release" {
            let selected = Self::target(
                catalog,
                after["targetType"].as_str().context("Missing target type")?,
                after["targetId"].as_str().context("Missing target ID")?,
            )
            .await?;
            after["snapshot"] = selected["snapshot"].clone();
            after["targetName"] = selected["name"].clone();
        }
        if matches!(operation, "create" | "update") {
            for field in ["name", "timezone"] {
                if let Some(value) = args.get(field) {
                    after[field] = value.clone();
                }
                ensure!(
                    after[field].as_str().is_some_and(|s| !s.trim().is_empty()),
                    "{field} is required"
                );
            }
            if let Some(input) = args.get("input") {
                ensure!(input.is_object(), "Workflow input must be an object");
                ensure!(
                    after["targetType"] == "workflow" || input.as_object().unwrap().is_empty(),
                    "App schedules do not accept per-run input"
                );
                if after["targetType"] == "workflow" {
                    after["recipe"]["input"] = input.clone();
                }
            }
            if after["targetType"] == "workflow" {
                schedule::validate_unattended_workflow(&after["snapshot"])?;
                schedule::validate_scheduled_input(&after["snapshot"], &after["recipe"]["input"])?;
                let schema = crate::module::assistant::catalog::parameters(&after["snapshot"]["settings"]);
                ensure!(
                    jsonschema::validator_for(&schema)?.is_valid(&after["recipe"]["input"]),
                    "Workflow input does not match its schema"
                );
            }
        }
        if operation == "pause" {
            after["enabled"] = json!(false);
        }
        if operation == "resume" {
            after["enabled"] = json!(true);
        }
        if operation == "resume" && after["targetType"] == "workflow" {
            schedule::validate_unattended_workflow(&after["snapshot"])?;
            schedule::validate_scheduled_input(&after["snapshot"], &after["recipe"]["input"])?;
        }
        if operation != "delete" {
            schedule::ScheduleTiming::patch(&mut after, args, Utc::now())?;
        }
        ensure!(
            crate::utils::dirs::active_workspace_id() == self.workspace,
            "Workspace changed"
        );
        Ok(
            json!({"id":uuid::Uuid::new_v4().to_string(),"operation":operation,"status":"waiting","before":before,"after":after}),
        )
    }

    pub async fn decide(&self, state: &mut Value, proposal_id: &str, approve: bool) -> Result<()> {
        self.commit_change(state, proposal_id, approve, true).await
    }

    /// Form edits reuse the validated task transaction without creating or modifying a conversation.
    pub async fn update_task(&self, catalog: &Catalog, args: &Value) -> Result<Value> {
        ensure!(args["operation"] == "update", "Only task updates are accepted");
        ensure!(args["version"].is_string(), "Task version is required");
        let proposal = self.preview(catalog, args).await?;
        let proposal_id = proposal["id"].as_str().context("Missing change ID")?.to_owned();
        let id = proposal["after"]["id"].as_str().context("Missing task ID")?.to_owned();
        let mut change = json!({"proposals":[proposal],"pending":proposal_id,"contents":[]});
        self.commit_change(&mut change, &proposal_id, true, false).await?;
        self.detail(&id).await
    }

    async fn commit_change(
        &self,
        state: &mut Value,
        proposal_id: &str,
        approve: bool,
        persist_session: bool,
    ) -> Result<()> {
        let index = state["proposals"]
            .as_array()
            .context("No proposals")?
            .iter()
            .position(|p| p["id"] == proposal_id)
            .context("Task card is unavailable")?;
        let proposal = state["proposals"][index].clone();
        if proposal["status"] != "waiting" {
            return Ok(());
        }
        let mut tx = self.pool.begin().await?;
        if approve {
            let operation = proposal["operation"].as_str().context("Missing operation")?;
            let after = &proposal["after"];
            let before = &proposal["before"];
            let id = after["id"].as_str().context("Missing task ID")?;
            let now = Utc::now().to_rfc3339();
            let next = if operation == "delete" {
                String::new()
            } else {
                let timing = schedule::ScheduleTiming::from_value(after)?;
                timing
                    .next_for_save(Utc::now(), operation != "pause" && timing.finished_at.is_none())?
                    .to_rfc3339()
            };
            let changed = if operation == "create" {
                sqlx::query("INSERT INTO schedules (workspace_id,id,name,target_type,target_id,target_name,target_snapshot_json,execution_recipe_json,cron_expression,timezone,enabled,next_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
                    .bind(&self.workspace).bind(id).bind(after["name"].as_str()).bind(after["targetType"].as_str()).bind(after["targetId"].as_str()).bind(after["targetName"].as_str())
                    .bind(after["snapshot"].to_string()).bind(after["recipe"].to_string()).bind(after["cronExpression"].as_str()).bind(after["timezone"].as_str())
                    .bind(after["enabled"].as_bool().unwrap_or(true)).bind(&next).bind(&now).bind(&now).execute(&mut *tx).await?
            } else if operation == "delete" {
                sqlx::query("DELETE FROM schedules WHERE workspace_id=? AND id=? AND updated_at=?")
                    .bind(&self.workspace)
                    .bind(id)
                    .bind(before["version"].as_str())
                    .execute(&mut *tx)
                    .await?
            } else {
                sqlx::query("UPDATE schedules SET name=?, target_name=?, target_snapshot_json=?, execution_recipe_json=?, cron_expression=?, timezone=?, enabled=?, next_run_at=?, updated_at=?, last_error=CASE WHEN ? THEN NULL ELSE last_error END WHERE workspace_id=? AND id=? AND updated_at=?")
                    .bind(after["name"].as_str()).bind(after["targetName"].as_str()).bind(after["snapshot"].to_string()).bind(after["recipe"].to_string()).bind(after["cronExpression"].as_str()).bind(after["timezone"].as_str())
                    .bind(after["enabled"].as_bool().unwrap_or(true)).bind(&next).bind(&now).bind(operation != "pause").bind(&self.workspace).bind(id).bind(before["version"].as_str()).execute(&mut *tx).await?
            };
            ensure!(
                changed.rows_affected() == 1,
                "Schedule changed or was deleted. Refresh and preview again."
            );
            if operation != "delete" {
                // Keep timing and the confirmation receipt in the same transaction as the task.
                sqlx::query("UPDATE schedules SET schedule_kind=?,run_at=?,finished_at=?,finish_reason=? WHERE workspace_id=? AND id=?")
                    .bind(after["scheduleKind"].as_str().unwrap_or("recurring"))
                    .bind(after["runAt"].as_str()).bind(after["finishedAt"].as_str()).bind(after["finishReason"].as_str())
                    .bind(&self.workspace).bind(id).execute(&mut *tx).await?;
            }
            state["proposals"][index]["status"] = json!("saved");
            state["proposals"][index]["after"]["nextRunAt"] = json!(next);
            state["scheduleId"] = if operation == "delete" { Value::Null } else { json!(id) };
        } else {
            state["proposals"][index]["status"] = json!("cancelled");
        }
        // Invalidate older pending cards, even if they came from a previous user turn.
        for (i, p) in state["proposals"].as_array_mut().unwrap().iter_mut().enumerate() {
            if i != index && p["status"] == "waiting" {
                p["status"] = json!("superseded");
            }
        }
        state["pending"] = Value::Null;
        let task = &state["proposals"][index]["after"];
        let receipt = json!({"proposalId":proposal_id,"operation":proposal["operation"],"status":state["proposals"][index]["status"],
            "task":{"id":task["id"],"name":task["name"],"targetType":task["targetType"],"targetId":task["targetId"],"targetName":task["targetName"],
            "scheduleKind":task["scheduleKind"],"runAt":task["runAt"],"finishedAt":task["finishedAt"],"finishReason":task["finishReason"],"cronExpression":task["cronExpression"],"timezone":task["timezone"],"enabled":task["enabled"],"input":task["recipe"]["input"],"source":task["recipe"]["source"],"nextRunAt":task["nextRunAt"]}});
        state["contents"].as_array_mut().unwrap().push(
            json!({"role":"user","parts":[{"text":format!("Native schedule action receipt (data): {receipt}")}]}),
        );
        ensure!(
            crate::utils::dirs::active_workspace_id() == self.workspace,
            "Workspace changed"
        );
        if persist_session {
            Self::advance_revision(state);
            sqlx::query("UPDATE schedule_agent_sessions SET state_json=?,updated_at=? WHERE workspace_id=? AND id=?")
                .bind(state.to_string())
                .bind(Utc::now().to_rfc3339())
                .bind(&self.workspace)
                .bind(state["id"].as_str())
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        if persist_session {
            schedule::ScheduleEvents::session(&self.workspace, state["id"].as_str().context("Missing session ID")?);
        }
        schedule::notify_scheduler();
        Ok(())
    }

    pub async fn load_session(&self, id: &str) -> Result<Value> {
        let row = sqlx::query("SELECT state_json FROM schedule_agent_sessions WHERE workspace_id=? AND id=?")
            .bind(&self.workspace)
            .bind(id)
            .fetch_optional(&self.pool)
            .await?
            .context("Scheduling conversation was not found")?;
        Ok(serde_json::from_str(row.try_get("state_json")?)?)
    }

    fn advance_revision(state: &mut Value) {
        // The session lease serializes writes; revisions also order late IPC receipts in the renderer.
        state["revision"] = json!(state["revision"].as_u64().unwrap_or(0) + 1);
    }

    pub async fn save_session(&self, state: &mut Value) -> Result<()> {
        self.ensure_active()?;
        Self::advance_revision(state);
        sqlx::query("INSERT INTO schedule_agent_sessions(workspace_id,id,state_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at")
            .bind(&self.workspace).bind(state["id"].as_str()).bind(state.to_string()).bind(Utc::now().to_rfc3339()).execute(&self.pool).await?;
        schedule::ScheduleEvents::session(&self.workspace, state["id"].as_str().context("Missing session ID")?);
        Ok(())
    }

    pub async fn list_sessions(&self) -> Result<Value> {
        let rows=sqlx::query("SELECT id,state_json,updated_at FROM schedule_agent_sessions WHERE workspace_id=? ORDER BY updated_at DESC LIMIT 50").bind(&self.workspace).fetch_all(&self.pool).await?;
        let mut items = vec![];
        for row in rows {
            let state: Value = serde_json::from_str(row.try_get("state_json")?)?;
            let schedule_ids: Vec<&Value> = state["proposals"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|proposal| proposal["status"] == "saved")
                .map(|proposal| &proposal["after"]["id"])
                .collect();
            items.push(json!({"id":state["id"],"title":state["title"],"scheduleId":state["scheduleId"],"scheduleIds":schedule_ids,"updatedAt":row.try_get::<String,_>("updated_at")?}));
        }
        self.ensure_active()?;
        Ok(json!(items))
    }

    pub async fn delete_session(&self, id: &str) -> Result<()> {
        sqlx::query("DELETE FROM schedule_agent_sessions WHERE workspace_id=? AND id=?")
            .bind(&self.workspace)
            .bind(id)
            .execute(&self.pool)
            .await?;
        schedule::ScheduleEvents::session(&self.workspace, id);
        Ok(())
    }
}

#[cfg(test)]
mod recipe_tests {
    use super::*;
    #[tokio::test]
    async fn scheduling_recipes_round_trip_through_the_actual_dispatch_contract() {
        for workspace in ["personal", "team:example"] {
            let store = SchedulingStore::new(
                sqlx::sqlite::SqlitePoolOptions::new()
                    .connect_lazy("sqlite::memory:")
                    .unwrap(),
                workspace.into(),
            );
            let value = store.new_recipe("workflow").unwrap();
            let recipe: schedule::WorkflowExecutionRecipe = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(recipe.input, json!({}));
            assert_eq!(recipe.initial_state, json!({}));
            assert_eq!(recipe.editor_mode.as_deref(), Some("custom"));
            assert_eq!(
                value["source"]["kind"],
                if workspace == "personal" {
                    "latest_local"
                } else {
                    "latest_published"
                }
            );
            assert!(value.get("initialState").is_some());
        }
    }
}
