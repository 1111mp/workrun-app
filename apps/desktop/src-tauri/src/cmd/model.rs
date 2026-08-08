use crate::{
    cmd::CmdResult,
    config::{ModelDefinition, model_catalog},
};

#[tauri::command]
pub async fn model_catalog_list() -> CmdResult<Vec<ModelDefinition>> {
    Ok(model_catalog())
}
