use crate::config::{Config, IWorkflow};
use anyhow::{Result, bail};
use chrono::Utc;
use serde_json::Value;
use uuid::Uuid;

/// Get all workflows from the config
pub async fn get_workflows() -> Result<Vec<IWorkflow>> {
    let draft = Config::workflows().await;
    let workflows = draft.data_arc();
    Ok(workflows.get_workflows())
}

/// Create a new workflow and save it to the config
pub async fn create_workflow(document: Value) -> Result<IWorkflow> {
    validate_document(&document, None)?;

    let now = Utc::now().to_rfc3339();
    let workflow = IWorkflow {
        id: Uuid::now_v7().to_string(),
        created_at: now.clone(),
        updated_at: now,
        document,
    };
    let workflows = Config::workflows().await;

    workflows
        .with_data_modify(|mut data| async move {
            data.add_workflow(workflow.clone());
            // Keep the committed snapshot unchanged when the disk write fails.
            data.save_file().await?;
            Ok((data, workflow))
        })
        .await
}

/// Get a workflow by its ID from the config
pub async fn get_workflow(id: &str) -> Result<IWorkflow> {
    validate_id(id)?;

    let workflows = Config::workflows().await.data_arc();
    workflows
        .find_workflow(id)
        .ok_or_else(|| anyhow::anyhow!("Workflow is not in the catalog: {id}"))
}

/// Update an existing workflow in the config
pub async fn update_workflow(id: &str, document: Value) -> Result<IWorkflow> {
    validate_id(id)?;
    validate_document(&document, Some(id))?;

    let updated_at = Utc::now().to_rfc3339();
    let id = id.to_string();
    let workflows = Config::workflows().await;

    workflows
        .with_data_modify(|mut data| async move {
            let existing = data
                .find_workflow(&id)
                .ok_or_else(|| anyhow::anyhow!("Workflow is not in the catalog: {id}"))?;
            let workflow = IWorkflow {
                id: existing.id,
                created_at: existing.created_at,
                updated_at,
                document,
            };

            // The existence check above makes replacement infallible on this local copy.
            debug_assert!(data.replace_workflow(workflow.clone()));
            data.save_file().await?;
            Ok((data, workflow))
        })
        .await
}

fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_err() {
        bail!("Workflow id must be a UUID")
    }
    Ok(())
}

fn validate_document(document: &Value, workflow_id: Option<&str>) -> Result<()> {
    let Some(document) = document.as_object() else {
        bail!("Workflow document must be an object")
    };
    if !document.get("nodes").is_some_and(Value::is_array)
        || !document.get("edges").is_some_and(Value::is_array)
        || !document.get("settings").is_some_and(Value::is_object)
    {
        bail!("Workflow document must contain nodes, edges, and settings")
    }
    if let Some(workflow_id) = workflow_id
        && document["nodes"].as_array().is_some_and(|nodes| {
            nodes.iter().any(|node| {
                node.get("type").and_then(Value::as_str) == Some("subworkflow")
                    && node
                        .get("data")
                        .and_then(|data| data.get("workflowId"))
                        .and_then(Value::as_str)
                        == Some(workflow_id)
            })
        })
    {
        bail!("Workflow cannot include itself as a subworkflow")
    }
    Ok(())
}
