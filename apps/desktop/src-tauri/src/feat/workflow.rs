mod revisions;
use crate::config::{Config, IWorkflow, IWorkflows};
use anyhow::{Result, bail};
use chrono::Utc;
pub(super) use revisions::RevisionStore;
pub use revisions::WorkflowRevision;
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
    let mut workflow = IWorkflow {
        id: Uuid::now_v7().to_string(),
        created_at: now.clone(),
        updated_at: now,
        document,
        current_revision_id: None,
    };
    let workflows = Config::workflows().await;

    workflows
        .with_data_modify(|mut data| async move {
            let revision = revision_store()?.prepare(None, &workflow, "manual", None)?;
            workflow.current_revision_id = Some(revision.id);
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
    expected_document: Option<Value>,
) -> Result<(IWorkflow, WorkflowRevision)> {
    validate_id(operation_id)?;
    let id = target_id.unwrap_or(operation_id).to_owned();
    validate_id(&id)?;
    validate_document(&document, Some(&id))?;
    let revise = target_id.is_some();
    let operation_id = operation_id.to_owned();
    Config::workflows()
        .await
        .with_data_modify(|mut data| async move {
            let store = revision_store()?;
            let before = data.find_workflow(&id);
            if let Some(saved) = store.saved_operation(before.as_ref(), &operation_id, &id, &document)? {
                return Ok((data, (saved.workflow(), saved)));
            }
            if let Some(expected) = &expected_document {
                anyhow::ensure!(before.as_ref().is_some_and(|current| &current.document == expected),
                    "Workflow changed while this update was being prepared. Read the latest workflow and prepare a new update.");
            }
            let (mut candidate, _) = apply_authored_workflow(&mut data, &id, document, revise)?;
            candidate.updated_at = Utc::now().to_rfc3339();
            let revision = store.prepare(before.as_ref(), &candidate, "conversation", Some(&operation_id))?;
            let workflow = revision.workflow();
            data.replace_workflow(workflow.clone());
            // Only publish the pointer after the immutable document is durable.
            // A failed catalog write leaves a staged revision that is safe to retry.
            data.save_file().await?;
            Ok((data, (workflow, revision)))
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
        current_revision_id: None,
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
            let candidate = IWorkflow {
                id: existing.id.clone(),
                created_at: existing.created_at.clone(),
                updated_at,
                document,
                current_revision_id: None,
            };

            let revision = revision_store()?.prepare(Some(&existing), &candidate, "manual", None)?;
            let workflow = revision.workflow();
            // The existence check above makes replacement infallible on this local copy.
            let replaced = data.replace_workflow(workflow.clone());
            debug_assert!(replaced);
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
            let existing = data
                .find_workflow(&id)
                .ok_or_else(|| anyhow::anyhow!("Workflow is not in the catalog: {id}"))?;
            // Delete only this definition; dependencies and historical snapshots remain independent.
            revision_store()?.mark_deleted(&existing)?;
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

fn revision_store() -> Result<RevisionStore> {
    Ok(RevisionStore::new(
        crate::utils::dirs::workflow_catalog_path()?.with_file_name("workflow-revisions"),
    ))
}

pub async fn get_workflow_revision(id: &str) -> Result<WorkflowRevision> {
    validate_id(id)?;
    revision_store()?.load(id)
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
