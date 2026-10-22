//! Native workflow discovery, version resolution and dependency preparation.
use super::tools::Capability;
use crate::{
    config::{BaseConfig, IProcessNode},
    feat,
    module::{process_node::ProcessNodeInstallStatus, workflow::WorkflowDsl},
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tauri_plugin_http::reqwest::{Client, Response};

pub struct Catalog {
    workflows: Vec<Value>,
    team: Option<TeamApi>,
    root: std::path::PathBuf,
    workspace_id: String,
}
struct TeamApi {
    base: String,
    token: String,
    client: Client,
}
impl TeamApi {
    async fn response(&self, path: &str) -> Result<Response> {
        // Never follow a redirect with workspace authentication or accept a
        // model-supplied URL. All paths are generated from the native catalog.
        let response = self
            .client
            .get(format!("{}/api/v1{path}", self.base.trim_end_matches('/')))
            .bearer_auth(&self.token)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("Team API request failed ({})", response.status());
        }
        Ok(response)
    }
    async fn get(&self, path: &str) -> Result<Value> {
        let envelope: Value = self.response(path).await?.json().await?;
        if envelope["errorCode"].as_i64() != Some(0) {
            bail!("Team API rejected the request");
        }
        Ok(envelope["payload"].clone())
    }
}
impl Catalog {
    pub async fn load(team_token: Option<&str>) -> Result<Self> {
        let config = BaseConfig::workrun().await.data_arc();
        let team = if dirs::is_team_workspace() {
            Some(TeamApi {
                base: config
                    .team
                    .as_ref()
                    .context("Team server is not configured")?
                    .server_url
                    .clone(),
                token: team_token
                    .filter(|token| !token.is_empty())
                    .context("Sign in to access Team workflows")?
                    .into(),
                client: Client::builder()
                    .redirect(tauri_plugin_http::reqwest::redirect::Policy::none())
                    .timeout(std::time::Duration::from_secs(60))
                    .build()?,
            })
        } else {
            None
        };
        // The catalog is fetched only when list_workflow/execute_workflow needs
        // it. Ordinary conversation must not depend on the Team server being up.
        let mut workflows = if team.is_none() {
            feat::get_workflows()
                .await?
                .into_iter()
                .map(serde_json::to_value)
                .collect::<std::result::Result<Vec<_>, _>>()?
        } else {
            vec![]
        };
        workflows.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        Ok(Self {
            workflows,
            team,
            root: dirs::app_home_dir()?,
            workspace_id: dirs::active_workspace_id(),
        })
    }
    pub fn capabilities(&self) -> Vec<Capability> {
        self.workflows.iter().filter_map(capability).collect()
    }

