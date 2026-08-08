use super::CmdResult;
use crate::{
    cmd::StringifyErr as _,
    config::{Config, IWorkrun, SharedDraft},
    feat,
};

/// get workrun configuration
#[tauri::command]
pub async fn get_workrun_config() -> CmdResult<SharedDraft<IWorkrun>> {
    let draft = Config::workrun().await;
    let data = draft.data_arc();
    Ok(data)
}

/// patch workrun configuration
#[tauri::command]
pub async fn patch_workrun_config(payload: IWorkrun) -> CmdResult {
    feat::patch_workrun(&payload, true).await.stringify_err()
}
