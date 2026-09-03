//! Workrun's scoped access to the ADK Skill catalog.

use crate::utils::dirs;
use adk_rust::skill::{SkillDocument, SkillDraft, SkillIndex, SkillSummary, load_skill_index};
use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillWriteRequest {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub compatibility: Option<String>,
    #[serde(default)]
    pub tags: Option<String>,
    #[serde(default)]
    pub allowed_tools: Option<String>,
    #[serde(default)]
    pub references: Option<String>,
    #[serde(default)]
    pub trigger: bool,
    #[serde(default)]
    pub hint: Option<String>,
    #[serde(default)]
    pub metadata: HashMap<String, Value>,
    #[serde(default)]
    pub instructions: String,
}

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

    pub fn create(request: SkillWriteRequest) -> Result<SkillDocument> {
        let skill_path = Self::skill_path(&request.name)?;
        let legacy_path = Self::legacy_skill_path(&request.name)?;
        if skill_path.exists() || legacy_path.exists() || Self::load_index()?.find_by_name(&request.name).is_some() {
            bail!("skill `{}` already exists", request.name);
        }
        let name = request.name.clone();
        Self::write_skill(&skill_path, &request.into_draft())?;
        Self::inspect(&name)
    }

    pub fn update(request: SkillWriteRequest) -> Result<SkillDocument> {
        let existing = Self::inspect(&request.name)?;
        let name = request.name.clone();
        Self::write_skill(&existing.path, &request.into_draft())?;
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

    fn write_skill(path: &std::path::Path, draft: &SkillDraft) -> Result<()> {
        let contents = draft.to_markdown().map_err(|error| anyhow!(error.to_string()))?;
        let directory = path.parent().context("skill file has no parent directory")?;
        std::fs::create_dir_all(directory)
            .with_context(|| format!("failed to create skill directory {}", directory.display()))?;
        std::fs::write(path, contents).with_context(|| format!("failed to write skill file {}", path.display()))
    }
}

impl SkillWriteRequest {
    fn into_draft(self) -> SkillDraft {
        let mut draft = SkillDraft::new(self.name, self.description).with_body(self.instructions);
        if let Some(version) = self.version.filter(|value| !value.trim().is_empty()) {
            draft = draft.with_version(version);
        }
        if let Some(license) = self.license.filter(|value| !value.trim().is_empty()) {
            draft = draft.with_license(license);
        }
        if let Some(compatibility) = self.compatibility.filter(|value| !value.trim().is_empty()) {
            draft = draft.with_compatibility(compatibility);
        }
        if let Some(tools) = self.allowed_tools {
            draft = draft.with_allowed_tools(tools.split_whitespace());
        }
        if let Some(tags) = self.tags {
            draft = draft.with_tags(tags.split_whitespace());
        }
        if let Some(references) = self.references {
            draft = draft.with_references(references.lines().map(str::trim).filter(|value| !value.is_empty()));
        }
        if self.trigger {
            draft = draft.with_trigger(true);
        }
        if let Some(hint) = self.hint.filter(|value| !value.trim().is_empty()) {
            draft = draft.with_hint(hint);
        }
        if !self.metadata.is_empty() {
            draft = draft.with_metadata(self.metadata);
        }
        draft
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
    fn writes_all_agentskills_frontmatter_fields() {
        let root = std::env::temp_dir().join(format!("workrun-skill-test-{}", uuid::Uuid::now_v7()));
        let request = SkillWriteRequest {
            name: "voice-receptionist".to_string(),
            description: "Answer calls for the plumbing team.".to_string(),
            version: Some("1.1.0".to_string()),
            license: Some("MIT".to_string()),
            compatibility: Some("Gemini Live".to_string()),
            tags: Some("support voice".to_string()),
            allowed_tools: Some("user_profile knowledge".to_string()),
            references: Some("references/technicians.json\nreferences/coverage.csv".to_string()),
            trigger: true,
            hint: Some("Tell us how we can help.".to_string()),
            metadata: HashMap::from([("owner".to_string(), Value::String("platform".to_string()))]),
            instructions: "Greet callers and collect the repair details.".to_string(),
        };

        let skill_path = root.join(".skills/voice-receptionist/SKILL.md");
        SkillRegistry::write_skill(&skill_path, &request.into_draft()).unwrap();
        assert!(skill_path.is_file());
        let index = load_skill_index(&root).unwrap();
        let skill = index.find_by_name("voice-receptionist").unwrap();

        assert_eq!(skill.version.as_deref(), Some("1.1.0"));
        assert_eq!(skill.license.as_deref(), Some("MIT"));
        assert_eq!(skill.compatibility.as_deref(), Some("Gemini Live"));
        assert_eq!(skill.tags, ["support", "voice"]);
        assert_eq!(skill.allowed_tools, ["user_profile", "knowledge"]);
        assert_eq!(
            skill.references,
            ["references/technicians.json", "references/coverage.csv"]
        );
        assert!(skill.trigger);
        assert_eq!(skill.hint.as_deref(), Some("Tell us how we can help."));
        assert_eq!(skill.metadata["owner"], Value::String("platform".to_string()));
        std::fs::remove_dir_all(root).unwrap();
    }
}
