use crate::{
    cmd::{CmdResult, StringifyErr as _},
    feat,
};
use adk_rust::skill::{SkillDocument, SkillSummary};

#[tauri::command]
pub async fn skill_list() -> CmdResult<Vec<SkillSummary>> {
    feat::skill_list().stringify_err()
}

#[tauri::command]
pub async fn skill_inspect(name: String) -> CmdResult<SkillDocument> {
    feat::skill_inspect(&name).stringify_err()
}

#[tauri::command]
pub async fn skill_create(request: feat::SkillWriteRequest) -> CmdResult<SkillDocument> {
    feat::skill_create(request).stringify_err()
}

#[tauri::command]
pub async fn skill_update(request: feat::SkillWriteRequest) -> CmdResult<SkillDocument> {
    feat::skill_update(request).stringify_err()
}

#[tauri::command]
pub async fn skill_delete(name: String) -> CmdResult {
    feat::skill_delete(&name).stringify_err()
}

#[tauri::command]
pub async fn skill_open_directory() -> CmdResult {
    feat::skill_open_directory().stringify_err()
}

#[tauri::command]
pub async fn skill_open_folder(name: String) -> CmdResult {
    feat::skill_open_folder(&name).stringify_err()
}
