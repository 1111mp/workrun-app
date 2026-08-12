use crate::{
    cmd::{CmdResult, StringifyErr},
    module::ipc::IpcServer,
};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonUiResponseRequest {
    pub run_id: String,
    pub request_id: String,
    pub accepted: bool,
}

/// Complete one pending Python UI interaction from the desktop frontend.
#[tauri::command]
pub async fn python_ui_respond(request: PythonUiResponseRequest) -> CmdResult {
    let message = if request.accepted {
        json!({ "id": request.request_id, "type": "ui.response", "data": { "confirmed": true } })
    } else {
        json!({ "id": request.request_id, "type": "ui.response", "data": { "confirmed": false } })
    };
    IpcServer::global()
        .send(&request.run_id, Value::from(message))
        .await
        .stringify_err()
}
