use crate::{
    cmd::{CmdResult, StringifyErr},
    module::chat_session::{ChatSession, ChatSessionStore, ChatTurn},
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChatSession {
    pub id: String,
    pub workflow_id: String,
    pub workflow_snapshot: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeginChatTurn {
    pub session_id: String,
    pub turn_id: String,
    pub run_id: String,
    pub message: String,
}

#[tauri::command]
pub async fn chat_session_create(request: CreateChatSession) -> Result<ChatSession, String> {
    ChatSessionStore::create(&request.id, &request.workflow_id, request.workflow_snapshot)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn chat_session_get(id: String) -> CmdResult<ChatSession> {
    ChatSessionStore::get(&id).await.stringify_err()
}

#[tauri::command]
pub async fn chat_session_update_snapshot(id: String, workflow_snapshot: Value) -> CmdResult {
    ChatSessionStore::get(&id).await.stringify_err()?;
    ChatSessionStore::update_workflow_snapshot(&id, workflow_snapshot)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn chat_session_begin_turn(request: BeginChatTurn) -> CmdResult {
    ChatSessionStore::get(&request.session_id).await.stringify_err()?;
    ChatSessionStore::begin_turn(&request.session_id, &request.turn_id, &request.run_id, &request.message)
        .await
        .stringify_err()
}

#[tauri::command]
pub async fn chat_session_list_turns(session_id: String) -> CmdResult<Vec<ChatTurn>> {
    ChatSessionStore::get(&session_id).await.stringify_err()?;
    ChatSessionStore::list_turns(&session_id).await.stringify_err()
}

#[tauri::command]
pub async fn chat_session_list(workflow_id: String) -> CmdResult<Vec<ChatSession>> {
    ChatSessionStore::list(&workflow_id).await.stringify_err()
}

#[tauri::command]
pub async fn chat_session_list_history(workflow_id: String) -> CmdResult<Vec<ChatSession>> {
    ChatSessionStore::list_history(&workflow_id).await.stringify_err()
}

#[tauri::command]
pub async fn chat_session_archive(id: String) -> CmdResult {
    ChatSessionStore::get(&id).await.stringify_err()?;
    ChatSessionStore::archive(&id).await.stringify_err()
}
