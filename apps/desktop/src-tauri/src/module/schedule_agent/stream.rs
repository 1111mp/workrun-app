//! One model phase per stream, so tool narration cannot become the final reply.
use crate::module::assistant::AssistantStreamEvent;
use anyhow::Result;
use serde_json::{Value, json};
use std::sync::Mutex;
use tauri::ipc::Channel;

pub(super) struct ScheduleResponseStream<'a> {
    channel: &'a Channel<Value>,
    id: String,
    reasoning: Mutex<Vec<Value>>,
}

impl<'a> ScheduleResponseStream<'a> {
    pub fn new(channel: &'a Channel<Value>) -> Self {
        let stream = Self {
            channel,
            reasoning: Mutex::new(Vec::new()),
            id: uuid::Uuid::new_v4().to_string(),
        };
        stream.send(json!({"type":"phase_start","phaseId":stream.id}));
        stream
    }

    pub fn reasoning(&self) -> Vec<Value> {
        self.reasoning.lock().unwrap().clone()
    }

    pub fn forward(&self, event: AssistantStreamEvent) -> Result<()> {
        if let AssistantStreamEvent::Reasoning {
            id,
            text,
            duration_ms,
            complete,
        } = &event
        {
            let mut records = self.reasoning.lock().unwrap();
            let value = json!({"id":id,"phaseId":self.id,"turnId":self.id,"text":text,"durationMs":duration_ms,"complete":complete});
            if let Some(previous) = records.iter_mut().find(|record| record["id"] == *id) {
                *previous = value;
            } else {
                records.push(value);
            }
        }
        if matches!(
            event,
            AssistantStreamEvent::TextDelta { .. }
                | AssistantStreamEvent::TextReplace { .. }
                | AssistantStreamEvent::Activity { .. }
                | AssistantStreamEvent::Reasoning { .. }
        ) {
            let mut value = serde_json::to_value(event)?;
            value["phaseId"] = json!(self.id);
            self.send(value);
        }
        Ok(())
    }

    pub fn finish(&self, has_tools: bool) {
        self.send(json!({"type":"phase_end","phaseId":self.id,"kind":if has_tools {"activity"} else {"answer"}}));
    }

    pub fn tool_start(&self, name: &str) {
        self.send(json!({"type":"tool_start","phaseId":self.id,"name":name}));
    }

    fn send(&self, value: Value) {
        // A detached renderer must not abort native session persistence.
        let _ = self.channel.send(value);
    }
}
