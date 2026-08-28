use crate::{
    cmd::{CmdResult, StringifyErr as _},
    module::skill::{SkillRegistry, SkillWriteRequest},
};
use adk_rust::skill::{SkillDocument, SkillSummary};

#[tauri::command]
pub async fn skill_list() -> CmdResult<Vec<SkillSummary>> {
    SkillRegistry::list().stringify_err()
}

#[tauri::command]
pub async fn skill_inspect(name: String) -> CmdResult<SkillDocument> {
    SkillRegistry::inspect(&name).stringify_err()
}

#[tauri::command]
pub async fn skill_create(request: SkillWriteRequest) -> CmdResult<SkillDocument> {
    SkillRegistry::create(request).stringify_err()
}

#[tauri::command]
pub async fn skill_update(request: SkillWriteRequest) -> CmdResult<SkillDocument> {
    SkillRegistry::update(request).stringify_err()
}

#[tauri::command]
pub async fn skill_delete(name: String) -> CmdResult {
    SkillRegistry::delete(&name).stringify_err()
}

#[tauri::command]
pub async fn skill_open_directory() -> CmdResult {
    SkillRegistry::open_directory().stringify_err()
}

#[tauri::command]
pub async fn skill_open_folder(name: String) -> CmdResult {
    SkillRegistry::open_folder(&name).stringify_err()
}