    pub async fn resolve(&self, id: &str) -> Result<Value> {
        if let Some(id) = id.strip_prefix("app:") {
            return super::capability::app_workflow(&feat::process_node_inspect(id).await?);
        }
        if let Some(api) = &self.team {
            let encoded = encoded(id);
            // Both endpoints enforce server-side ownership/publication ACLs.
            match api.get(&format!("/workflow/{encoded}")).await {
                Ok(workflow) => Ok(workflow),
                Err(_) => api.get(&format!("/workflow/team/{encoded}")).await,
            }
        } else {
            Ok(serde_json::to_value(feat::get_workflow(id).await?)?)
        }
    }
    pub async fn prepare(&self, workflow: &Value) -> Result<Value> {
        let mut dsl = document_dsl(workflow)?;
        if let Some(api) = &self.team {
            let scope = format!(
                "release-{}",
                workflow["releaseId"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("draft-{}", workflow["id"].as_str().unwrap_or_default()))
            );
            for node in dsl["nodes"].as_array_mut().context("Workflow nodes are missing")? {
                let reference = node["data"]["appRef"].clone();
                if node["type"] != "process" || reference["source"] != "team" {
                    continue;
                }
                let app = reference["remoteAppId"].as_str().context("Missing Team app ID")?;
                let release = reference["releaseId"].as_str().context("Missing Team app release")?;
                let sha = reference["archiveSha256"]
                    .as_str()
                    .context("Missing Team app checksum")?;
                let installed = feat::process_node_find_team_release(app, release, &scope).await?;
                let local = if let Some(node) = installed.filter(|node| {
                    matches!(node.install_status, ProcessNodeInstallStatus::Installed)
                        && node.definition.remote_archive_sha256.as_deref() == Some(sha)
                }) {
                    node
                } else {
                    let path = format!("/app/catalog/{}/releases/{}", encoded(app), encoded(release));
                    let mut definition = api.get(&path).await?;
                    definition["remoteAppId"] = json!(app);
                    definition["remoteReleaseId"] = json!(release);
                    definition["remoteArchiveSha256"] = json!(sha);
                    let response = api.response(&format!("{path}/source-archive")).await?;
                    if response.headers().get("x-workrun-sha256").and_then(|v| v.to_str().ok()) != Some(sha) {
                        bail!("Team app archive checksum changed");
                    }
                    let temporary = tempfile::NamedTempFile::new()?;
                    let mut file = tokio::fs::File::create(temporary.path()).await?;
                    let mut response = response;
                    use tokio::io::AsyncWriteExt;
                    while let Some(bytes) = response.chunk().await? {
                        file.write_all(&bytes).await?;
                    }
                    file.flush().await?;
                    drop(file);
                    feat::install_process_node_archive(
                        feat::InstallProcessNodeArchiveRequest {
                            definition: serde_json::from_value::<IProcessNode>(definition)?,
                            archive_path: temporary.path().into(),
                            sha256: sha.into(),
                            release_id: release.into(),
                            installation_scope: Some(scope.clone()),
                        },
                        tauri::ipc::Channel::new(|_| Ok(())),
                    )
                    .await?
                };
                node["data"]["processNodeId"] = json!(local.definition.id);
            }
        }
        let config = BaseConfig::workrun().await.data_arc();
        crate::module::workflow::compile(serde_json::from_value::<WorkflowDsl>(dsl.clone())?, &config, None).await?;
        Ok(dsl)
    }
}

pub fn parameters(settings: &Value) -> Value {
    if let Some(schema) = settings.get("capabilityInputSchema") {
        return schema.clone();
    }
    let mut fields = settings["inputSchema"]["fields"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if settings["mode"] == "chat" && !fields.iter().any(|field| field["key"] == "input") {
        fields.push(json!({"key":"input","label":"Message","type":"textarea","required":true}));
    }
    let mut properties = serde_json::Map::new();
    let mut required = vec![];
    for field in fields {
        let Some(key) = field["key"].as_str() else {
            continue;
        };
        let kind = match field["type"].as_str().unwrap_or("string") {
            "number" => "number",
            "boolean" => "boolean",
            "file" => "object",
            "files" => "array",
            _ => "string",
        };
        let mut schema = json!({"type":kind,"description":format!("{} {}",field["label"].as_str().unwrap_or(key),field["description"].as_str().unwrap_or(""))});
        if kind == "array" {
            schema["items"] = json!({"type":"object"});
        }
        properties.insert(key.into(), schema);
        if field["required"] == true {
            required.push(json!(key));
        }
    }
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}
pub fn validate_input(settings: &Value, input: &Value) -> Result<bool> {
    let schema = parameters(settings);
    let values = input.as_object().context("Workflow input must be an object")?;
    // Validate types/unknown keys first; collect missing required values through
    // the existing conversation form without dispatching a partial operation.
    let mut supplied_schema = schema.clone();
    supplied_schema["required"] = json!([]);
    let mut supplied = input.clone();
    let native_schema = settings.get("capabilityInputSchema").is_some();
    if !native_schema {
        supplied.as_object_mut().unwrap().retain(|_, value| !value.is_null());
    }
    if !jsonschema::validator_for(&supplied_schema)?.is_valid(&supplied) {
        bail!("Workflow input does not match its inputSchema");
    }
    let missing = schema["required"].as_array().unwrap().iter().any(|key| {
        if native_schema {
            return !values.contains_key(key.as_str().unwrap());
        }
        values.get(key.as_str().unwrap()).is_none_or(|v| {
            v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()) || v.as_array().is_some_and(Vec::is_empty)
        })
    });
    if !missing && settings.get("capabilityInputSchema").is_none() {
        crate::module::artifact::validate_input(&settings["inputSchema"], input)?;
    }
    Ok(!missing)
}
pub fn document_dsl(workflow: &Value) -> Result<Value> {
    let document = &workflow["document"];
    let settings = &document["settings"];
    let dsl = json!({"id":workflow["id"],"name":settings["name"],"description":settings["description"],"mode":settings["mode"],
        "inputSchema":settings["inputSchema"],"outputSchema":settings.get("outputSchema").cloned().unwrap_or(json!({"fields":[]})),
        "sessionStateFields":settings.get("sessionStateFields").cloned().unwrap_or(json!([])),"nodes":document["nodes"],"edges":document["edges"]});
    serde_json::from_value::<WorkflowDsl>(dsl.clone()).context("Invalid workflow document")?;
    Ok(dsl)
}

