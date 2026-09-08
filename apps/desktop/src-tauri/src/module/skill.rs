//! Workrun's scoped access to the ADK Skill catalog.

use crate::utils::dirs;
use adk_rust::skill::{SkillDocument, SkillDraft, SkillIndex, SkillSummary, load_skill_index};
use anyhow::{Context, Result, anyhow, bail};
use std::io::Write;

pub struct SkillRegistry;

impl SkillRegistry {
    pub fn list() -> Result<Vec<SkillSummary>> {
        Ok(Self::load_index()?.summaries())
    }

    pub fn resolve(names: &[String]) -> Result<Vec<SkillDocument>> {
        let index = Self::load_index()?;
        let mut seen = std::collections::HashSet::new();
        names
            .iter()
            .map(|name| {
                if !seen.insert(name) {
                    bail!("agent node selects skill `{name}` more than once");
                }
                adk_rust::skill::validate_skill_name(name).map_err(|error| anyhow!(error.to_string()))?;
                index
                    .find_by_name(name)
                    .cloned()
                    .ok_or_else(|| anyhow!("skill `{name}` does not exist"))
            })
            .collect()
    }

    pub fn inspect(name: &str) -> Result<SkillDocument> {
        Self::resolve(&[name.to_string()]).map(|mut skills| skills.remove(0))
    }

    pub fn create(name: String, draft: SkillDraft) -> Result<SkillDocument> {
        let skill_path = Self::skill_path(&name)?;
        let legacy_path = Self::legacy_skill_path(&name)?;
        if skill_path.exists() || legacy_path.exists() || Self::load_index()?.find_by_name(&name).is_some() {
            bail!("skill `{name}` already exists");
        }
        Self::write_skill(&skill_path, &draft)?;
        Self::inspect(&name)
    }

    pub fn update(name: String, draft: SkillDraft) -> Result<SkillDocument> {
        let existing = Self::inspect(&name)?;
        Self::write_skill(&existing.path, &draft)?;
        Self::inspect(&name)
    }

    pub fn delete(name: &str) -> Result<()> {
        let skill = Self::inspect(name)?;
        let skill_path = Self::skill_path(name)?;
        if skill.path == skill_path {
            let directory = skill_path.parent().context("skill file has no parent directory")?;
            std::fs::remove_dir_all(directory)
                .with_context(|| format!("failed to remove skill directory {}", directory.display()))?;
        } else {
            std::fs::remove_file(&skill.path)
                .with_context(|| format!("failed to remove skill file {}", skill.path.display()))?;
        }
        Ok(())
    }

    pub fn open_directory() -> Result<()> {
        let directory = dirs::skills_dir()?;
        std::fs::create_dir_all(&directory)
            .with_context(|| format!("failed to create skills directory {}", directory.display()))?;
        open::that(&directory).with_context(|| format!("failed to open skills directory {}", directory.display()))
    }

    pub fn open_folder(name: &str) -> Result<()> {
        let skill = Self::inspect(name)?;
        let directory = skill.path.parent().context("skill file has no parent directory")?;
        open::that(directory).with_context(|| format!("failed to open skill directory {}", directory.display()))
    }

    fn load_index() -> Result<SkillIndex> {
        load_skill_index(dirs::app_home_dir()?).map_err(|error| anyhow!(error.to_string()))
    }

    fn skill_path(name: &str) -> Result<std::path::PathBuf> {
        adk_rust::skill::validate_skill_name(name).map_err(|error| anyhow!(error.to_string()))?;
        Ok(dirs::skills_dir()?.join(name).join("SKILL.md"))
    }

    fn legacy_skill_path(name: &str) -> Result<std::path::PathBuf> {
        adk_rust::skill::validate_skill_name(name).map_err(|error| anyhow!(error.to_string()))?;
        Ok(dirs::skills_dir()?.join(format!("{name}.md")))
    }

