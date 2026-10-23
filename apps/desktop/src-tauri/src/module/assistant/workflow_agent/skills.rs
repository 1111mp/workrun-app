//! Workflow-specific skill index: summaries first, detailed node guides on demand.
use crate::module::assistant::skills::SkillCatalog;
pub(in crate::module::assistant) fn catalog() -> SkillCatalog {
    let mut entries = vec![(
        "workflow-authoring",
        "Build and validate workflows from a delegated task contract",
        "workflow_agent/skills/workflow-authoring.md",
    )];
    entries.push(crate::module::assistant::skills::WORKRUN_CAPABILITIES);
    let names = super::authoring::NODE_REFERENCES
        .iter()
        .map(|(kind, _, _)| format!("workflow-node-{kind}"))
        .collect::<Vec<_>>();
    for (name, (_, summary, path)) in names.iter().zip(super::authoring::NODE_REFERENCES) {
        entries.push((name.as_str(), *summary, *path));
    }
    SkillCatalog::resources(&entries, 1)
}
