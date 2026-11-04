//! Tool catalog and execution for the independent scheduling agent.
use super::store::SchedulingStore;
use crate::module::assistant::catalog::Catalog;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(super) struct ScheduleTools<'a> {
    store: &'a SchedulingStore,
    catalog: &'a Catalog,
}

impl<'a> ScheduleTools<'a> {
    pub fn new(store: &'a SchedulingStore, catalog: &'a Catalog) -> Self {
        Self { store, catalog }
    }

    pub async fn call(&self, state: &mut Value, name: &str, args: &Value) -> Result<Value> {
        self.store.ensure_active()?;
        match name {
            "list_targets" => self.catalog.schedule_targets(args).await,
            "get_target" => SchedulingStore::inspect_target(
                self.catalog,
                args["targetType"].as_str().context("Missing targetType")?,
                args["targetId"].as_str().context("Missing targetId")?,
            )
            .await
            .map(|mut v| {
                v.as_object_mut().unwrap().remove("snapshot");
                v
            }),
            "list_schedules" => self.store.list().await,
            "get_schedule" => self.store.detail(args["id"].as_str().context("Missing ID")?).await,
            "preview_change" => {
                let mut proposal = self.store.preview(self.catalog, args).await?;
                proposal["messageIndex"] = json!(state["messages"].as_array().unwrap().len());
                for p in state["proposals"].as_array_mut().unwrap() {
                    if p["status"] == "waiting" {
                        p["status"] = json!("superseded");
                    }
                }
                state["pending"] = proposal["id"].clone();
                state["proposals"].as_array_mut().unwrap().push(proposal);
                Ok(json!({"awaitingUser":true,"saved":false}))
            },
            "ask_questions" => {
                let questions = args["questions"].as_array().context("Questions must be an array")?;
                ensure!(
                    !questions.is_empty() && questions.len() <= 3,
                    "Ask one to three questions"
                );
                for q in questions {
                    ensure!(
                        q["title"]
                            .as_str()
                            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 1000),
                        "Question title is required"
                    );
                    if let Some(options) = q.get("options") {
                        ensure!(
                            options.as_array().is_some_and(|a| a.len() <= 8
                                && a.iter()
                                    .all(|o| o.as_str().is_some_and(|s| !s.is_empty() && s.len() <= 500))),
                            "Invalid question options"
                        );
                    }
                }
                state["questions"] = json!(questions);
                Ok(json!({"awaitingUser":true}))
            },
            _ => bail!("Tool is unavailable to the scheduling agent"),
        }
    }

    pub fn declarations() -> HashMap<String, Value> {
        let object = json!({"type":"object","properties":{}});
        let id = json!({"type":"object","properties":{"id":{"type":"string"}},"required":["id"]});
        let target = json!({"type":"object","properties":{"targetType":{"type":"string","enum":["app","workflow"]},"targetId":{"type":"string"}},"required":["targetType","targetId"]});
        [
            ("list_schedules","List all saved schedules in this workspace.",object),
            ("get_schedule","Read task inputs, time rule, version, errors and recent run records.",id),
            ("list_targets","Discover existing Apps and Workflows. Use nextCursor for pagination.",json!({"type":"object","properties":{"query":{"type":"string"},"cursor":{"type":"string"},"limit":{"type":"integer"}}})),
            ("get_target","Read the actual selected target's input schema and unattended scheduling eligibility.",target),
            ("preview_change","Propose one task change for native user confirmation. Never saves or runs it.",json!({"type":"object","properties":{
                "operation":{"type":"string","enum":["create","update","pause","resume","delete"]},"id":{"type":"string"},"version":{"type":"string"},
                "targetType":{"type":"string","enum":["app","workflow"]},"targetId":{"type":"string"},"name":{"type":"string"},"scheduleKind":{"type":"string","enum":["recurring","once"]},"runAt":{"type":"string","description":"One-time execution: complete RFC3339 date and time with offset. Resolve relative dates using current time and user timezone."},"cronExpression":{"type":"string"},"timezone":{"type":"string"},"input":{"type":"object"}},"required":["operation"]})),
            ("ask_questions","Ask only missing information with optional suggestions. Free-text answers remain available.",json!({"type":"object","properties":{"questions":{"type":"array","items":{"type":"object","properties":{"title":{"type":"string"},"options":{"type":"array","items":{"type":"string"}}},"required":["title"]}}},"required":["questions"]})),
        ].into_iter().map(|(name,description,parameters)|(name.into(),json!({"name":name,"description":description,"parameters":parameters}))).collect()
    }
}
