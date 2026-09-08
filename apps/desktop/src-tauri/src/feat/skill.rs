use crate::module::skill::SkillRegistry;
use adk_rust::skill::{SkillDocument, SkillDraft, SkillSummary};
use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;

/// Input accepted by the Skills IPC commands.
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

pub fn skill_list() -> Result<Vec<SkillSummary>> {
    SkillRegistry::list()
}

pub fn skill_inspect(name: &str) -> Result<SkillDocument> {
    SkillRegistry::inspect(name)
}

pub fn skill_create(request: SkillWriteRequest) -> Result<SkillDocument> {
    let name = request.name.clone();
    SkillRegistry::create(name, request.into_draft())
}

pub fn skill_update(request: SkillWriteRequest) -> Result<SkillDocument> {
    let name = request.name.clone();
    SkillRegistry::update(name, request.into_draft())
}

pub fn skill_delete(name: &str) -> Result<()> {
    SkillRegistry::delete(name)
}

pub fn skill_open_directory() -> Result<()> {
    SkillRegistry::open_directory()
}

pub fn skill_open_folder(name: &str) -> Result<()> {
    SkillRegistry::open_folder(name)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::module::skill::SkillRegistry;
    use adk_rust::skill::load_skill_index;

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
