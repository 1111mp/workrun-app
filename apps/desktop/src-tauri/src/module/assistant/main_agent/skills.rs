//! Main-agent methods and selected workspace skills; node manuals are not indexed here.
use crate::module::assistant::skills::SkillCatalog;
use anyhow::Result;
use std::ops::Deref;
const CORE_SKILLS: &[(&str, &str, &str)] = &[
    (
        "conversation",
        "Goal understanding and conversational continuity",
        "main_agent/skills/conversation.md",
    ),
    (
        "task-planning",
        "Proportionate planning and success criteria",
        "main_agent/skills/task-planning.md",
    ),
    (
        "capability-orchestration",
        "Capability discovery, selection and reuse",
        "main_agent/skills/capability-orchestration.md",
    ),
    (
        "execution-collaboration",
        "Execution coordination and human participation",
        "main_agent/skills/execution-collaboration.md",
    ),
    (
        "result-delivery",
        "Evidence-based answers, artifacts and outcomes",
        "main_agent/skills/result-delivery.md",
    ),
];

pub(in crate::module::assistant) struct MainSkills(SkillCatalog);
impl MainSkills {
    pub fn builtin() -> Self {
        let mut entries = CORE_SKILLS.to_vec();
        entries.push(crate::module::assistant::skills::WORKRUN_CAPABILITIES);
        Self(SkillCatalog::resources(&entries, CORE_SKILLS.len()))
    }
    pub fn load(selected: &[String]) -> Result<Self> {
        let mut skills = Self::builtin();
        skills.0.add_workspace(selected)?;
        Ok(skills)
    }
}
impl Deref for MainSkills {
    type Target = SkillCatalog;
    fn deref(&self) -> &SkillCatalog {
        &self.0
    }
}
