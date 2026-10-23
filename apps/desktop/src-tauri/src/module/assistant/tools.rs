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

/// A literal miss is not evidence that no reusable capability exists (notably
/// across languages). Supply a small unfiltered page in the same tool response.
pub(super) async fn discover_capabilities(discovery: &dyn WorkflowDiscovery, args: &Value) -> Result<Value> {
    let result = discovery.list_capabilities(args).await?;
    if args["capability_id"].is_string()
        || args["query"].as_str().unwrap_or("").trim().is_empty()
        || args["cursor"].as_str().is_some_and(|cursor| !cursor.is_empty())
        || !result["items"].as_array().is_some_and(Vec::is_empty)
    {
        return Ok(result);
    }
    let mut fallback = discovery
        .list_capabilities(&json!({"limit":args["limit"].as_u64().unwrap_or(5).clamp(1,5)}))
        .await?;
    fallback["searchFallback"] = json!({"query":args["query"],"reason":"No literal matches. These are unfiltered recent summaries, not semantic matches. Compare purpose and fetch the selected exact contract before reuse or new planning. For further pages omit query and use nextCursor."});
    Ok(fallback)
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

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use std::sync::Mutex;
    struct Search {
        calls: Mutex<Vec<Value>>,
    }
    #[async_trait::async_trait]
    impl WorkflowDiscovery for Search {
        async fn list(&self, args: &Value) -> Result<Value> {
            self.calls.lock().unwrap().push(args.clone());
            if args["query"].is_string() || args["capability_id"].is_string() {
                return Ok(json!({"items":[],"nextCursor":null}));
            }
            Ok(json!({"items":[{"id":"existing","name":"已有的文档整理流程"}],"nextCursor":"5"}))
        }
        async fn describe(&self, _: &str) -> Result<Capability> {
            bail!("unused")
        }
    }
    #[tokio::test]
    async fn literal_misses_return_bounded_candidates_without_another_model_turn() {
        let search = Search {
            calls: Mutex::new(vec![]),
        };
        let result = discover_capabilities(&search, &json!({"query":"document organization workflow","limit":50}))
            .await
            .unwrap();
        assert_eq!(result["items"][0]["id"], "existing");
        assert_eq!(result["searchFallback"]["query"], "document organization workflow");
        assert_eq!(result["nextCursor"], "5");
        let calls = search.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1], json!({"limit":5}));
    }
    #[tokio::test]
    async fn exact_lookup_and_later_pages_never_substitute_unrelated_candidates() {
        for args in [
            json!({"capability_id":"gone"}),
            json!({"query":"missing","cursor":"5"}),
            json!({"limit":5}),
        ] {
            let search = Search {
                calls: Mutex::new(vec![]),
            };
            discover_capabilities(&search, &args).await.unwrap();
            assert_eq!(search.calls.lock().unwrap().len(), 1);
        }
    }
}
