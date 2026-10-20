//! Mandatory skills ship with the runtime; optional skills use the workspace catalog.
use crate::module::skill::SkillRegistry;
use anyhow::{Result, bail};
use serde_json::{Value, json};

/// One packaged overview, shared across role catalogs without preloading node manuals.
pub(super) const WORKRUN_CAPABILITIES: (&str, &str, &str) = (
    "workrun-capabilities",
    "Workrun native capabilities, configuration concepts and discovery/read paths",
    "reference/workrun-capabilities.md",
);

pub(super) struct SkillCatalog {
    documents: Vec<(String, String, SkillBody)>,
    mandatory_count: usize,
}

enum SkillBody {
    Resource(String),
    Inline(String),
}

impl SkillCatalog {
    pub fn resources(entries: &[(&str, &str, &str)], mandatory_count: usize) -> Self {
        Self {
            mandatory_count,
            documents: entries
                .iter()
                .map(|(name, description, path)| {
                    (
                        name.to_string(),
                        description.to_string(),
                        SkillBody::Resource(path.to_string()),
                    )
                })
                .collect(),
        }
    }
    pub fn add_workspace(&mut self, selected: &[String]) -> Result<()> {
        if selected.is_empty() {
            return Ok(());
        }
        for skill in SkillRegistry::resolve(selected)? {
            if self.documents.iter().any(|(name, _, _)| name == &skill.name) {
                bail!("Skill conflicts with a built-in skill: {}", skill.name);
            }
            self.documents
                .push((skill.name, skill.description, SkillBody::Inline(skill.body)));
        }
        Ok(())
    }
    pub fn summaries(&self) -> Value {
        self.documents
            .iter()
            .map(|(name, description, _)| json!({"name":name,"description":description}))
            .collect()
    }

    pub fn read(&self, name: &str) -> Result<String> {
        self.documents
            .iter()
            .find(|(id, _, _)| id == name)
            .map(|(_, _, body)| body)
            .ok_or_else(|| anyhow::anyhow!("assistant skill `{name}` is not enabled"))
            .and_then(|body| match body {
                SkillBody::Resource(path) => super::resources::read(path),
                SkillBody::Inline(body) => Ok(body.clone()),
            })
    }

    pub fn mandatory_instructions(&self) -> Result<String> {
        Ok(self
            .documents
            .iter()
            .take(self.mandatory_count)
            .map(|(name, _, _)| self.read(name))
            .collect::<Result<Vec<_>>>()?
            .join("\n\n"))
    }
}
