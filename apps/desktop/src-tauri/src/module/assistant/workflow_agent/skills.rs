//! Workflow-specific skill index: summaries first, detailed node guides on demand.
use crate::module::assistant::skills::SkillCatalog;
pub(in crate::module::assistant) fn catalog() -> SkillCatalog {
    let mut entries = vec![(
        "workflow-authoring",
        "Build and validate workflows from a delegated task contract",
        "workflow_agent/skills/workflow-authoring.md",
    )];
    entries.push(crate::module::assistant::skills::WORKRUN_CAPABILITIES);
    SkillCatalog::resources(&entries, 1)
}
