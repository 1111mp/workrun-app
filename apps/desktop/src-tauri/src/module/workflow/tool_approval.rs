use crate::singleton;
use anyhow::{Result, bail};
use std::{collections::HashMap, sync::Mutex};
use tokio::sync::oneshot;

struct PendingToolApproval {
    sender: oneshot::Sender<bool>,
    fingerprint: String,
}

/// Process-local, thread-safe state for tool execution approvals.
pub(super) struct ToolApprovalRegistry {
    pending: Mutex<HashMap<String, PendingToolApproval>>,
}

singleton!(ToolApprovalRegistry, TOOL_APPROVAL_REGISTRY);

impl ToolApprovalRegistry {
    fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub(super) async fn request_approval<F>(
        &self,
        request_id: String,
        fingerprint: String,
        on_requested: F,
    ) -> adk_rust::Result<bool>
    where
        F: FnOnce(),
    {
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| adk_rust::AdkError::tool("Tool approval registry is unavailable"))?;
            if pending.contains_key(&request_id) {
                return Err(adk_rust::AdkError::tool(format!(
                    "Tool confirmation is already pending for request `{request_id}`"
                )));
            }
            pending.insert(request_id.clone(), PendingToolApproval { sender, fingerprint });
        }

        on_requested();

        let approved = tokio::time::timeout(std::time::Duration::from_secs(300), receiver)
            .await
            .ok()
            .and_then(|value| value.ok())
            .unwrap_or(false);
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));

        Ok(approved)
    }

    pub(super) fn resolve(&self, request_id: &str, fingerprint: &str, approved: bool) -> Result<()> {
        let approval = self.pending.lock().ok().and_then(|mut pending| {
            let expected = pending.get(request_id)?;
            (expected.fingerprint == fingerprint)
                .then(|| pending.remove(request_id))
                .flatten()
        });
        let Some(approval) = approval else {
            bail!("Tool approval request is no longer pending")
        };
        let _ = approval.sender.send(approved);
        Ok(())
    }
}
