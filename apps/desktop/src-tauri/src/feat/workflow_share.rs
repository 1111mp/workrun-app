//! Workflow packages carry a closed graph of local Apps and subworkflows.
mod graph;
use super::{app_share::*, process_node::collect_app_source_files, workflow::validate_document};
use crate::{
    config::{BaseConfig, Config, IProcessNode, IWorkflow, model_catalog, validate_process_node_catalog},
    module::{
        mcp_server::parse_tool_id,
        process_node::ProcessNodeRegistry,
        skill::SkillRegistry,
        tool_registry::{ToolDefinition, ToolSource},
    },
    process::AsyncHandler,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use graph::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::File,
    path::{Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

pub(crate) const IMPORT_PREFIX: &str = "workrun-import:";
const MAX_WORKFLOWS: usize = 200;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareDependency {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowShareRequirement {
    pub id: String,
    pub kind: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential_kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowShareManifest {
    pub format: String,
    pub format_version: u32,
    pub exported_at: String,
    pub workrun_version: String,
    pub entry_workflow_id: String,
    pub workflows: Vec<ShareDependency>,
    pub apps: Vec<ShareDependency>,
    pub requirements: Vec<WorkflowShareRequirement>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSharePreview {
    pub manifest: WorkflowShareManifest,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub fingerprint: String,
    pub bindings: BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowShareImportResult {
    pub workflow: IWorkflow,
    pub apps: Vec<ShareDependency>,
    pub pending: Vec<WorkflowShareRequirement>,
}

struct ExportPlan {
    manifest: WorkflowShareManifest,
    documents: BTreeMap<String, Value>,
    settings: BTreeMap<String, Value>,
    files: Vec<(String, PathBuf)>,
    total_bytes: u64,
}

fn add_requirement(
    requirements: &mut Vec<WorkflowShareRequirement>,
    keys: &mut BTreeMap<String, String>,
    key: String,
    kind: &str,
    label: String,
    suggested_value: Option<String>,
    origin: Option<String>,
) -> String {
    if let Some(id) = keys.get(&key) {
        return format!("{IMPORT_PREFIX}{id}");
    }
    let id = format!("requirement-{}", requirements.len() + 1);
    keys.insert(key, id.clone());
    requirements.push(WorkflowShareRequirement {
        id: id.clone(),
        kind: kind.into(),
        label,
        suggested_value,
        origin,
        credential_kind: None,
    });
    format!("{IMPORT_PREFIX}{id}")
}

fn make_export_plan(
    root: &str,
    workflows: Vec<IWorkflow>,
    apps: Vec<IProcessNode>,
    tools: Vec<ToolDefinition>,
    servers: BTreeMap<String, String>,
    version: String,
) -> Result<ExportPlan> {
    let catalog: BTreeMap<_, _> = workflows.into_iter().map(|item| (item.id, item.document)).collect();
    let app_catalog: BTreeMap<_, _> = apps.into_iter().map(|item| (item.id.clone(), item)).collect();
    let tool_catalog: BTreeMap<_, _> = tools.into_iter().map(|tool| (tool.id.clone(), tool)).collect();
    let mut pending = vec![root.to_owned()];
    let mut documents = BTreeMap::new();
    let mut app_ids = BTreeSet::new();
    while let Some(id) = pending.pop() {
        if documents.contains_key(&id) {
            continue;
        }
        let document = catalog
            .get(&id)
            .context(format!("Missing Workflow dependency: {id}"))?
            .clone();
        for node in document_nodes(&document)? {
            for reference in references(node)? {
                match reference.kind {
                    ReferenceKind::Workflow => pending.push(reference.id),
                    ReferenceKind::App => {
                        app_ids.insert(reference.id);
                    },
                    ReferenceKind::Tool => {
                        if let Some(app) = app_catalog.get(&reference.id) {
                            // Validate only referenced Tool Apps; unrelated drafts may be incomplete.
                            if app.kind != crate::config::ProcessNodeKind::Tool {
                                bail!("Referenced App is not a Tool App: {}", reference.id);
                            }
                            ProcessNodeRegistry::tool_definition(app.clone())?;
                            app_ids.insert(reference.id);
                        } else if !reference.id.starts_with("mcp:") {
                            bail!("Missing Tool App: {}", reference.id);
                        }
                    },
                }
            }
        }
        documents.insert(id, document);
        if documents.len() > MAX_WORKFLOWS {
            bail!("Workflow package exceeds 200 Workflows");
        }
    }
    verify_graph(root, &documents)?;
    let models = model_catalog();
    let mut requirements = Vec::new();
    let mut keys = BTreeMap::new();
    for (workflow_id, document) in &mut documents {
        // Only definition and editor layout belong in the sharing document.
        document
            .as_object_mut()
            .unwrap()
            .retain(|key, _| matches!(key.as_str(), "nodes" | "edges" | "settings"));
        for node in document["nodes"].as_array_mut().unwrap() {
            node["data"].as_object_mut().unwrap().remove("sharePackage");
            node["data"].as_object_mut().unwrap().remove("shareRequirements");
            let fields = configuration_fields(node, false)?;
            for field in fields {
                let value = node["data"]
                    .pointer(&field.pointer)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                if value.starts_with(IMPORT_PREFIX) {
                    bail!("Configure pending imported dependencies before exporting again");
                }
                let (label, suggestion) = match field.kind {
                    "model" => (
                        models
                            .iter()
                            .find(|model| model.id == value)
                            .map(|model| model.name.clone())
                            .unwrap_or(field.label),
                        (!value.is_empty()).then_some(value.clone()),
                    ),
                    "skill" => (value.clone(), Some(value.clone())),
                    _ => (field.label, None),
                };
                let origin = if field.kind == "credential" {
                    let prefix = field.pointer.strip_suffix("/authentication/credentialId").unwrap();
                    node["data"]
                        .pointer(&format!("{prefix}/url"))
                        .and_then(Value::as_str)
                        .and_then(|url| url::Url::parse(url).ok())
                        .map(|url| url.origin().ascii_serialization())
                } else {
                    None
                };
                let key = if matches!(field.kind, "model" | "skill") {
                    format!("{}:{value}", field.kind)
                } else {
                    format!("{workflow_id}:{}:{}", node["id"].as_str().unwrap(), field.pointer)
                };
                let token = add_requirement(&mut requirements, &mut keys, key, field.kind, label, suggestion, origin);
                if field.kind == "credential" {
                    let prefix = field.pointer.strip_suffix("/credentialId").unwrap();
                    requirements
                        .iter_mut()
                        .find(|item| token == format!("{IMPORT_PREFIX}{}", item.id))
                        .unwrap()
                        .credential_kind = node["data"]
                        .pointer(&format!("{prefix}/type"))
                        .and_then(Value::as_str)
                        .map(str::to_owned);
                }
                let data = node["data"].as_object_mut().unwrap();
                if field.pointer == "/modelProfileId" && !data.contains_key("modelProfileId") {
                    data.insert("modelProfileId".into(), token.into());
                } else {
                    *node["data"]
                        .pointer_mut(&field.pointer)
                        .context("Missing configuration field")? = token.into();
                }
            }
            for reference in references(node)? {
                if reference.kind == ReferenceKind::Tool && reference.id.starts_with("mcp:") {
                    let (server, tool_name) = parse_tool_id(&reference.id)?;
                    let source_name = servers.get(server).cloned().unwrap_or_else(|| "MCP server".into());
                    let label = tool_catalog
                        .get(&reference.id)
                        .map(|tool| tool.display_name.clone())
                        .unwrap_or_else(|| format!("{source_name} / {tool_name}"));
                    let token = add_requirement(
                        &mut requirements,
                        &mut keys,
                        reference.id.clone(),
                        "tool",
                        label,
                        None,
                        None,
                    );
                    replace_reference(&mut node["data"], &reference, token)?;
                }
            }
            // appRef is a local identity hint, not a pinned Team release or source fingerprint.
            if node["type"] == "process" {
                let reference = references(node)?
                    .into_iter()
                    .find(|reference| reference.kind == ReferenceKind::App)
                    .unwrap();
                node["data"]["processNodeId"] = reference.id.clone().into();
                if node["data"].get("appRef").is_some() {
                    node["data"]["appRef"] = json!({"source":"local", "localAppId":reference.id});
                }
            }
        }
    }
    let mut settings = BTreeMap::new();
    let mut files = Vec::new();
    let mut total_bytes = 0;
    let mut dependencies = Vec::new();
    for id in app_ids {
        let definition = app_catalog.get(&id).context(format!("Missing App dependency: {id}"))?;
        let project = ProcessNodeRegistry::project_path(definition)?;
        let selected = collect_app_source_files(&project)?;
        validate_source(&project, definition, &selected)?;
        for path in selected {
            let name = format!("apps/{id}/app/{}", path.to_string_lossy().replace('\\', "/"));
            portable_path(Path::new(&name))?;
            total_bytes += project.join(&path).metadata()?.len();
            files.push((name, project.join(path)));
        }
        dependencies.push(ShareDependency {
            id: id.clone(),
            name: definition.name.clone(),
        });
        settings.insert(id, portable_app(definition)?);
    }
    if total_bytes > MAX_BYTES || files.len() > MAX_FILES {
        bail!("Workflow package exceeds sharing limits");
    }
    let manifest = WorkflowShareManifest {
        format: "workrun-workflow".into(),
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        workrun_version: version,
        entry_workflow_id: root.into(),
        workflows: documents
            .iter()
            .map(|(id, document)| ShareDependency {
                id: id.clone(),
                name: document["settings"]["name"].as_str().unwrap_or("Workflow").into(),
            })
            .collect(),
        apps: dependencies,
        requirements,
    };
    Ok(ExportPlan {
        manifest,
        documents,
        settings,
        files,
        total_bytes,
    })
}

impl ExportPlan {
    fn metadata(&self) -> Result<Vec<(String, Vec<u8>)>> {
        let mut values = vec![("manifest.json".into(), serde_json::to_vec_pretty(&self.manifest)?)];
        for (id, document) in &self.documents {
            values.push((
                if id == &self.manifest.entry_workflow_id {
                    "workflow.json".into()
                } else {
                    format!("workflows/{id}/workflow.json")
                },
                serde_json::to_vec_pretty(document)?,
            ));
        }
        for (id, settings) in &self.settings {
            values.push((format!("apps/{id}/app.json"), serde_json::to_vec_pretty(settings)?));
        }
        if values.iter().any(|(_, bytes)| bytes.len() as u64 > MAX_JSON_BYTES) {
            bail!("Workflow package metadata exceeds 2 MiB per file");
        }
        Ok(values)
    }
    fn fingerprint(&self) -> Result<String> {
        let mut manifest = self.manifest.clone();
        manifest.exported_at.clear();
        let bytes = serde_json::to_vec(&(
            manifest,
            &self.documents,
            &self.settings,
            self.files.iter().map(|(path, _)| path).collect::<Vec<_>>(),
        ))?;
        Ok(format!("{:x}", Sha256::digest(bytes)))
    }
    fn preview(&self) -> Result<WorkflowSharePreview> {
        Ok(WorkflowSharePreview {
            manifest: self.manifest.clone(),
            files: self
                .metadata()?
                .iter()
                .map(|(name, _)| name.clone())
                .chain(self.files.iter().map(|(name, _)| name.clone()))
                .collect(),
            total_bytes: self.total_bytes,
            fingerprint: self.fingerprint()?,
            bindings: BTreeMap::new(),
        })
    }
}

async fn export_plan(id: String, version: String) -> Result<ExportPlan> {
    ensure_personal()?;
    let workflows = super::get_workflows().await?;
    let apps = Config::process_nodes().await.data_arc().get_process_nodes();
    let tools = super::list_mcp_tool_definitions().await?;
    let servers = Config::mcp_servers()
        .await
        .data_arc()
        .get_mcp_servers()
        .into_iter()
        .map(|server| (server.id, server.name))
        .collect();
    AsyncHandler::spawn_blocking(move || make_export_plan(&id, workflows, apps, tools, servers, version)).await?
}

pub async fn workflow_share_mcp_tools() -> Result<Vec<ToolDefinition>> {
    ensure_personal()?;
    super::list_mcp_tool_definitions().await
}

pub async fn workflow_share_export_preview(id: String, version: String) -> Result<WorkflowSharePreview> {
    export_plan(id, version).await?.preview()
}

pub async fn workflow_share_export(
    id: String,
    destination: PathBuf,
    format: AppShareFormat,
    fingerprint: String,
    version: String,
) -> Result<()> {
    let plan = export_plan(id, version).await?;
    if plan.fingerprint()? != fingerprint {
        bail!("Workflow dependencies changed; reopen the export preview");
    }
    AsyncHandler::spawn_blocking(move || write_share_archive(&destination, format, &plan.metadata()?, &plan.files))
        .await?
}

struct ImportPackage {
    staging: TempDir,
    manifest: WorkflowShareManifest,
    documents: BTreeMap<String, Value>,
    apps: BTreeMap<String, IProcessNode>,
    preview: WorkflowSharePreview,
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let input = File::open(path).with_context(|| format!("Missing package metadata: {}", path.display()))?;
    if input.metadata()?.len() > MAX_JSON_BYTES {
        bail!("Package metadata exceeds 2 MiB");
    }
    Ok(serde_json::from_reader(input)?)
}

fn token_requirement<'a>(
    value: &str,
    kind: &str,
    requirements: &'a BTreeMap<String, WorkflowShareRequirement>,
) -> Result<&'a WorkflowShareRequirement> {
    let id = value
        .strip_prefix(IMPORT_PREFIX)
        .context("External dependencies must use package configuration requirements")?;
    let requirement = requirements
        .get(id)
        .context("Missing package configuration requirement")?;
    if requirement.kind != kind {
        bail!("Configuration requirement type does not match its Workflow field");
    }
    Ok(requirement)
}

fn read_workflow_package(path: &Path) -> Result<ImportPackage> {
    let extracted = extract_share_archive(path)?;
    let root = extracted.staging.path();
    let manifest: WorkflowShareManifest = read_json(&root.join("manifest.json"))?;
    if manifest.format != "workrun-workflow" || manifest.format_version != 1 {
        bail!("Unsupported Workflow sharing format or version");
    }
    if manifest.workflows.len() > MAX_WORKFLOWS || manifest.workflows.is_empty() {
        bail!("Invalid Workflow dependency count");
    }
    let mut documents = BTreeMap::new();
    let mut apps = BTreeMap::new();
    let mut metadata_files = BTreeSet::from([PathBuf::from("manifest.json")]);
    let mut source_roots = Vec::new();
    for dependency in &manifest.workflows {
        crate::config::validate_process_node_id(&dependency.id)?;
        let path = if dependency.id == manifest.entry_workflow_id {
            PathBuf::from("workflow.json")
        } else {
            PathBuf::from(format!("workflows/{}/workflow.json", dependency.id))
        };
        let document: Value = read_json(&root.join(&path))?;
        document_nodes(&document)?;
        if documents.insert(dependency.id.clone(), document).is_some() {
            bail!("Duplicate Workflow dependency");
        }
        metadata_files.insert(path);
    }
    verify_graph(&manifest.entry_workflow_id, &documents)?;
    for dependency in &manifest.apps {
        crate::config::validate_process_node_id(&dependency.id)?;
        let path = PathBuf::from(format!("apps/{}/app.json", dependency.id));
        let definition = local_definition(read_json(&root.join(&path))?, None)?;
        let source = PathBuf::from(format!("apps/{}/app", dependency.id));
        let files: Vec<PathBuf> = extracted
            .seen
            .iter()
            .filter(|path| path.starts_with(&source) && root.join(path).is_file())
            .map(|path| path.strip_prefix(&source).unwrap().to_path_buf())
            .collect();
        validate_source(&root.join(&source), &definition, &files)?;
        if apps.insert(dependency.id.clone(), definition).is_some() {
            bail!("Duplicate App dependency");
        }
        metadata_files.insert(path);
        source_roots.push(source);
    }
    for path in &extracted.seen {
        let permitted = metadata_files.contains(path)
            || source_roots.iter().any(|source| path.starts_with(source))
            || root.join(path).is_dir()
                && metadata_files
                    .iter()
                    .chain(source_roots.iter())
                    .any(|file| file.starts_with(path));
        if !permitted {
            bail!("Unexpected file in Workflow package: {}", path.display());
        }
    }
    let mut requirements = BTreeMap::new();
    for requirement in &manifest.requirements {
        if requirement.id.is_empty()
            || !matches!(
                requirement.kind.as_str(),
                "model" | "tool" | "skill" | "credential" | "mount" | "environment" | "url"
            )
            || requirements
                .insert(requirement.id.clone(), requirement.clone())
                .is_some()
        {
            bail!("Invalid or duplicate configuration requirement");
        }
        // Suggestions are public identifiers, never configuration values or credentials.
        if !matches!(requirement.kind.as_str(), "model" | "skill") && requirement.suggested_value.is_some() {
            bail!("Private configuration must not include suggested values");
        }
    }
    let mut used_requirements = BTreeSet::new();
    let mut used_apps = BTreeSet::new();
    for document in documents.values() {
        for node in document_nodes(document)? {
            for field in configuration_fields(node, true)? {
                let value = node["data"]
                    .pointer(&field.pointer)
                    .and_then(Value::as_str)
                    .context("Missing external configuration field")?;
                let requirement = token_requirement(value, field.kind, &requirements)?;
                if field.kind == "credential" {
                    let prefix = field.pointer.strip_suffix("/credentialId").unwrap();
                    let kind = node["data"].pointer(&format!("{prefix}/type")).and_then(Value::as_str);
                    if !matches!(kind, Some("bearer" | "apiKey")) || requirement.credential_kind.as_deref() != kind {
                        bail!("Remote credential requirement has an incompatible authentication type");
                    }
                    let prefix = prefix.strip_suffix("/authentication").unwrap();
                    if let Some(url) = node["data"]
                        .pointer(&format!("{prefix}/url"))
                        .and_then(Value::as_str)
                        .filter(|url| !url.starts_with(IMPORT_PREFIX))
                    {
                        let origin = url::Url::parse(url)?.origin().ascii_serialization();
                        if requirement.origin.as_deref() != Some(&origin) {
                            bail!("Remote credential requirement has a different service origin");
                        }
                    }
                }
                used_requirements.insert(requirement.id.clone());
            }
            for reference in references(node)? {
                match reference.kind {
                    ReferenceKind::Workflow => {},
                    ReferenceKind::Tool if reference.id.starts_with(IMPORT_PREFIX) => {
                        used_requirements.insert(token_requirement(&reference.id, "tool", &requirements)?.id.clone());
                    },
                    _ => {
                        let app = apps
                            .get(&reference.id)
                            .context("Workflow references an unpackaged App")?;
                        if reference.kind == ReferenceKind::Tool && app.kind != crate::config::ProcessNodeKind::Tool {
                            bail!("Agent tool reference must point to a Tool App");
                        }
                        used_apps.insert(reference.id);
                    },
                }
            }
        }
    }
    if used_apps.len() != apps.len() || used_requirements.len() != requirements.len() {
        bail!("Package contains unused Apps or configuration requirements");
    }
    let mut files: Vec<_> = extracted
        .seen
        .iter()
        .filter(|path| root.join(path).is_file())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect();
    files.sort();
    let preview = WorkflowSharePreview {
        manifest: manifest.clone(),
        files,
        total_bytes: extracted.total,
        fingerprint: extracted.sha256,
        bindings: BTreeMap::new(),
    };
    Ok(ImportPackage {
        staging: extracted.staging,
        manifest,
        documents,
        apps,
        preview,
    })
}

fn suggested_bindings(requirements: &[WorkflowShareRequirement]) -> BTreeMap<String, String> {
    let models = model_catalog();
    requirements
        .iter()
        .filter_map(|requirement| {
            let value = requirement.suggested_value.as_ref()?;
            let available = match requirement.kind.as_str() {
                "model" => models.iter().any(|model| &model.id == value),
                "skill" => SkillRegistry::inspect(value).is_ok_and(|skill| skill.allowed_tools.is_empty()),
                _ => false,
            };
            available.then(|| (requirement.id.clone(), value.clone()))
        })
        .collect()
}

pub async fn workflow_share_import_preview(path: PathBuf) -> Result<WorkflowSharePreview> {
    ensure_personal()?;
    let mut preview =
        AsyncHandler::spawn_blocking(move || -> Result<_> { Ok(read_workflow_package(&path)?.preview) }).await??;
    preview.bindings = suggested_bindings(&preview.manifest.requirements);
    Ok(preview)
}

async fn validate_bindings(
    requirements: &[WorkflowShareRequirement],
    bindings: &BTreeMap<String, String>,
) -> Result<()> {
    if bindings
        .keys()
        .any(|id| !requirements.iter().any(|requirement| &requirement.id == id))
    {
        bail!("Unknown configuration binding");
    }
    let models = model_catalog();
    let tools = if requirements.iter().any(|requirement| {
        requirement.kind == "tool" && bindings.get(&requirement.id).is_some_and(|value| !value.is_empty())
    }) {
        super::list_mcp_tool_definitions().await?
    } else {
        Vec::new()
    };
    let credentials = BaseConfig::workrun().await.data_arc().remote_agent_credentials.clone();
    for requirement in requirements {
        let Some(value) = bindings.get(&requirement.id).filter(|value| !value.is_empty()) else {
            continue;
        };
        if value.starts_with(IMPORT_PREFIX) {
            bail!("Cannot bind a dependency to an unresolved placeholder");
        }
        let valid = match requirement.kind.as_str() {
            "model" => models.iter().any(|model| &model.id == value),
            "tool" => tools
                .iter()
                .any(|tool| &tool.id == value && tool.source == ToolSource::Mcp),
            "skill" => SkillRegistry::inspect(value).is_ok(),
            "credential" => credentials.iter().any(|credential| {
                &credential.id == value
                    && requirement.credential_kind.as_deref()
                        == Some(match credential.kind {
                            crate::config::RemoteCredentialKind::Bearer => "bearer",
                            crate::config::RemoteCredentialKind::ApiKey => "apiKey",
                        })
                    && requirement
                        .origin
                        .as_ref()
                        .is_some_and(|origin| origin == &credential.origin)
            }),
            "mount" => Path::new(value).is_absolute(),
            "url" => url::Url::parse(value).is_ok_and(|url| {
                matches!(url.scheme(), "http" | "https")
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            }),
            "environment" => true,
            _ => false,
        };
        if !valid {
            bail!("Invalid binding for {}", requirement.label);
        }
    }
    Ok(())
}

fn remap_documents(
    documents: &BTreeMap<String, Value>,
    app_map: &BTreeMap<String, String>,
    workflow_map: &BTreeMap<String, String>,
    bindings: &BTreeMap<String, String>,
) -> Result<Vec<IWorkflow>> {
    let now = Utc::now().to_rfc3339();
    let mut workflows = Vec::new();
    for (id, original) in documents {
        let mut document = original.clone();
        for node in document["nodes"].as_array_mut().unwrap() {
            // Replace configuration values before moving compensation-map keys that contain tool IDs.
            for field in configuration_fields(node, false)? {
                let value = node["data"]
                    .pointer(&field.pointer)
                    .and_then(Value::as_str)
                    .context("Missing configuration")?;
                if let Some(value) = value
                    .strip_prefix(IMPORT_PREFIX)
                    .and_then(|id| bindings.get(id))
                    .filter(|value| !value.is_empty())
                {
                    *node["data"].pointer_mut(&field.pointer).unwrap() = value.clone().into();
                }
            }
            for reference in references(node)? {
                let value = match reference.kind {
                    ReferenceKind::Workflow => workflow_map
                        .get(&reference.id)
                        .context("Missing subworkflow mapping")?
                        .clone(),
                    ReferenceKind::Tool if reference.id.starts_with(IMPORT_PREFIX) => reference
                        .id
                        .strip_prefix(IMPORT_PREFIX)
                        .and_then(|id| bindings.get(id))
                        .filter(|value| !value.is_empty())
                        .cloned()
                        .unwrap_or(reference.id.clone()),
                    ReferenceKind::Tool if reference.id.starts_with("mcp:") => reference.id.clone(),
                    _ => app_map.get(&reference.id).context("Missing App mapping")?.clone(),
                };
                replace_reference(&mut node["data"], &reference, value)?;
            }
            if node["type"] == "process"
                && let Some(id) = node["data"]
                    .pointer("/appRef/localAppId")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            {
                node["data"]["processNodeId"] = id.into();
            }
            if node["type"] == "start" {
                node["data"]["sharePackage"] = true.into();
            }
        }
        let id = workflow_map.get(id).context("Missing Workflow mapping")?.clone();
        validate_document(&document, Some(&id))?;
        workflows.push(IWorkflow {
            id,
            document,
            created_at: now.clone(),
            updated_at: now.clone(),
        });
    }
    Ok(workflows)
}

struct ActivatedApps {
    paths: Vec<PathBuf>,
    retain: bool,
}
impl Drop for ActivatedApps {
    fn drop(&mut self) {
        if !self.retain {
            for path in &self.paths {
                let _ = std::fs::remove_dir_all(path);
            }
        }
    }
}

fn activate_apps(staging: &Path, apps: &BTreeMap<String, IProcessNode>) -> Result<ActivatedApps> {
    let mut activated = ActivatedApps {
        paths: Vec::new(),
        retain: false,
    };
    for (old_id, definition) in apps {
        let destination = ProcessNodeRegistry::project_path(definition)?;
        if destination.exists() {
            bail!("Imported App directory already exists");
        }
        let parent = destination.parent().context("App directory has no parent")?;
        std::fs::create_dir_all(parent)?;
        let prepared = tempfile::tempdir_in(parent)?;
        let source = staging.join(format!("apps/{old_id}/app"));
        let output = prepared.path().join("source");
        for entry in walkdir::WalkDir::new(&source) {
            let entry = entry?;
            let target = output.join(entry.path().strip_prefix(&source)?);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        std::fs::rename(output, &destination)?;
        activated.paths.push(destination);
    }
    Ok(activated)
}

async fn save_catalog<T: Serialize>(path: PathBuf, data: &T) -> Result<()> {
    let bytes = serde_json::to_vec(data)?;
    AsyncHandler::spawn_blocking(move || -> Result<()> {
        let parent = path.parent().context("Catalog path has no parent")?;
        std::fs::create_dir_all(parent)?;
        let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
        use std::io::Write;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    })
    .await?
}

async fn commit_import(
    apps_catalog: crate::config::Draft<crate::config::IProcessNodes>,
    workflows_catalog: crate::config::Draft<crate::config::IWorkflows>,
    app_path: PathBuf,
    workflow_path: PathBuf,
    apps: Vec<IProcessNode>,
    workflows: Vec<IWorkflow>,
    retain: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<()> {
    // Hold both catalog update permits until all disk writes succeed. Draft claims
    // alone do not protect against the existing with_data_modify writers.
    apps_catalog
        .with_data_modify(|mut app_data| async move {
            let original = app_data.clone();
            for app in apps {
                app_data.add_process_node(app);
            }
            validate_process_node_catalog(&app_data)?;
            workflows_catalog
                .with_data_modify(|mut workflow_data| async move {
                    for workflow in workflows {
                        workflow_data.add_workflow(workflow);
                    }
                    save_catalog(app_path.clone(), &app_data).await?;
                    if let Err(error) = save_catalog(workflow_path, &workflow_data).await {
                        if let Err(rollback) = save_catalog(app_path, &original).await {
                            retain.store(true, std::sync::atomic::Ordering::Release);
                            return Err(error.context(format!(
                                "App catalog rollback failed; source retained for recovery: {rollback}"
                            )));
                        }
                        return Err(error);
                    }
                    Ok((workflow_data, app_data))
                })
                .await
                .map(|app_data| (app_data, ()))
        })
        .await
}

fn record_pending_requirements(workflows: &mut [IWorkflow], requirements: &[WorkflowShareRequirement]) -> Result<()> {
    let documents = workflows
        .iter()
        .map(|workflow| (workflow.id.clone(), workflow.document.clone()))
        .collect();
    let pending = pending_requirements(&documents, requirements)?;
    let metadata = serde_json::to_value(pending)?;
    for workflow in workflows {
        for (index, node) in workflow.document["nodes"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .enumerate()
        {
            if index == 0 || node["type"] == "start" {
                node["data"]["shareRequirements"] = metadata.clone();
                node["data"]["sharePackage"] = true.into();
            }
        }
    }
    Ok(())
}

fn pending_requirements(
    documents: &BTreeMap<String, Value>,
    metadata: &[WorkflowShareRequirement],
) -> Result<Vec<WorkflowShareRequirement>> {
    let requirements = metadata
        .iter()
        .map(|item| (item.id.clone(), item.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut pending = BTreeSet::new();
    for document in documents.values() {
        for node in document_nodes(document)? {
            for field in configuration_fields(node, false)? {
                if let Some(value) = node["data"]
                    .pointer(&field.pointer)
                    .and_then(Value::as_str)
                    .filter(|value| value.starts_with(IMPORT_PREFIX))
                {
                    pending.insert(token_requirement(value, field.kind, &requirements)?.id.clone());
                }
            }
            for reference in references(node)? {
                if reference.kind == ReferenceKind::Tool && reference.id.starts_with(IMPORT_PREFIX) {
                    pending.insert(token_requirement(&reference.id, "tool", &requirements)?.id.clone());
                }
            }
        }
    }
    Ok(pending.into_iter().map(|id| requirements[&id].clone()).collect())
}

fn validate_bound_skills(workflows: &[IWorkflow]) -> Result<()> {
    for workflow in workflows {
        for node in document_nodes(&workflow.document)? {
            let names = node["data"]["skillRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|skill| {
                    skill["name"]
                        .as_str()
                        .filter(|name| !name.starts_with(IMPORT_PREFIX))
                        .map(str::to_owned)
                })
                .collect::<Vec<_>>();
            if names.is_empty() {
                continue;
            }
            let skills = SkillRegistry::resolve(&names)?;
            let ids = node["data"]["toolIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|tool| tool.as_str().map(str::to_owned))
                .collect();
            crate::module::skill::allowed_tool_ids(&skills, ids).context(
                "Selected Skill is incompatible with the imported tool IDs; update the Skill or configure it later",
            )?;
        }
    }
    Ok(())
}

pub async fn workflow_share_import(
    path: PathBuf,
    fingerprint: String,
    name: String,
    bindings: BTreeMap<String, String>,
) -> Result<WorkflowShareImportResult> {
    ensure_personal()?;
    if name.trim().is_empty() {
        bail!("Workflow name is required");
    }
    let mut package = AsyncHandler::spawn_blocking(move || read_workflow_package(&path)).await??;
    if package.preview.fingerprint != fingerprint {
        bail!("Workflow archive changed since preview; select it again");
    }
    validate_bindings(&package.manifest.requirements, &bindings).await?;
    let app_map = package
        .apps
        .iter()
        .map(|(old_id, definition)| (old_id.clone(), definition.id.clone()))
        .collect();
    let workflow_map: BTreeMap<_, _> = package
        .documents
        .keys()
        .map(|id| (id.clone(), Uuid::now_v7().to_string()))
        .collect();
    package.documents.get_mut(&package.manifest.entry_workflow_id).unwrap()["settings"]["name"] = name.trim().into();
    let entry_id = &workflow_map[&package.manifest.entry_workflow_id];
    // Namespace unresolved placeholders per imported copy, so later bindings
    // cannot accidentally configure another independently imported package.
    let pending: Vec<_> = package
        .manifest
        .requirements
        .iter()
        .filter(|requirement| bindings.get(&requirement.id).is_none_or(String::is_empty))
        .cloned()
        .map(|mut requirement| {
            requirement.id = format!("{entry_id}:{}", requirement.id);
            requirement
        })
        .collect();
    let mut effective = bindings.clone();
    for requirement in &package.manifest.requirements {
        if bindings.get(&requirement.id).is_none_or(String::is_empty) {
            effective.insert(
                requirement.id.clone(),
                format!("{IMPORT_PREFIX}{entry_id}:{}", requirement.id),
            );
        }
    }
    let mut workflows = remap_documents(&package.documents, &app_map, &workflow_map, &effective)?;
    validate_bound_skills(&workflows)?;
    record_pending_requirements(&mut workflows, &pending)?;
    let workflow = workflows
        .iter()
        .find(|workflow| &workflow.id == entry_id)
        .unwrap()
        .clone();
    let apps = package.apps.values().cloned().collect::<Vec<_>>();
    let dependencies = apps
        .iter()
        .map(|app| ShareDependency {
            id: app.id.clone(),
            name: app.name.clone(),
        })
        .collect();
    let app_path = crate::utils::dirs::process_node_catalog_path()?;
    let workflow_path = crate::utils::dirs::workflow_catalog_path()?;
    let mut activated =
        AsyncHandler::spawn_blocking(move || activate_apps(package.staging.path(), &package.apps)).await??;
    let retain = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let result = commit_import(
        Config::process_nodes().await,
        Config::workflows().await,
        app_path,
        workflow_path,
        apps,
        workflows,
        retain.clone(),
    )
    .await;
    activated.retain = result.is_ok() || retain.load(std::sync::atomic::Ordering::Acquire);
    AsyncHandler::spawn_blocking(move || drop(activated)).await?;
    result?;
    Ok(WorkflowShareImportResult {
        workflow,
        apps: dependencies,
        pending,
    })
}

fn configuration_plan(
    id: &str,
    catalog: Vec<IWorkflow>,
    version: String,
) -> Result<(WorkflowSharePreview, BTreeMap<String, Value>)> {
    let catalog = catalog
        .into_iter()
        .map(|workflow| (workflow.id, workflow.document))
        .collect::<BTreeMap<_, _>>();
    let mut queue = vec![id.to_owned()];
    let mut documents = BTreeMap::new();
    let mut metadata = Vec::new();
    while let Some(id) = queue.pop() {
        if documents.contains_key(&id) {
            continue;
        }
        let document = catalog
            .get(&id)
            .context("Missing imported Workflow dependency")?
            .clone();
        for node in document_nodes(&document)? {
            if let Some(value) = node["data"].get("shareRequirements") {
                metadata.extend(serde_json::from_value::<Vec<WorkflowShareRequirement>>(value.clone())?);
            }
            for reference in references(node)? {
                if reference.kind == ReferenceKind::Workflow {
                    queue.push(reference.id);
                }
            }
        }
        documents.insert(id, document);
        if documents.len() > MAX_WORKFLOWS {
            bail!("Workflow dependency limit exceeded");
        }
    }
    verify_graph(id, &documents)?;
    let requirements = pending_requirements(&documents, &metadata)?;
    let manifest = WorkflowShareManifest {
        format: "workrun-workflow".into(),
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        workrun_version: version,
        entry_workflow_id: id.into(),
        workflows: documents
            .iter()
            .map(|(id, document)| ShareDependency {
                id: id.clone(),
                name: document["settings"]["name"].as_str().unwrap_or("Workflow").into(),
            })
            .collect(),
        apps: Vec::new(),
        requirements,
    };
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&documents)?));
    let bindings = suggested_bindings(&manifest.requirements);
    Ok((
        WorkflowSharePreview {
            manifest,
            files: Vec::new(),
            total_bytes: 0,
            fingerprint,
            bindings,
        },
        documents,
    ))
}

pub async fn workflow_share_configuration_preview(id: String, version: String) -> Result<WorkflowSharePreview> {
    ensure_personal()?;
    Ok(configuration_plan(&id, super::get_workflows().await?, version)?.0)
}

pub async fn workflow_share_configure(
    id: String,
    fingerprint: String,
    bindings: BTreeMap<String, String>,
    version: String,
) -> Result<IWorkflow> {
    ensure_personal()?;
    let path = crate::utils::dirs::workflow_catalog_path()?;
    let preview = workflow_share_configuration_preview(id.clone(), version.clone()).await?;
    validate_bindings(&preview.manifest.requirements, &bindings).await?;
    Config::workflows()
        .await
        .with_data_modify(|mut data| async move {
            let (preview, documents) = configuration_plan(&id, data.get_workflows(), version)?;
            if preview.fingerprint != fingerprint {
                bail!("Workflow changed since configuration preview; reopen it");
            }
            let workflow_map = documents.keys().map(|id| (id.clone(), id.clone())).collect();
            let mut app_map = BTreeMap::new();
            for document in documents.values() {
                for node in document_nodes(document)? {
                    for reference in references(node)? {
                        if reference.kind != ReferenceKind::Workflow
                            && !reference.id.starts_with(IMPORT_PREFIX)
                            && !reference.id.starts_with("mcp:")
                        {
                            app_map.insert(reference.id.clone(), reference.id);
                        }
                    }
                }
            }
            let mut updated = remap_documents(&documents, &app_map, &workflow_map, &bindings)?;
            validate_bound_skills(&updated)?;
            record_pending_requirements(&mut updated, &preview.manifest.requirements)?;
            for workflow in &mut updated {
                workflow.created_at = data.find_workflow(&workflow.id).context("Missing Workflow")?.created_at;
                data.replace_workflow(workflow.clone());
            }
            save_catalog(path, &data).await?;
            let root = updated.into_iter().find(|workflow| workflow.id == id).unwrap();
            Ok((data, root))
        })
        .await
}

fn pending_value(value: &Value) -> bool {
    match value {
        Value::String(value) => value.starts_with(IMPORT_PREFIX),
        Value::Array(values) => values.iter().any(pending_value),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| key.starts_with(IMPORT_PREFIX) || pending_value(value)),
        _ => false,
    }
}

/// An imported parent's execution must not begin before a child is configured.
pub(crate) async fn validate_imported_workflow_dependencies(dsl: &crate::module::workflow::WorkflowDsl) -> Result<()> {
    if !dsl.nodes.iter().any(|node| node.data["sharePackage"] == true) {
        return Ok(());
    }
    let mut pending = vec![
        dsl.nodes
            .iter()
            .map(|node| json!({"id":node.id, "type":node.kind, "data":node.data}))
            .collect::<Vec<_>>(),
    ];
    let mut seen = BTreeSet::new();
    while let Some(nodes) = pending.pop() {
        for node in nodes {
            if pending_value(&node["data"]) {
                bail!(
                    "Imported Workflow node {} has pending configuration; configure it before running",
                    node["id"]
                );
            }
            let skills: Vec<_> = node["data"]["skillRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|skill| skill["name"].as_str().map(str::to_owned))
                .collect();
            if !skills.is_empty() {
                let resolved = SkillRegistry::resolve(&skills)?;
                let ids = node["data"]["toolIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|tool| tool.as_str().map(str::to_owned))
                    .collect();
                crate::module::skill::allowed_tool_ids(&resolved, ids)?;
            }
            if node["type"] == "subworkflow" {
                let id = node["data"]["workflowId"]
                    .as_str()
                    .context("Missing child Workflow ID")?;
                if seen.insert(id.to_owned()) {
                    if seen.len() > MAX_WORKFLOWS {
                        bail!("Workflow dependency limit exceeded");
                    }
                    let child = super::get_workflow(id).await?;
                    pending.push(document_nodes(&child.document)?.clone());
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "workflow_share/tests.rs"]
mod tests;
