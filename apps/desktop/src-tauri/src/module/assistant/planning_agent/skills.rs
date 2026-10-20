use crate::module::assistant::skills::SkillCatalog;
pub(super) fn catalog() -> SkillCatalog {
    SkillCatalog::resources(
        &[
            (
                "workflow-planning",
                "Plan goals, dependencies, handoffs, acceptance criteria and user questions before configuration",
                "planning_agent/skills/workflow-planning.md",
            ),
            crate::module::assistant::skills::WORKRUN_CAPABILITIES,
        ],
        1,
    )
}
