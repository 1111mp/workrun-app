use crate::config::{Config, IWorkflow, IWorkflows};
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

/// A delegated creation has a stable identity, so an interrupted save cannot
/// create a second workflow if its native operation is reconciled later.
pub(crate) async fn save_authored_workflow(
    operation_id: &str,
    target_id: Option<&str>,
    document: Value,
) -> Result<IWorkflow> {
    validate_id(operation_id)?;
    let id = target_id.unwrap_or(operation_id).to_owned();
    validate_id(&id)?;
    validate_document(&document, Some(&id))?;
    let revise = target_id.is_some();
    Config::workflows()
        .await
        .with_data_modify(|mut data| async move {
            let (workflow, changed) = apply_authored_workflow(&mut data, &id, document, revise)?;
            if changed {
                data.save_file().await?;
            }
            Ok((data, workflow))
        })
        .await
}

fn apply_authored_workflow(
    data: &mut IWorkflows,
    id: &str,
    document: Value,
    revise: bool,
) -> Result<(IWorkflow, bool)> {
    let existing = data.find_workflow(id);
    if let Some(existing) = &existing {
        if existing.document == document {
            return Ok((existing.clone(), false));
        }
        anyhow::ensure!(
            revise,
            "This delegation already saved a different definition; inspect it instead of replacing it"
        );
    } else {
        anyhow::ensure!(!revise, "Revision target is not in the workflow catalog");
    }
    let now = Utc::now().to_rfc3339();
    let workflow = IWorkflow {
        id: id.into(),
        created_at: existing
            .as_ref()
            .map(|value| value.created_at.clone())
            .unwrap_or_else(|| now.clone()),
        updated_at: now,
        document,
    };
    if existing.is_some() {
        data.replace_workflow(workflow.clone());
    } else {
        data.add_workflow(workflow.clone());
    }
    Ok((workflow, true))
}

/// Get a workflow by its ID from the config
pub async fn get_workflow(id: &str) -> Result<IWorkflow> {
    validate_id(id)?;
    // All test-time discovery/validation/execution share this explicit disk
    // catalog. Missing fixtures never fall through to process-global user data.
    #[cfg(test)]
    if let Ok(root) = crate::module::workflow::TEST_SUBWORKFLOW_CATALOG.try_with(Clone::clone) {
        let file = root.join(format!("{id}.json"));
        let workflow: IWorkflow = serde_json::from_slice(
            &std::fs::read(file).map_err(|_| anyhow::anyhow!("Test catalog workflow is unavailable: {id}"))?,
        )?;
        anyhow::ensure!(workflow.id == id, "Test catalog identity mismatch");
        return Ok(workflow);
    }

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

pub async fn delete_workflow(id: &str) -> Result<()> {
    validate_id(id)?;
    let id = id.to_owned();
    Config::workflows()
        .await
        .with_data_modify(|mut data| async move {
            if data.find_workflow(&id).is_none() {
                bail!("Workflow is not in the catalog: {id}");
            }
            // Delete only this definition; dependencies and historical snapshots remain independent.
            data.workflows.retain(|workflow| workflow.id != id);
            data.save_file().await?;
            Ok((data, ()))
        })
        .await
}

fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_err() {
        bail!("Workflow id must be a UUID")
    }
    Ok(())
}

pub(crate) fn validate_document(document: &Value, workflow_id: Option<&str>) -> Result<()> {
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

#[cfg(test)]
mod authoring_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn configuration_examples_roundtrip_through_native_catalog_storage() {
        let examples: Vec<Value> = serde_json::from_str(
            &std::fs::read_to_string(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("resources/assistant/workflow_agent/reference/configuration-examples.json"),
            )
            .unwrap(),
        )
        .unwrap();
        let mut catalog = IWorkflows::default();
        for example in &examples {
            let id = Uuid::new_v4().to_string();
            validate_document(&example["document"], Some(&id)).unwrap();
            let (saved, _) = apply_authored_workflow(&mut catalog, &id, example["document"].clone(), false).unwrap();
            assert_eq!(saved.document, example["document"]);
        }
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("workflows.json");
        std::fs::write(&path, serde_json::to_vec(&catalog).unwrap()).unwrap();
        let restored: IWorkflows = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(restored.workflows.len(), examples.len());
        for (saved, example) in restored.workflows.iter().zip(examples) {
            assert_eq!(saved.document, example["document"]);
        }
    }

    #[test]
    fn delegated_save_is_idempotent_and_revisions_preserve_identity() {
        let mut data = IWorkflows::default();
        let id = Uuid::new_v4().to_string();
        let document = json!({"settings":{"name":"Task"},"nodes":[],"edges":[]});
        let (first, changed) = apply_authored_workflow(&mut data, &id, document.clone(), false).unwrap();
        assert!(changed);
        let (_, changed) = apply_authored_workflow(&mut data, &id, document.clone(), false).unwrap();
        assert!(!changed);
        assert_eq!(data.workflows.len(), 1);
        let mut edited = document;
        edited["settings"]["name"] = json!("Revised");
        assert!(apply_authored_workflow(&mut data, &id, edited.clone(), false).is_err());
        let (saved, changed) = apply_authored_workflow(&mut data, &id, edited, true).unwrap();
        assert!(changed);
        assert_eq!(saved.id, first.id);
        assert_eq!(saved.created_at, first.created_at);
        assert_eq!(data.workflows.len(), 1);
        assert!(apply_authored_workflow(&mut data, &Uuid::new_v4().to_string(), json!({}), true).is_err());
    }
}
