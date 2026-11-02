use crate::{cmd::CmdResult, config::model_catalog};

#[tauri::command]
pub async fn model_catalog_list() -> CmdResult<Vec<serde_json::Value>> {
    model_catalog()
        .into_iter()
        .map(|model| {
            let mut value = serde_json::to_value(&model).map_err(|error| error.to_string())?;
            value["effortOptions"] = serde_json::json!(model.effort_options());
            Ok(value)
        })
        .collect()
}
