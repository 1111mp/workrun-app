//! Renderer notifications are sent only after the corresponding database write commits.
use serde_json::json;

pub(crate) struct ScheduleEvents;

impl ScheduleEvents {
    pub fn tasks(workspace: &str) {
        Self::publish("schedules-changed", json!({"workspaceId":workspace}));
    }

    pub fn session(workspace: &str, id: &str) {
        Self::publish(
            "schedule-session-changed",
            json!({"workspaceId":workspace,"sessionId":id}),
        );
    }

    fn publish(name: &'static str, payload: serde_json::Value) {
        if let Err(error) = crate::module::run_manager::emit_on_main_thread(name, payload) {
            log::warn!("failed to publish {name}: {error}");
        }
    }
}