fn encoded(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

impl Catalog {
    async fn plan_dependencies(
        &self,
        document: &super::planning_agent::plans::Document,
        artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Vec<String>> {
        use super::tools::WorkflowDiscovery;
        let mut issues = vec![];
        for input in &document.inputs {
            if let Some(id) = &input.artifact_id {
                let reference = artifacts
                    .iter()
                    .find(|artifact| &artifact.id == id)
                    .context("Plan refers to an unauthorized attachment")?;
                crate::module::artifact::ArtifactStore::active()?.resolve(reference)?;
            }
        }
        let dependencies = document
            .steps
            .iter()
            .flat_map(|step| &step.dependencies)
            .collect::<Vec<_>>();
        let tools = if dependencies.iter().any(|d| d.kind == "tool") {
            crate::module::tool_registry::ToolRegistry::list().await?
        } else {
            vec![]
        };
        let skills = if dependencies.iter().any(|d| d.kind == "skill") {
            crate::module::skill::SkillRegistry::list()?
        } else {
            vec![]
        };
        let models = crate::config::model_catalog();
        for dependency in dependencies {
            let available = match dependency.kind.as_str() {
                "model" => models.iter().any(|model| model.id == dependency.id),
                "tool" => tools.iter().any(|tool| tool.id == dependency.id),
                "skill" => skills.iter().any(|skill| skill.name == dependency.id),
                "workflow" | "app" => self.describe_capability(&dependency.id).await.is_ok(),
                _ => false,
            };
            if !available {
                issues.push(format!("Unavailable {} dependency: {}", dependency.kind, dependency.id));
            }
        }
        if let Some(id) = &document.target_id
            && self.describe(id).await.is_err()
        {
            issues.push(format!("Workflow revision target is unavailable: {id}"));
        }
        Ok(issues)
    }
}

#[async_trait::async_trait]
impl super::tools::WorkflowDiscovery for Catalog {
    async fn direct(
        &self,
        name: &str,
        args: &Value,
        artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        let store = crate::module::artifact::ArtifactStore::active()?;
        let (name, args, artifacts) = (name.to_owned(), args.clone(), artifacts.to_vec());
        let result =
            tokio::task::spawn_blocking(move || super::main_agent::direct::execute(store, &name, &args, &artifacts))
                .await??;
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        Ok(result)
    }
    async fn inspect_operations(&self, session_id: &str) -> Result<Value> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        let directory = self.root.join("assistant/operations");
        let mut records = vec![];
        if directory.exists() {
            for entry in std::fs::read_dir(directory)? {
                let path = entry?.path();
                if path.extension().is_none_or(|extension| extension != "json") {
                    continue;
                }
                let record: Value = serde_json::from_slice(&std::fs::read(path)?)?;
                if record["sessionId"].as_str() != Some(session_id) {
                    continue;
                }
                records.push(json!({"id":record["id"],"kind":record["kind"],"name":record["name"],"toolId":record["tool"]["id"],"toolName":record["tool"]["displayName"],"startedAt":record["startedAt"],"status":if record["status"]=="running" {json!("interrupted")} else {record["status"].clone()},"result":record["result"]}));
            }
        }
        records.sort_by(|left, right| right["startedAt"].as_str().cmp(&left["startedAt"].as_str()));
        records.truncate(5);
        Ok(
            json!({"items":records,"note":"Interrupted operations have an uncertain outcome. Inspect existing state; do not recreate or rerun automatically."}),
        )
    }
    async fn record_turn(&self, record: &Value) -> Result<()> {
        self.record_operation(record).await
    }
    async fn record_operation(&self, record: &Value) -> Result<()> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        let id = uuid::Uuid::parse_str(record["id"].as_str().context("Operation ID missing")?)?;
        let directory = self.root.join("assistant/operations");
        std::fs::create_dir_all(&directory)?;
        use std::io::Write;
        let mut temporary = tempfile::NamedTempFile::new_in(&directory)?;
        temporary.write_all(&serde_json::to_vec_pretty(record)?)?;
        temporary.as_file().sync_all()?;
        temporary.persist(directory.join(format!("{id}.json")))?;
        Ok(())
    }

    async fn workflow_plan(&self, session: &str) -> Result<Option<Value>> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        let Some(plan) = super::planning_agent::plans::Store::new(&self.root).current(session)? else {
            return Ok(None);
        };
        let tasks = super::task_runtime::TaskRuntime::open(&self.root).await?;
        if matches!(plan.status.as_str(), "ready" | "needs_clarification") {
            tasks.suspend(&plan).await?;
        }
        Ok(Some(tasks.decorate(&plan).await?))
    }

    async fn plan_operation(
        &self,
        session: &str,
        name: &str,
        args: &Value,
        artifacts: &[crate::module::artifact::ArtifactRef],
    ) -> Result<Value> {
        use super::planning_agent::plans::{Document, Store};
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        let store = Store::new(&self.root);
        let tasks = super::task_runtime::TaskRuntime::open(&self.root).await?;
        if name == "get_workflow_plan" {
            return if let Some(version) = args["version"].as_u64() {
                Ok(serde_json::to_value(store.revision(session, u32::try_from(version)?)?)?)
            } else {
                Ok(self.workflow_plan(session).await?.unwrap_or(Value::Null))
            };
        }
        let turn = args["turn_key"].as_str().context("Native plan turn is missing")?;
        if name == "save_workflow_plan" {
            let raw = args["document_json"].as_str().context("Plan document is missing")?;
            anyhow::ensure!(raw.len() <= 65536, "Plan exceeds 64 KiB");
            let document = Document::parse(&serde_json::from_str(raw)?)?;
            let issues = self.plan_dependencies(&document, artifacts).await?;
            anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
            let previous = store.current(session)?;
            let plan = store.save(
                session,
                turn,
                u32::try_from(args["base_version"].as_u64().context("Plan base version is missing")?)?,
                document,
                issues,
            )?;
            tasks.suspend(&plan).await?;
            if let Some(old) = previous.filter(|p| matches!(p.status.as_str(), "ready" | "needs_clarification")) {
                tasks.decide(&old, false).await?;
            }
            return tasks.decorate(&plan).await;
        }
        let id = args["plan_id"].as_str().context("Plan ID is missing")?;
        let version = u32::try_from(args["version"].as_u64().context("Plan version is missing")?)?;
        let plan = if matches!(name, "approve" | "cancel") {
            if name == "approve" {
                anyhow::ensure!(
                    super::AssistantRuntime::load(&self.root)?.profile.workflow_execution,
                    "Workflow creation is disabled in the assistant profile"
                );
                let current = store.current(session)?.context("Plan is missing")?;
                anyhow::ensure!(
                    current.id == id && current.version == version,
                    "Plan changed; review its latest version"
                );
                let issues = self.plan_dependencies(&current.document, artifacts).await?;
                if !issues.is_empty() {
                    let revised = store.save(session, turn, current.version, current.document.clone(), issues)?;
                    tasks.suspend(&revised).await?;
                    tasks.decide(&current, false).await?;
                    anyhow::bail!("Plan dependencies changed; review the new plan version");
                }
            }
            anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
            let current = store.current(session)?.context("Plan is missing")?;
            // Validate native plan identity before touching its checkpoint.
            anyhow::ensure!(
                current.id == id && current.version == version,
                "Plan changed; review its latest version"
            );
            if let Some(expected) = args["interaction_id"].as_str() {
                let interaction = tasks.interaction(&current).await?.context("Interaction is missing")?;
                anyhow::ensure!(interaction.id == expected, "Feedback belongs to a stale interaction");
                if let Some(checkpoint) = args["checkpoint_id"].as_str() {
                    anyhow::ensure!(
                        interaction.checkpoint_id == checkpoint,
                        "Feedback checkpoint changed; reload the task"
                    );
                }
            }
            if current.status == "approved" && name == "approve" && current.approved_turn_key.as_deref() == Some(turn) {
                tasks.require_creation(&current).await?;
                return tasks.decorate(&current).await;
            }
            store.preview_decision(session, id, version, name == "approve", turn)?;
            tasks.decide(&current, name == "approve").await?;
            store.decide(session, id, version, name == "approve", turn)?
        } else {
            let current = store.current(session)?.context("Plan is missing")?;
            tasks.require_creation(&current).await?;
            let plan = store.transition(session, id, version, name, args.get("outcome").cloned())?;
            if matches!(name, "saved" | "failed") {
                tasks.finish(&plan).await?;
            }
            plan
        };
        tasks.decorate(&plan).await
    }
    async fn pending_tool_call(&self, session: &str) -> Result<Option<Value>> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        super::tool_execution::pending(&self.root, session).await
    }
    async fn deny_tool_call(&self, session: &str, id: &str) -> Result<Value> {
        anyhow::ensure!(dirs::active_workspace_id() == self.workspace_id, "Workspace changed");
        super::tool_execution::deny(&self.root, session, id).await
    }
    async fn call_workspace_tool(
        &self,
        session: &str,
        turn: &str,
        args: &Value,
        approved: Option<&str>,
    ) -> Result<Value> {
        super::tool_execution::invoke(
            &self.root,
            session,
            turn,
            args,
            approved,
            &super::tool_execution::NativeBackend(self.workspace_id.clone()),
        )
        .await
        .map_err(|error| {
            anyhow::anyhow!(
                "{}",
                crate::module::workflow::guardrails::redact_text(&error.to_string())
                    .chars()
                    .take(4096)
                    .collect::<String>()
            )
        })
    }
    async fn workspace_resource(&self, name: &str, args: &Value) -> Result<Value> {
        anyhow::ensure!(
            dirs::active_workspace_id() == self.workspace_id,
            "Workspace changed during discovery"
        );
        let result = super::workspace_resources::read(name, args).await?;
        anyhow::ensure!(
            dirs::active_workspace_id() == self.workspace_id,
            "Workspace changed during discovery"
        );
        Ok(result)
    }
    async fn authoring(&self, name: &str, args: &Value) -> Result<Value> {
        anyhow::ensure!(
            dirs::active_workspace_id() == self.workspace_id,
            "Workspace changed during authoring"
        );
        let result = super::workflow_agent::authoring::native_tool(name, args).await?;
        anyhow::ensure!(
            dirs::active_workspace_id() == self.workspace_id,
            "Workspace changed during authoring"
        );
        Ok(result)
    }
    async fn list_capabilities(&self, args: &Value) -> Result<Value> {
        use super::capability::{Contract, app_contract};
        if let Some(id) = args.get("capability_id").and_then(Value::as_str) {
            let contract = if let Some(app) = id.strip_prefix("app:") {
                app_contract(&feat::process_node_inspect(app).await?)
            } else {
                Contract::workflow(&self.resolve(id).await?)?
            };
            return Ok(json!({"items":[contract],"nextCursor":null}));
        }
        let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
        let cursor = args["cursor"].as_str().unwrap_or("");
        // Team workflow ACLs remain server-owned. Page that catalog first, then
        // workspace-local Apps; never treat release installation caches as Apps.
        if let Some(api) = &self.team
            && !cursor.starts_with("apps:")
        {
            let page = api
                .get(&format!(
                    "/workflow/overview?pageSize={limit}&query={}&cursor={}",
                    encoded(args["query"].as_str().unwrap_or("")),
                    encoded(cursor)
                ))
                .await?;
            let items = page["items"]
                .as_array()
                .context("Invalid workflow catalog")?
                .iter()
                .map(|entry| Contract::workflow(entry).map(|contract| contract.summary()))
                .collect::<Result<Vec<_>>>()?;
            return Ok(
                json!({"items":items,"nextCursor":page["nextCursor"].as_str().filter(|s|!s.is_empty()).unwrap_or("apps:0")}),
            );
        }
        let mut contracts = if self.team.is_none() {
            self.workflows
                .iter()
                .map(Contract::workflow)
                .collect::<Result<Vec<_>>>()?
        } else {
            vec![]
        };
        contracts.extend(feat::get_process_nodes().await?.iter().map(app_contract));
        contracts.sort_by(|a, b| a.id.cmp(&b.id));
        let query = args["query"].as_str().unwrap_or("").to_lowercase();
        contracts.retain(|c| {
            format!("{} {} {}", c.id, c.name, c.description)
                .to_lowercase()
                .contains(&query)
        });
        let offset: usize = cursor
            .strip_prefix("apps:")
            .unwrap_or(if cursor.is_empty() { "0" } else { cursor })
            .parse()?;
        let next = offset.saturating_add(limit);
        let items = contracts
            .iter()
            .skip(offset)
            .take(limit)
            .map(Contract::summary)
            .collect::<Vec<_>>();
        Ok(
            json!({"items":items,"nextCursor":(next<contracts.len()).then(||if self.team.is_some(){format!("apps:{next}")}else{next.to_string()})}),
        )
    }
    async fn describe_capability(&self, id: &str) -> Result<Capability> {
        let contract = if let Some(app) = id.strip_prefix("app:") {
            super::capability::app_contract(&feat::process_node_inspect(app).await?)
        } else {
            super::capability::Contract::workflow(&self.resolve(id).await?)?
        };
        anyhow::ensure!(
            contract.constraints["executable"] == true,
            "Capability cannot execute in this context"
        );
        let mut capability = contract.legacy();
        // Preserve the caller's legacy alias while validating its function call.
        // Dispatch resolves that alias to the current canonical UUID separately.
        capability.id = id.to_owned();
        Ok(capability)
    }
    async fn list(&self, args: &Value) -> Result<Value> {
        if let Some(id) = args.get("workflow_id").and_then(Value::as_str) {
            let cap = self.describe(id).await?;
            return Ok(
                json!({"items":[{"id":cap.id,"name":cap.name,"description":cap.description,"inputSchema":cap.parameters}],"nextCursor":null}),
            );
        }
        if let Some(api) = &self.team {
            let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(20).clamp(1, 50);
            let query = args.get("query").and_then(Value::as_str).unwrap_or("");
            let cursor = args.get("cursor").and_then(Value::as_str).unwrap_or("");
            let page = api
                .get(&format!(
                    "/workflow/overview?pageSize={limit}&query={}&cursor={}",
                    encoded(query),
                    encoded(cursor)
                ))
                .await?;
            let items=page["items"].as_array().context("Invalid workflow catalog")?.iter().filter_map(capability).map(|cap|json!({"id":cap.id,"name":cap.name,"description":cap.description,"inputSchema":cap.parameters})).collect::<Vec<_>>();
            Ok(json!({"items":items,"nextCursor":page["nextCursor"]}))
        } else {
            super::tools::list_page(&self.capabilities(), args)
        }
    }
    async fn describe(&self, id: &str) -> Result<Capability> {
        let mut capability = capability(&self.resolve(id).await?).context("Invalid workflow contract")?;
        capability.id = id.to_owned();
        Ok(capability)
    }
}
fn capability(entry: &Value) -> Option<Capability> {
    let settings = entry.get("document")?.get("settings")?;
    Some(Capability {
        id: entry.get("id")?.as_str()?.into(),
        name: settings.get("name")?.as_str()?.into(),
        description: settings.get("description").and_then(Value::as_str).unwrap_or("").into(),
        parameters: parameters(settings),
    })
}

