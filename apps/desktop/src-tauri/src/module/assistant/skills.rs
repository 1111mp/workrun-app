//! Mandatory skills ship with the runtime; optional skills use the workspace catalog.
use crate::module::skill::SkillRegistry;
use anyhow::{Result, bail};
use serde_json::{Value, json};

// Core methods are always available; workspace skills are discovered on demand.
const CORE_SKILLS: &[(&str, &str, &str)] = &[
    (
        "conversation",
        "Goal understanding and conversational continuity",
        include_str!("skills/conversation.md"),
    ),
    (
        "task-planning",
        "Proportionate planning and success criteria",
        include_str!("skills/task-planning.md"),
    ),
    (
        "capability-orchestration",
        "Capability discovery, selection and reuse",
        include_str!("skills/capability-orchestration.md"),
    ),
    (
        "execution-collaboration",
        "Execution coordination and human participation",
        include_str!("skills/execution-collaboration.md"),
    ),
    (
        "result-delivery",
        "Evidence-based answers, artifacts and outcomes",
        include_str!("skills/result-delivery.md"),
    ),
];

pub(super) struct SkillCatalog {
    documents: Vec<(String, String, String)>,
}

impl SkillCatalog {
    pub fn load(selected: &[String]) -> Result<Self> {
        let mut catalog = Self::builtin();
        if selected.is_empty() {
            return Ok(catalog);
        }
        for skill in SkillRegistry::resolve(selected)? {
            if catalog.documents.iter().any(|(name, _, _)| name == &skill.name) {
                bail!("assistant skill `{}` conflicts with a mandatory skill", skill.name);
            }
            catalog.documents.push((skill.name, skill.description, skill.body));
        }
        Ok(catalog)
    }

    pub fn builtin() -> Self {
        Self {
            documents: CORE_SKILLS
                .iter()
                .map(|(name, description, body)| (name.to_string(), description.to_string(), body.to_string()))
                .collect(),
        }
    }

    pub fn summaries(&self) -> Value {
        self.documents
            .iter()
            .map(|(name, description, _)| json!({"name":name,"description":description}))
            .collect()
    }

    pub fn read(&self, name: &str) -> Result<&str> {
        self.documents
            .iter()
            .find(|(id, _, _)| id == name)
            .map(|(_, _, body)| body.as_str())
            .ok_or_else(|| anyhow::anyhow!("assistant skill `{name}` is not enabled"))
    }

    pub fn mandatory_instructions(&self) -> String {
        self.documents
            .iter()
            .take(CORE_SKILLS.len())
            .map(|(_, _, body)| body.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
