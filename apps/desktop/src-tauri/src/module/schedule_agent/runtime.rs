//! Process-local leases and response cancellation for scheduling sessions.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
use tokio_util::sync::CancellationToken;

type SessionKey = (String, String);

#[derive(Default)]
pub(super) struct ScheduleRuntime {
    leases: Mutex<HashMap<SessionKey, Arc<tokio::sync::Mutex<()>>>>,
    running: Mutex<HashMap<SessionKey, CancellationToken>>,
}

impl ScheduleRuntime {
    pub fn global() -> &'static Self {
        static RUNTIME: OnceLock<ScheduleRuntime> = OnceLock::new();
        RUNTIME.get_or_init(Self::default)
    }

    pub fn lease(&self, workspace: &str, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.leases
            .lock()
            .unwrap()
            .entry((workspace.into(), id.into()))
            .or_default()
            .clone()
    }

    pub fn is_running(&self, workspace: &str, id: &str) -> bool {
        self.running
            .lock()
            .unwrap()
            .contains_key(&(workspace.into(), id.into()))
    }

    pub fn start(&self, workspace: &str, id: &str) -> CancellationToken {
        let cancel = CancellationToken::new();
        self.running
            .lock()
            .unwrap()
            .insert((workspace.into(), id.into()), cancel.clone());
        cancel
    }

    pub fn finish(&self, workspace: &str, id: &str) {
        self.running.lock().unwrap().remove(&(workspace.into(), id.into()));
    }

    pub fn stop(&self, workspace: &str, id: &str) {
        if let Some(cancel) = self.running.lock().unwrap().get(&(workspace.into(), id.into())) {
            cancel.cancel();
        }
    }
}
