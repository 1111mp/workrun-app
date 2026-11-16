use crate::{cmd::CmdResult, cmd::StringifyErr};

#[tauri::command]
pub async fn model_catalog_list() -> CmdResult<Vec<serde_json::Value>> {
    serialize_models(crate::module::team_model::active_catalog().await.stringify_err()?)
}

#[tauri::command]
pub async fn model_catalog_status(refresh: Option<bool>) -> CmdResult<serde_json::Value> {
    let (models, server_error) = crate::module::team_model::catalog_status(refresh.unwrap_or(false)).await;
    Ok(serde_json::json!({ "models": serialize_models(models)?, "serverError": server_error }))
}

fn serialize_models(models: Vec<crate::config::ModelDefinition>) -> CmdResult<Vec<serde_json::Value>> {
    models.into_iter()
        .map(|model| {
            let mut value = serde_json::to_value(&model).map_err(|error| error.to_string())?;
            if let Some(binding) = &model.team {
                value["apiProtocol"] = serde_json::json!(binding.protocol);
                value["capabilities"] = serde_json::json!({"tools":binding.tools,"structuredOutput":binding.structured_output,"vision":binding.vision});
            }
            value["effortOptions"] = serde_json::json!(model.effort_options());
            Ok(value)
        })
        .collect()
}