#[cfg(test)]
mod tests {
    use super::super::tools::WorkflowDiscovery;
    use super::*;
    #[tokio::test]
    async fn operation_records_survive_reload_and_remain_session_scoped() {
        let root = tempfile::tempdir().unwrap();
        let catalog = Catalog {
            workflows: vec![],
            team: None,
            root: root.path().into(),
            workspace_id: dirs::active_workspace_id(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        catalog.record_operation(&json!({"id":id,"sessionId":"one","kind":"workflow_authoring","status":"completed","startedAt":"now","result":{"workflow_id":"saved"}})).await.unwrap();
        catalog.record_operation(&json!({"id":uuid::Uuid::new_v4().to_string(),"sessionId":"two","status":"completed","result":{"private":"other"}})).await.unwrap();
        let reloaded = Catalog {
            workflows: vec![],
            team: None,
            root: root.path().into(),
            workspace_id: dirs::active_workspace_id(),
        };
        let result = reloaded.inspect_operations("one").await.unwrap();
        assert_eq!(result["items"].as_array().unwrap().len(), 1);
        assert_eq!(result["items"][0]["result"]["workflow_id"], "saved");
        assert!(!result.to_string().contains("private"));
        catalog
            .record_operation(&json!({"id":id,"sessionId":"one","status":"running"}))
            .await
            .unwrap();
        assert_eq!(
            reloaded.inspect_operations("one").await.unwrap()["items"][0]["status"],
            "interrupted"
        );
    }
    #[test]
    fn native_input_contract_preserves_types_required_fields_and_chat_input() {
        let settings = json!({"mode":"task","inputSchema":{"fields":[{"key":"count","type":"number","required":true},{"key":"enabled","type":"boolean","required":true}]}});
        assert!(!validate_input(&settings, &json!({})).unwrap());
        assert!(validate_input(&settings, &json!({"count":0,"enabled":false})).unwrap());
        assert!(validate_input(&settings, &json!({"count":"0","enabled":false})).is_err());
        assert!(validate_input(&settings, &json!({"count":0,"enabled":false,"unknown":true})).is_err());
        let chat = json!({"mode":"chat","inputSchema":{"fields":[]}});
        assert!(!validate_input(&chat, &json!({})).unwrap());
        assert!(validate_input(&chat, &json!({"input":"Hello"})).unwrap());
    }
    #[test]
    fn native_dsl_keeps_session_state_and_durable_document_identity() {
        let workflow = json!({"id":"workflow-1","document":{"settings":{"name":"Report","mode":"task","inputSchema":{"fields":[]},"sessionStateFields":["customer"]},"nodes":[],"edges":[]}});
        let dsl = document_dsl(&workflow).unwrap();
        assert_eq!(dsl["id"], "workflow-1");
        assert_eq!(dsl["sessionStateFields"], json!(["customer"]));
    }
}
