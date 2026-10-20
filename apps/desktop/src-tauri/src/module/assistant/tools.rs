//! Registry and execution policy for main-agent tools. Skills cannot expand grants.
use anyhow::{Result, bail};
use serde::Deserialize;
use serde_json::{Value, json};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub id: String,
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[async_trait::async_trait]
pub trait WorkflowDiscovery: Send + Sync {
    async fn list(&self, args: &Value) -> Result<Value>;
    async fn describe(&self, id: &str) -> Result<Capability>;
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        self.list(args).await
    }
    async fn describe_capability(&self, id: &str) -> Result<Capability> {
        self.describe(id).await
    }
    async fn workspace_resource(&self, _name: &str, _args: &Value) -> Result<Value> {
        bail!("Workspace resources are unavailable")
    }
    async fn workflow_plan(&self, _session: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn plan_operation(
        &self,
        _session: &str,
        _name: &str,
        _args: &Value,
        _artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        bail!("Workflow planning is unavailable")
    }
    async fn pending_tool_call(&self, _session: &str) -> Result<Option<Value>> {
        Ok(None)
    }
    async fn deny_tool_call(&self, _session: &str, _id: &str) -> Result<Value> {
        bail!("Tool confirmations are unavailable")
    }
    async fn call_workspace_tool(
        &self,
        _session: &str,
        _turn: &str,
        _args: &Value,
        _approved: Option<&str>,
    ) -> Result<Value> {
        bail!("Workspace tool execution is unavailable")
    }
    async fn direct(
        &self,
        _name: &str,
        _args: &Value,
        _artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        bail!("Direct tools are unavailable")
    }
    async fn inspect_operations(&self, _session_id: &str) -> Result<Value> {
        Ok(json!({"items":[]}))
    }
    async fn record_turn(&self, _record: &Value) -> Result<()> {
        Ok(())
    }
    async fn record_operation(&self, _record: &Value) -> Result<()> {
        Ok(())
    }
    async fn authoring(&self, _name: &str, _args: &Value) -> Result<Value> {
        bail!("Native authoring is unavailable")
    }
}

pub(in crate::module::assistant) const EXECUTE_WORKFLOW: &str = "execute_workflow";

pub(in crate::module::assistant) fn list_page(capabilities: &[Capability], args: &Value) -> Result<Value> {
    let query = args.get("query").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let id = args.get("workflow_id").and_then(Value::as_str);
    let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50) as usize;
    let offset = args
        .get("cursor")
        .and_then(Value::as_str)
        .unwrap_or("0")
        .parse::<usize>()?;
    let filtered = capabilities
        .iter()
        .filter(|cap| {
            id.is_none_or(|id| cap.id == id)
                && (query.is_empty()
                    || format!("{} {}", cap.name, cap.description)
                        .to_lowercase()
                        .contains(&query))
        })
        .collect::<Vec<_>>();
    let items = filtered
        .iter()
        .skip(offset)
        .take(limit)
        .map(|cap| json!({"id":cap.id,"name":cap.name,"description":cap.description,"inputSchema":cap.parameters}))
        .collect::<Vec<_>>();
    let next = offset.saturating_add(items.len());
    Ok(json!({"items":items,"nextCursor":(next < filtered.len()).then(||next.to_string())}))
}
