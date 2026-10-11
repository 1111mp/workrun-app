//! Native ownership keeps incoming links alive while the webview starts or reloads.
use anyhow::{Result, bail};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;
use uuid::Uuid;

use crate::{core::handle, process::AsyncHandler, singleton};

use super::{
    run_history::RunHistoryStore,
    run_manager::{self, StartAppRun, StartWorkflowRun},
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LinkRequest {
    pub target_type: String,
    pub target_id: String,
    pub action: String,
    pub input: Value,
    pub request_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingLink {
    pub id: String,
    pub request: Option<LinkRequest>,
    pub error: Option<String>,
    pub run_id: Option<String>,
    pub workspace_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeeplinkUpdate {
    pub revision: u64,
    pub pending: Option<IncomingLink>,
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "request", rename_all = "lowercase")]
pub enum ExecutionRequest {
    App(Box<StartAppRun>),
    Workflow(Box<StartWorkflowRun>),
}

/// Owns pending links and submission synchronization for the desktop process.
#[derive(Default)]
pub struct DeeplinkManager {
    ready: AtomicBool,
    queue: Mutex<VecDeque<IncomingLink>>,
    submit_lock: tokio::sync::Mutex<()>,
    update_lock: tokio::sync::Mutex<()>,
    revision: AtomicU64,
}

singleton!(DeeplinkManager, DEEPLINK_MANAGER, DeeplinkManager::default());

impl DeeplinkManager {
    fn show_window() {
        AsyncHandler::spawn(|| async {
            let _ = crate::utils::window_manager::WindowManager::show_main_window().await;
        });
    }

    pub fn ready(&'static self) {
        self.ready.store(true, Ordering::Release);
        if !self.queue.lock().is_empty() {
            Self::show_window();
        }
        self.notify_frontend();
    }

    pub async fn snapshot(&self) -> Result<DeeplinkUpdate> {
        // Serialize snapshot reads so a slow history lookup cannot publish an
        // older queue head with a newer revision than a later read.
        let _guard = self.update_lock.lock().await;
        let pending = self.pending().await?;
        Ok(DeeplinkUpdate {
            revision: self.revision.fetch_add(1, Ordering::AcqRel) + 1,
            pending,
        })
    }

    pub fn notify_frontend(&'static self) {
        if !self.ready.load(Ordering::Acquire) {
            return;
        }
        AsyncHandler::spawn(move || async move {
            let result = async {
                let update = self.snapshot().await?;
                let app_handle = handle::Handle::app_handle();
                app_handle.emit_to("main", "deeplink-request", update)?;
                Ok::<_, anyhow::Error>(())
            }
            .await;
            if let Err(error) = result {
                crate::logging!(
                    error,
                    crate::utils::logging::Type::Setup,
                    "Failed to push deeplink request: {error}"
                );
            }
        });
    }

    async fn pending(&self) -> Result<Option<IncomingLink>> {
        if !self.ready.load(Ordering::Acquire) {
            return Ok(None);
        }
        let workspace = crate::utils::dirs::active_workspace_id();
        let entry = {
            let mut queue = self.queue.lock();
            if let Some(entry) = queue.front_mut() {
                entry.workspace_id.get_or_insert_with(|| workspace.clone());
            }
            queue.front().cloned()
        };
        let Some(mut entry) = entry else {
            return Ok(None);
        };
        if entry.workspace_id.as_deref() != Some(&workspace) {
            entry.error = Some(
                "Workspace changed. Dismiss this request and open the link again in the intended workspace.".into(),
            );
            return Ok(Some(entry));
        }
        if let Some(link) = &entry.request
            && link.action == "run"
        {
            let run_id = Self::run_id_for(link, &entry.id, &workspace)?;
            let pool = crate::core::db::DBManager::global().pool()?;
            match Self::existing_run(&pool, &run_id, &workspace, link).await {
                Ok(true) => entry.run_id = Some(run_id),
                Ok(false) => {},
                Err(error) => entry.error = Some(error.to_string()),
            }
        }
        Ok(Some(entry))
    }

    pub fn dismiss(&'static self, id: &str) {
        self.queue.lock().retain(|entry| entry.id != id);
        self.notify_frontend();
    }

    fn parse(url: &Url) -> Result<LinkRequest> {
        if url.scheme() != "workrun" || url.host_str() != Some("v1") {
            bail!("Unsupported Workrun link version");
        }
        if !url.username().is_empty() || url.password().is_some() || url.port().is_some() || url.fragment().is_some() {
            bail!("Invalid Workrun link");
        }
        let parts: Vec<_> = url.path().trim_start_matches('/').split('/').collect();
        if !(parts.len() == 2 || parts.len() == 3 && parts[2] == "run") || !matches!(parts[0], "apps" | "workflows") {
            bail!("Expected /apps/{{id}} or /workflows/{{id}}, optionally followed by /run");
        }
        let id = parts[1];
        if id.is_empty()
            || id.len() > 256
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
        {
            bail!("Invalid target ID");
        }
        let mut input = None;
        let mut request_id = None;
        for (key, value) in url.query_pairs() {
            match key.as_ref() {
                "input" if input.is_none() => {
                    let parsed: Value = serde_json::from_str(&value)?;
                    if !parsed.is_object() {
                        bail!("Input must be a JSON object");
                    }
                    input = Some(parsed);
                },
                "requestId" if request_id.is_none() && !value.trim().is_empty() && value.len() <= 256 => {
                    request_id = Some(value.into_owned())
                },
                _ => bail!("Unknown, repeated, or invalid link parameter: {key}"),
            }
        }
        let action = if parts.len() == 3 { "run" } else { "open" };
        if (parts[0] == "apps" || action == "open") && input.is_some() {
            bail!("Input is supported only for Workflow run links");
        }
        if action == "open" && request_id.is_some() {
            bail!("requestId is supported only for run links");
        }
        Ok(LinkRequest {
            target_type: parts[0].into(),
            target_id: id.into(),
            action: action.into(),
            input: input.unwrap_or(json!({})),
            request_id,
        })
    }

    fn receive(&'static self, urls: Vec<Url>) {
        for url in urls {
            // OAuth links belong to the existing authentication handler.
            if url.scheme() != "workrun" || url.path().starts_with("/api/auth/") {
                continue;
            }
            let result = if url.as_str().len() > 32_768 {
                Err(anyhow::anyhow!("Workrun link exceeds 32 KB"))
            } else {
                Self::parse(&url)
            };
            let mut queue = self.queue.lock();
            let entry = match result {
                Ok(request) => {
                    if (request.request_id.is_some() || !self.ready.load(Ordering::Acquire))
                        && queue.iter().any(|entry| entry.request.as_ref() == Some(&request))
                    {
                        continue;
                    }
                    IncomingLink {
                        id: Uuid::new_v4().to_string(),
                        request: Some(request),
                        error: None,
                        run_id: None,
                        workspace_id: None,
                    }
                },
                Err(error) => IncomingLink {
                    id: Uuid::new_v4().to_string(),
                    request: None,
                    error: Some(error.to_string()),
                    run_id: None,
                    workspace_id: None,
                },
            };
            queue.push_back(entry);
            drop(queue);
            if self.ready.load(Ordering::Acquire) {
                Self::show_window();
            }
        }
        self.notify_frontend();
    }

    pub fn setup(&'static self, app: &tauri::App) -> Result<()> {
        // AppImages and Windows development builds may not have an installer to
        // register their protocol. Registration failure must not block startup.
        #[cfg(any(target_os = "linux", all(target_os = "windows", debug_assertions)))]
        if let Err(error) = app.deep_link().register_all() {
            crate::logging!(
                warn,
                crate::utils::logging::Type::Setup,
                "Failed to register Workrun protocol: {error}"
            );
        }
        app.deep_link().on_open_url(move |event| self.receive(event.urls()));
        if let Some(urls) = app.deep_link().get_current()? {
            self.receive(urls);
        }
        Ok(())
    }

    fn run_id_for(link: &LinkRequest, id: &str, workspace: &str) -> Result<String> {
        Ok(match &link.request_id {
            Some(request_id) => format!(
                "deeplink-{:x}",
                Sha256::digest(serde_json::to_vec(&json!([workspace, request_id]))?)
            ),
            None => format!("deeplink-{id}"),
        })
    }

    async fn existing_run(pool: &sqlx::SqlitePool, run_id: &str, workspace: &str, link: &LinkRequest) -> Result<bool> {
        let existing: Option<String> =
            sqlx::query_scalar("SELECT runtime_json FROM run_records WHERE id = ? AND workspace_id = ?")
                .bind(run_id)
                .bind(workspace)
                .fetch_optional(pool)
                .await?;
        if let Some(runtime) = existing {
            if serde_json::from_str::<Value>(&runtime)?["trigger"] != json!({ "type": "deeplink", "request": link }) {
                bail!("requestId was already used with different parameters");
            }
            return Ok(true);
        }
        Ok(false)
    }

    pub async fn submit(&self, id: String, execution: ExecutionRequest) -> Result<String> {
        // Serialize submissions so double clicks and reloads cannot race creation.
        let _guard = self.submit_lock.lock().await;
        let entry = self
            .queue
            .lock()
            .iter()
            .find(|entry| entry.id == id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Link request is no longer pending"))?;
        let workspace = crate::utils::dirs::active_workspace_id();
        if entry.workspace_id.as_deref() != Some(&workspace) {
            bail!("Workspace changed. Open the link again in the intended workspace.");
        }
        let link = entry.request.ok_or_else(|| anyhow::anyhow!("Invalid link request"))?;
        if link.action != "run" {
            bail!("This link does not request execution");
        }
        let run_id = Self::run_id_for(&link, &id, &workspace)?;
        let trigger = json!({ "type": "deeplink", "request": link });
        let pool = crate::core::db::DBManager::global().pool()?;
        if Self::existing_run(&pool, &run_id, &workspace, &link).await? {
            return Ok(run_id);
        }
        match execution {
            ExecutionRequest::App(mut request) => {
                if link.target_type != "apps" || request.target_id != link.target_id {
                    bail!("Link target mismatch");
                }
                request.run_id = run_id.clone();
                request.schedule_trigger = None;
                request.deeplink_trigger = Some(trigger);
                run_manager::start_app(*request).await?;
            },
            ExecutionRequest::Workflow(mut request) => {
                if link.target_type != "workflows" || request.target_id != link.target_id {
                    bail!("Link target mismatch");
                }
                request.run_id = run_id.clone();
                request.schedule_trigger = None;
                request.deeplink_trigger = Some(trigger);
                run_manager::start_workflow(*request).await?;
            },
        }
        RunHistoryStore::ensure_active_workspace(&run_id).await?;
        Ok(run_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn snapshots_retain_cold_start_links_and_advance_the_queue() {
        let manager = DeeplinkManager::default();
        for id in ["first", "next"] {
            manager.queue.lock().push_back(IncomingLink {
                id: id.into(),
                request: Some(
                    DeeplinkManager::parse(&Url::parse(&format!("workrun://v1/apps/{id}")).unwrap()).unwrap(),
                ),
                error: None,
                run_id: None,
                workspace_id: None,
            });
        }
        let cold = manager.snapshot().await.unwrap();
        assert!(cold.pending.is_none());
        assert_eq!(manager.queue.lock().len(), 2);
        manager.ready.store(true, Ordering::Release);
        let first = manager.snapshot().await.unwrap();
        assert_eq!(first.pending.unwrap().id, "first");
        manager.queue.lock().pop_front();
        let next = manager.snapshot().await.unwrap();
        assert_eq!(next.pending.unwrap().id, "next");
        manager.queue.lock().pop_front();
        let empty = manager.snapshot().await.unwrap();
        assert!(empty.pending.is_none());
        assert!(cold.revision < first.revision && first.revision < next.revision && next.revision < empty.revision);
    }

    #[test]
    fn parses_open_and_run_inputs() {
        let open = DeeplinkManager::parse(&Url::parse("workrun://v1/apps/app-1").unwrap()).unwrap();
        assert_eq!(open.action, "open");
        let run = DeeplinkManager::parse(
            &Url::parse("workrun://v1/workflows/w-1/run?input=%7B%22n%22%3A2%7D&requestId=one").unwrap(),
        )
        .unwrap();
        assert_eq!(run.input, json!({"n": 2}));
        assert_eq!(run.request_id.as_deref(), Some("one"));
    }
    #[tokio::test]
    async fn reuses_durable_runs_and_rejects_request_id_conflicts() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE run_records (id TEXT PRIMARY KEY, workspace_id TEXT, runtime_json TEXT)")
            .execute(&pool)
            .await
            .unwrap();
        let link =
            DeeplinkManager::parse(&Url::parse("workrun://v1/workflows/w-1/run?requestId=one").unwrap()).unwrap();
        let id = DeeplinkManager::run_id_for(&link, "delivery-1", "personal").unwrap();
        assert_eq!(
            id,
            DeeplinkManager::run_id_for(&link, "delivery-2", "personal").unwrap()
        );
        assert_ne!(id, DeeplinkManager::run_id_for(&link, "delivery-1", "team").unwrap());
        assert!(
            !DeeplinkManager::existing_run(&pool, &id, "personal", &link)
                .await
                .unwrap()
        );
        sqlx::query("INSERT INTO run_records VALUES (?, ?, ?)")
            .bind(&id)
            .bind("personal")
            .bind(json!({"trigger": {"type": "deeplink", "request": link}}).to_string())
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            DeeplinkManager::existing_run(&pool, &id, "personal", &link)
                .await
                .unwrap()
        );
        assert!(!DeeplinkManager::existing_run(&pool, &id, "team", &link).await.unwrap());
        let mut changed = link.clone();
        changed.input = json!({"message": "different"});
        assert!(
            DeeplinkManager::existing_run(&pool, &id, "personal", &changed)
                .await
                .is_err()
        );
        changed = link;
        changed.target_id = "other".into();
        assert!(
            DeeplinkManager::existing_run(&pool, &id, "personal", &changed)
                .await
                .is_err()
        );
        changed.request_id = None;
        assert_ne!(
            DeeplinkManager::run_id_for(&changed, "delivery-1", "personal").unwrap(),
            DeeplinkManager::run_id_for(&changed, "delivery-2", "personal").unwrap()
        );
    }

    #[test]
    fn rejects_invalid_links() {
        for url in [
            "workrun://v2/apps/a",
            "workrun://v1/apps/a/run?input={}",
            "workrun://v1/workflows/a/run?input=[]",
            "workrun://v1/workflows/a/run?requestId=x&requestId=y",
            "workrun://v1/apps/a/run?confirm=false",
            "workrun://v1/apps/a/other",
            "workrun://v1/apps/a#run",
            "workrun://v1/apps/a%2Fb",
        ] {
            assert!(DeeplinkManager::parse(&Url::parse(url).unwrap()).is_err(), "{url}");
        }
    }
}
