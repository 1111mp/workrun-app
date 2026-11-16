//! Main-agent methods and selected workspace skills; node manuals are not indexed here.
use crate::module::assistant::skills::SkillCatalog;
use anyhow::Result;
use std::ops::Deref;
const CORE_SKILLS: &[(&str, &str, &str)] = &[
    (
        "conversation",
        "Goal understanding and conversational continuity",
        "task_agent/skills/conversation.md",
    ),
    (
        "task-planning",
        "Proportionate planning and success criteria",
        "task_agent/skills/task-planning.md",
    ),
    (
        "capability-orchestration",
        "Capability discovery, selection and reuse",
        "task_agent/skills/capability-orchestration.md",
    ),
    (
        "execution-collaboration",
        "Execution coordination and human participation",
        "task_agent/skills/execution-collaboration.md",
    ),
    (
        "result-delivery",
        "Evidence-based answers, artifacts and outcomes",
        "task_agent/skills/result-delivery.md",
    ),
];

pub(in crate::module::assistant) struct TaskSkills(SkillCatalog);
impl TaskSkills {
    pub fn summaries(&self) -> serde_json::Value {
        // Core methods are runtime behavior, not capabilities to discover on
        // every task. Their bodies remain readable when explicitly needed.
        self.0
            .summaries()
            .as_array()
            .unwrap()
            .iter()
            .filter(|skill| !CORE_SKILLS.iter().any(|(name, _, _)| skill["name"] == *name))
            .cloned()
            .collect()
    }
    pub fn builtin() -> Self {
        let mut entries = CORE_SKILLS.to_vec();
        entries.push(crate::module::assistant::skills::WORKRUN_CAPABILITIES);
        entries.push((
            "workflow-repair",
            "Diagnose failed or incorrect runs, propose minimal repairs and verify reruns",
            "task_agent/skills/workflow-repair.md",
        ));
        Self(SkillCatalog::resources(&entries, 0))
    }
    pub fn load(selected: &[String]) -> Result<Self> {
        let mut skills = Self::builtin();
        skills.0.add_workspace(selected)?;
        Ok(skills)
    }
}
impl Deref for TaskSkills {
    type Target = SkillCatalog;
    fn deref(&self) -> &SkillCatalog {
        &self.0
    }
}
