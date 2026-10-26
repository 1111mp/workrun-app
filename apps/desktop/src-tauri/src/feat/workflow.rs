pub(crate) mod repository;
mod revisions;
use crate::config::IWorkflow;
use anyhow::{Result, bail};
use chrono::Utc;
use repository::WorkflowRepository;
pub use revisions::WorkflowRevision;
use serde_json::Value;
use uuid::Uuid;

pub async fn get_workflows() -> Result<Vec<IWorkflow>> {
    WorkflowRepository::active()?.list().await
}

pub async fn create_workflow(document: Value) -> Result<IWorkflow> {
    validate_document(&document, None)?;
    save_document(&Uuid::now_v7().to_string(), document, false, "manual", None, None, None)
        .await
        .map(|r| r.workflow())
}

pub(crate) async fn save_authored_workflow(
    operation_id: &str,
    session_id: &str,
    target_id: Option<&str>,
    document: Value,
    expected_document: Option<Value>,
) -> Result<(IWorkflow, WorkflowRevision)> {
    validate_id(operation_id)?;
    let revision = save_document(
        target_id.unwrap_or(operation_id),
        document,
        target_id.is_some(),
        "conversation",
        Some(operation_id),
        expected_document.as_ref(),
        Some(session_id),
    )
    .await?;
    Ok((revision.workflow(), revision))
}

async fn save_document(
    id: &str,
    document: Value,
    revise: bool,
    source: &str,
    operation: Option<&str>,
    expected: Option<&Value>,
    session_id: Option<&str>,
) -> Result<WorkflowRevision> {
    validate_id(id)?;
    validate_document(&document, Some(id))?;
    let now = Utc::now().to_rfc3339();
    let candidate = IWorkflow {
        id: id.into(),
        created_at: now.clone(),
        updated_at: now,
        document,
        current_revision_id: None,
    };
    let repository = WorkflowRepository::active()?;
    let mut tx = repository.begin().await?;
    let revision = repository
        .save(&mut tx, candidate, revise, source, operation, expected)
        .await?;
    if let Some(session_id) = session_id {
        repository.retain_for_session(&mut tx, session_id, &revision).await?;
    }
    repository.commit(tx).await?;
    Ok(revision)
}

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

    WorkflowRepository::active()?.get(id).await
}

pub async fn update_workflow(id: &str, document: Value) -> Result<IWorkflow> {
    save_document(id, document, true, "manual", None, None, None)
        .await
        .map(|r| r.workflow())
}

pub async fn delete_workflow(id: &str) -> Result<()> {
    validate_id(id)?;
    WorkflowRepository::active()?.delete(id).await
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

pub async fn get_workflow_revision(id: &str) -> Result<WorkflowRevision> {
    validate_id(id)?;
    WorkflowRepository::active()?.revision(id).await
}
