use super::CmdResult;
use crate::{cmd::StringifyErr as _, feat};

#[tauri::command]
pub async fn get_system_theme() -> CmdResult<String> {
    feat::get_system_theme().map(|t| t.to_string()).stringify_err()
}
