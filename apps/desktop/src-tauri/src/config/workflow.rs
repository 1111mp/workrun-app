use crate::{
    logging,
    utils::{dirs, help, logging::Type},
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IWorkflow {
    pub id: String,
    pub created_at: String,
    pub updated_at: String,
    pub document: Value,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IWorkflows {
    pub workflows: Vec<IWorkflow>,
}

impl Default for IWorkflows {
    fn default() -> Self {
        Self { workflows: vec![] }
    }
}

impl IWorkflows {
    pub async fn new() -> Self {
        match dirs::workflow_catalog_path() {
            Ok(path) => match help::read_json::<Self>(&path).await {
                Ok(workflows) => workflows,
                Err(err) => {
                    logging!(error, Type::Config, "{err}");
                    Self::default()
                },
            },
            Err(err) => {
                logging!(error, Type::Config, "{err}");
                return Self::default();
            },
        }
    }

    /// Save the workflow catalog to file
    pub async fn save_file(&self) -> Result<()> {
        help::save_json(&dirs::workflow_catalog_path()?, self, None).await
    }

    /// get workflows
    pub fn get_workflows(&self) -> Vec<IWorkflow> {
        let mut workflows = self.workflows.clone();
        workflows.sort_by(|left, right| {
            right
                .created_at
                .cmp(&left.created_at)
                .then_with(|| right.updated_at.cmp(&left.updated_at))
        });
        workflows
    }

    /// Adds a workflow that has already been assigned its business metadata.
    pub fn add_workflow(&mut self, workflow: IWorkflow) {
        self.workflows.push(workflow);
    }

    /// Find a workflow by its ID. Returns `None` if not found.
    pub fn find_workflow(&self, id: &str) -> Option<IWorkflow> {
        self.workflows.iter().find(|workflow| workflow.id == id).cloned()
    }

    /// Replace a workflow in the catalog. Returns `true` if the workflow was found and replaced, `false` otherwise.
    pub fn replace_workflow(&mut self, workflow: IWorkflow) -> bool {
        let Some(position) = self.workflows.iter().position(|current| current.id == workflow.id) else {
            return false;
        };
        self.workflows[position] = workflow;
        true
    }
}