    pub(crate) fn write_skill(path: &std::path::Path, draft: &SkillDraft) -> Result<()> {
        let contents = draft.to_markdown().map_err(|error| anyhow!(error.to_string()))?;
        let directory = path.parent().context("skill file has no parent directory")?;
        std::fs::create_dir_all(directory)
            .with_context(|| format!("failed to create skill directory {}", directory.display()))?;
        // Keeping the temporary file in the target directory makes rename an atomic replacement.
        let temporary_path = directory.join(format!(".SKILL.md.{}.tmp", uuid::Uuid::now_v7()));
        let write_result = (|| -> Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary_path)
                .with_context(|| format!("failed to create temporary skill file {}", temporary_path.display()))?;
            file.write_all(contents.as_bytes())
                .with_context(|| format!("failed to write temporary skill file {}", temporary_path.display()))?;
            file.sync_all()
                .with_context(|| format!("failed to sync temporary skill file {}", temporary_path.display()))?;
            drop(file);
            std::fs::rename(&temporary_path, path)
                .with_context(|| format!("failed to replace skill file {}", path.display()))
        })();

        if write_result.is_err() {
            let _ = std::fs::remove_file(&temporary_path);
        }
        write_result
    }
}

/// Applies Workrun's node-level tool boundary to Skill-declared tools.
pub fn allowed_tool_ids(skills: &[SkillDocument], selected_tool_ids: Vec<String>) -> Result<Vec<String>> {
    let restrictions = skills
        .iter()
        .filter_map(|skill| (!skill.allowed_tools.is_empty()).then_some(&skill.allowed_tools))
        .collect::<Vec<_>>();
    for skill_tools in &restrictions {
        for tool_id in *skill_tools {
            if !selected_tool_ids.contains(tool_id) {
                bail!("skill declares tool `{tool_id}` but the agent node has not selected it");
            }
        }
    }
    Ok(selected_tool_ids
        .into_iter()
        // A node may activate more than one skill during an invocation, so an
        // allowed tool belongs to any selected skill rather than every skill.
        .filter(|tool_id| restrictions.is_empty() || restrictions.iter().any(|allowed| allowed.contains(tool_id)))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use adk_rust::skill::SkillWriter;

    #[test]
    fn skills_restrict_the_node_tool_set() {
        let root = std::env::temp_dir().join(format!("workrun-skill-test-{}", uuid::Uuid::now_v7()));
        let writer = SkillWriter::new(&root);
        writer
            .write(&SkillDraft::new("search", "Search").with_allowed_tools(["search"]))
            .unwrap();
        let index = load_skill_index(&root).unwrap();
        let tools = allowed_tool_ids(
            &[index.find_by_name("search").unwrap().clone()],
            vec!["search".to_string(), "read".to_string()],
        )
        .unwrap();
        assert_eq!(tools, ["search"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn multiple_skills_keep_each_declared_tool_available() {
        let root = std::env::temp_dir().join(format!("workrun-skill-test-{}", uuid::Uuid::now_v7()));
        let writer = SkillWriter::new(&root);
        writer
            .write(&SkillDraft::new("search", "Search").with_allowed_tools(["search"]))
            .unwrap();
        writer
            .write(&SkillDraft::new("reader", "Read").with_allowed_tools(["read"]))
            .unwrap();
        let index = load_skill_index(&root).unwrap();
        let tools = allowed_tool_ids(
            &[
                index.find_by_name("search").unwrap().clone(),
                index.find_by_name("reader").unwrap().clone(),
            ],
            vec!["search".to_string(), "read".to_string(), "write".to_string()],
        )
        .unwrap();
        assert_eq!(tools, ["search", "read"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writing_skill_replaces_the_existing_file_without_temporary_files() {
        let root = std::env::temp_dir().join(format!("workrun-skill-test-{}", uuid::Uuid::now_v7()));
        let skill_path = root.join("SKILL.md");

        SkillRegistry::write_skill(&skill_path, &SkillDraft::new("first", "First").with_body("first body")).unwrap();
        SkillRegistry::write_skill(
            &skill_path,
            &SkillDraft::new("second", "Second").with_body("second body"),
        )
        .unwrap();

        let contents = std::fs::read_to_string(&skill_path).unwrap();
        assert!(contents.contains("second body"));
        assert!(!contents.contains("first body"));
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
