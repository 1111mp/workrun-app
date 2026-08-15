//! Local persistence for editable workflow documents.

use crate::utils::dirs;
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCatalog {
    #[serde(default)]
    pub workflows: Vec<StoredWorkflow>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredWorkflow {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub document: Value,
}

pub struct WorkflowCatalogStore;

impl WorkflowCatalogStore {
    pub async fn list() -> Result<Vec<StoredWorkflow>> {
        Ok(Self::read().await?.workflows)
    }

    pub async fn inspect(id: &str) -> Result<StoredWorkflow> {
        validate_id(id)?;
        Self::read()
            .await?
            .workflows
            .into_iter()
            .find(|workflow| workflow.id == id)
            .ok_or_else(|| anyhow::anyhow!("Workflow is not in the catalog: {id}"))
    }

    pub async fn create(document: Value) -> Result<StoredWorkflow> {
        validate_document(&document)?;
        let now = Utc::now().to_rfc3339();
        let workflow = StoredWorkflow {
            id: Uuid::now_v7().to_string(),
            created_at: now.clone(),
            updated_at: now,
            document,
        };
        let mut catalog = Self::read().await?;
        catalog.workflows.push(workflow.clone());
        Self::write(&catalog).await?;
        Ok(workflow)
    }

    pub async fn update(id: &str, document: Value) -> Result<StoredWorkflow> {
        validate_id(id)?;
        validate_document(&document)?;
        let mut catalog = Self::read().await?;
        let workflow = catalog
            .workflows
            .iter_mut()
            .find(|workflow| workflow.id == id)
            .ok_or_else(|| anyhow::anyhow!("Workflow is not in the catalog: {id}"))?;
        workflow.document = document;
        workflow.updated_at = Utc::now().to_rfc3339();
        let updated = workflow.clone();
        Self::write(&catalog).await?;
        Ok(updated)
    }

    async fn read() -> Result<WorkflowCatalog> {
        let path = dirs::workflow_catalog_path()?;
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(WorkflowCatalog::default());
            }
            Err(error) => return Err(error).with_context(|| format!("failed to read {}", path.display())),
        };
        let catalog = serde_json::from_slice::<WorkflowCatalog>(&bytes)
            .with_context(|| format!("invalid workflow catalog {}", path.display()))?;
        validate_catalog(&catalog)?;
        Ok(catalog)
    }

    async fn write(catalog: &WorkflowCatalog) -> Result<()> {
        let path = dirs::workflow_catalog_path()?;
        let parent = path.parent().context("workflow catalog has no parent directory")?;
        tokio::fs::create_dir_all(parent).await?;
        let contents = serde_json::to_vec_pretty(catalog)?;
        tokio::fs::write(&path, contents)
            .await
            .with_context(|| format!("failed to write {}", path.display()))
    }
}

fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_err() {
        bail!("Workflow id must be a UUID")
    }
    Ok(())
}

fn validate_catalog(catalog: &WorkflowCatalog) -> Result<()> {
    let mut ids = HashSet::with_capacity(catalog.workflows.len());
    for workflow in &catalog.workflows {
        validate_id(&workflow.id)?;
        validate_document(&workflow.document)?;
        if !ids.insert(&workflow.id) {
            bail!("workflow catalog contains duplicate id {:?}", workflow.id)
        }
    }
    Ok(())
}

fn validate_document(document: &Value) -> Result<()> {
    let Some(document) = document.as_object() else {
        bail!("Workflow document must be an object")
    };
    if !document.get("nodes").is_some_and(Value::is_array)
        || !document.get("edges").is_some_and(Value::is_array)
        || !document.get("settings").is_some_and(Value::is_object)
    {
        bail!("Workflow document must contain nodes, edges, and settings")
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_a_complete_workflow_document() {
        assert!(validate_document(&json!({
            "nodes": [],
            "edges": [],
            "settings": { "name": "Example" },
        }))
        .is_ok());
        assert!(validate_document(&json!({ "nodes": [] })).is_err());
    }

    #[test]
    fn rejects_duplicate_catalog_ids() {
        let id = Uuid::now_v7().to_string();
        let workflow = StoredWorkflow {
            id,
            created_at: String::new(),
            updated_at: String::new(),
            document: json!({ "nodes": [], "edges": [], "settings": {} }),
        };
        let catalog = WorkflowCatalog {
            workflows: vec![workflow.clone(), workflow],
        };
        assert!(validate_catalog(&catalog).is_err());
    }
}
