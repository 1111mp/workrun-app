use super::*;
use crate::config::{Draft, IProcessNodes, IWorkflows, ProcessNodeKind};
use std::sync::{Arc, atomic::AtomicBool};

fn id() -> String {
    Uuid::now_v7().to_string()
}

fn workflow(id: &str, name: &str, nodes: Value) -> IWorkflow {
    IWorkflow {
        id: id.into(),
        created_at: "now".into(),
        updated_at: "now".into(),
        document: json!({"nodes":nodes, "edges":[], "settings":{"name":name,"description":"", "mode":"task", "inputSchema":{"fields":[]}}}),
    }
}

fn app(root: &Path, kind: ProcessNodeKind) -> IProcessNode {
    let mut definition = local_definition(
        json!({"name":"Dependency", "version":"1.0.0", "entry":"main.py", "kind":kind,
        "inputs":{"value":{"type":"string"}}, "outputs":{"result":{"type":"string"}}}),
        None,
    )
    .unwrap();
    definition.project_root = Some(root.to_path_buf());
    let project = root.join(&definition.id);
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::write(project.join("main.py"), "print('hello')").unwrap();
    std::fs::write(
        project.join("pyproject.toml"),
        "[project]\nname='example'\nversion='1.0.0'",
    )
    .unwrap();
    std::fs::write(project.join(".gitignore"), "private.txt\n").unwrap();
    std::fs::write(project.join("private.txt"), "not shared").unwrap();
    std::fs::write(project.join(".env"), "TOP_SECRET=secret").unwrap();
    std::fs::write(project.join("src/helper.py"), "pass").unwrap();
    definition
}

fn fixture(root: &Path) -> (ExportPlan, String, String, String) {
    let process = app(root, ProcessNodeKind::Workflow);
    let tool = app(root, ProcessNodeKind::Tool);
    let compensation = app(root, ProcessNodeKind::Tool);
    let parent_id = id();
    let child_id = id();
    let mcp = format!("mcp:{}:echo", id());
    let parent = workflow(
        &parent_id,
        "Parent",
        json!([
            {"id":"start","type":"start","position":{"x":0,"y":0},"data":{}},
            {"id":"process","type":"process","data":{"processNodeId":process.id,"appRef":{"source":"local","localAppId":process.id,"sourceHash":"private-hash"}}},
            {"id":"agent","type":"agent","data":{"modelProfileId":model_catalog()[0].id,"toolIds":[tool.id,mcp],
                "toolStateBindings":[{"toolId":tool.id,"argumentPath":"value","statePath":"input.value"},{"toolId":mcp,"argumentPath":"value","statePath":"input.value"}],
                "toolCompensations":{tool.id.clone():{"mode":"compensatable","action":{"kind":"tool","toolId":compensation.id}},mcp.clone():{"mode":"read_only"}}}},
            {"id":"child","type":"subworkflow","data":{"workflowId":child_id}},
            {"id":"end","type":"end","data":{}}
        ]),
    );
    let child = workflow(
        &child_id,
        "Child",
        json!([
            {"id":"start","type":"start","data":{}},
            {"id":"process","type":"process","data":{"processNodeId":process.id}},
            {"id":"code","type":"codeact_agent","data":{"modelProfileId":model_catalog()[0].id,"toolIds":[tool.id],
                "mounts":[{"virtualPath":"/input","hostPath":"/PRIVATE_HOST_DIRECTORY","access":"read_only"}],
                "environment":[{"name":"TOKEN","value":"PRIVATE_ENV_SECRET"}]}},
            {"id":"remote","type":"remote_agent","data":{"url":"https://example.com/agent","authentication":{"type":"bearer","credentialId":"PRIVATE_CREDENTIAL_ID"}}},
            {"id":"end","type":"end","data":{}}
        ]),
    );
    let tools = vec![
        ProcessNodeRegistry::tool_definition(tool.clone()).unwrap(),
        ProcessNodeRegistry::tool_definition(compensation.clone()).unwrap(),
    ];
    let plan = make_export_plan(
        &parent_id,
        vec![parent, child],
        vec![process.clone(), tool.clone(), compensation],
        tools,
        BTreeMap::new(),
        "test-client".into(),
    )
    .unwrap();
    (plan, process.id, tool.id, child_id)
}

#[test]
fn export_ignores_unrelated_unfinished_tools_and_strips_private_urls() {
    let directory = tempfile::tempdir().unwrap();
    let tool = app(directory.path(), ProcessNodeKind::Tool);
    let mut unfinished = app(directory.path(), ProcessNodeKind::Tool);
    unfinished.inputs.clear();
    unfinished.outputs.clear();
    let root = id();
    let document = workflow(
        &root,
        "Sharing",
        json!([
            {"id":"start","type":"start","data":{}},
            {"id":"agent","type":"agent","data":{"toolIds":[tool.id]}},
            {"id":"remote","type":"remote_agent","data":{"url":"https://private-user:private-password@example.com/agent?token=private-query","authentication":{"type":"none"}}},
            {"id":"end","type":"end","data":{}}
        ]),
    );
    let plan = make_export_plan(
        &root,
        vec![document],
        vec![tool, unfinished],
        vec![],
        BTreeMap::new(),
        "test".into(),
    )
    .unwrap();
    assert_eq!(plan.manifest.apps.len(), 1);
    assert!(plan.manifest.requirements.iter().any(|item| item.kind == "url"));
    let serialized = format!(
        "{}{}",
        serde_json::to_string(&plan.documents).unwrap(),
        serde_json::to_string(&plan.manifest).unwrap()
    );
    for secret in ["private-user", "private-password", "private-query"] {
        assert!(!serialized.contains(secret));
    }
}

#[test]
fn deduplicates_transitive_apps_and_strips_private_configuration() {
    let source = tempfile::tempdir().unwrap();
    let (plan, _, _, _) = fixture(source.path());
    assert_eq!(plan.manifest.apps.len(), 3);
    assert_eq!(plan.manifest.workflows.len(), 2);
    assert_eq!(
        plan.manifest
            .requirements
            .iter()
            .filter(|item| item.kind == "model")
            .count(),
        1
    );
    assert_eq!(
        plan.manifest
            .requirements
            .iter()
            .filter(|item| item.kind == "tool")
            .count(),
        1
    );
    let json = serde_json::to_string(&(&plan.documents, &plan.manifest)).unwrap();
    for secret in [
        "PRIVATE_HOST_DIRECTORY",
        "PRIVATE_ENV_SECRET",
        "PRIVATE_CREDENTIAL_ID",
        "private-hash",
    ] {
        assert!(!json.contains(secret));
    }
    assert!(
        plan.files
            .iter()
            .all(|(path, _)| !path.ends_with("private.txt") && !path.ends_with(".env"))
    );
}

#[test]
fn zip_and_tar_roundtrip_and_remap_all_reference_locations() {
    for (format, extension) in [(AppShareFormat::Zip, "zip"), (AppShareFormat::Tar, "tar")] {
        let source = tempfile::tempdir().unwrap();
        let output = tempfile::tempdir().unwrap();
        let (plan, process_id, tool_id, child_id) = fixture(source.path());
        let path = output.path().join(format!("workflow.{extension}"));
        write_share_archive(&path, format, &plan.metadata().unwrap(), &plan.files).unwrap();
        let package = read_workflow_package(&path).unwrap();
        assert_eq!(package.documents, plan.documents);
        assert_eq!(package.apps.len(), 3);
        let app_map: BTreeMap<_, _> = package
            .apps
            .iter()
            .map(|(id, app)| (id.clone(), app.id.clone()))
            .collect();
        let workflow_map: BTreeMap<_, _> = package.documents.keys().map(|old| (old.clone(), id())).collect();
        let mut bindings = suggested_bindings(&package.manifest.requirements);
        let tool_requirement = package
            .manifest
            .requirements
            .iter()
            .find(|item| item.kind == "tool")
            .unwrap();
        bindings.insert(tool_requirement.id.clone(), "mcp:local:replacement".into());
        let imported = remap_documents(&package.documents, &app_map, &workflow_map, &bindings).unwrap();
        let root = imported
            .iter()
            .find(|workflow| workflow.id == workflow_map[&plan.manifest.entry_workflow_id])
            .unwrap();
        let nodes = root.document["nodes"].as_array().unwrap();
        assert_eq!(nodes[1]["data"]["processNodeId"], app_map[&process_id]);
        assert_eq!(nodes[1]["data"]["appRef"]["localAppId"], app_map[&process_id]);
        assert_eq!(nodes[2]["data"]["toolIds"][0], app_map[&tool_id]);
        assert_eq!(nodes[2]["data"]["toolStateBindings"][0]["toolId"], app_map[&tool_id]);
        assert_eq!(
            nodes[2]["data"]["toolStateBindings"][1]["toolId"],
            "mcp:local:replacement"
        );
        let declarations = nodes[2]["data"]["toolCompensations"].as_object().unwrap();
        assert!(declarations.contains_key(&app_map[&tool_id]));
        assert!(declarations.contains_key("mcp:local:replacement"));
        assert!(!declarations.contains_key(&tool_id));
        let compensation = declarations[&app_map[&tool_id]]["action"]["toolId"].as_str().unwrap();
        assert!(app_map.values().any(|id| id == compensation));
        assert_eq!(nodes[3]["data"]["workflowId"], workflow_map[&child_id]);
        assert!(pending_value(
            &imported
                .iter()
                .find(|workflow| workflow.id == workflow_map[&child_id])
                .unwrap()
                .document
        ));
        assert!(nodes[0]["data"]["sharePackage"] == true);
    }
}

#[test]
fn rejects_cycles_missing_dependencies_and_unrelated_payloads() {
    let root = id();
    let child = id();
    let parent = workflow(
        &root,
        "Parent",
        json!([{"id":"child","type":"subworkflow","data":{"workflowId":child}}]),
    );
    let cycle = workflow(
        &child,
        "Child",
        json!([{"id":"parent","type":"subworkflow","data":{"workflowId":root}}]),
    );
    assert!(
        make_export_plan(
            &root,
            vec![parent.clone(), cycle],
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
            "test".into()
        )
        .is_err()
    );
    assert!(
        make_export_plan(
            &root,
            vec![parent],
            Vec::new(),
            Vec::new(),
            BTreeMap::new(),
            "test".into()
        )
        .is_err()
    );
    let source = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let (plan, _, _, _) = fixture(source.path());
    let mut metadata = plan.metadata().unwrap();
    metadata.push(("unrelated.txt".into(), b"extra".to_vec()));
    let path = output.path().join("workflow.zip");
    write_share_archive(&path, AppShareFormat::Zip, &metadata, &plan.files).unwrap();
    assert!(read_workflow_package(&path).is_err());
}

#[test]
fn rejects_missing_app_and_requirement_metadata() {
    let source = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let (mut plan, _, _, _) = fixture(source.path());
    let path = output.path().join("workflow.tar");
    plan.manifest.requirements.clear();
    write_share_archive(&path, AppShareFormat::Tar, &plan.metadata().unwrap(), &plan.files).unwrap();
    assert!(read_workflow_package(&path).is_err());
    let (plan, _, _, _) = fixture(source.path());
    let mut metadata = plan.metadata().unwrap();
    metadata.retain(|(path, _)| !path.starts_with("apps/"));
    write_share_archive(&path, AppShareFormat::Tar, &metadata, &plan.files).unwrap();
    assert!(read_workflow_package(&path).is_err());
}

#[tokio::test]
async fn blocks_unconfigured_import_before_execution() {
    let dsl: crate::module::workflow::WorkflowDsl=serde_json::from_value(json!({"nodes":[{"id":"start","type":"start","data":{"sharePackage":true}},{"id":"agent","type":"agent","data":{"modelProfileId":"workrun-import:requirement-1"}}]})).unwrap();
    assert!(
        validate_imported_workflow_dependencies(&dsl)
            .await
            .unwrap_err()
            .to_string()
            .contains("pending configuration")
    );
}

#[test]
fn pending_configuration_survives_reopening_and_updates_child_tools_without_new_app_ids() {
    let source = tempfile::tempdir().unwrap();
    let (plan, _, tool_id, _) = fixture(source.path());
    let app_map: BTreeMap<_, _> = plan.settings.keys().map(|old| (old.clone(), id())).collect();
    let workflow_map: BTreeMap<_, _> = plan.documents.keys().map(|old| (old.clone(), id())).collect();
    let root_id = &workflow_map[&plan.manifest.entry_workflow_id];
    let mut imported = remap_documents(&plan.documents, &app_map, &workflow_map, &BTreeMap::new()).unwrap();
    record_pending_requirements(&mut imported, &plan.manifest.requirements).unwrap();
    // Serialize and deserialize the catalog, rather than relying on dialog memory.
    let catalog: Vec<IWorkflow> = serde_json::from_slice(&serde_json::to_vec(&imported).unwrap()).unwrap();
    let (preview, documents) = configuration_plan(root_id, catalog.clone(), "test".into()).unwrap();
    assert_eq!(preview.manifest.requirements.len(), plan.manifest.requirements.len());
    let mut bindings = BTreeMap::new();
    for requirement in &preview.manifest.requirements {
        let value = match requirement.kind.as_str() {
            "tool" => "mcp:local:echo".into(),
            "model" => model_catalog()[0].id.clone(),
            "mount" => "/new/local/directory".into(),
            "environment" => "local-secret".into(),
            "credential" => "new-local-credential".into(),
            _ => unreachable!(),
        };
        bindings.insert(requirement.id.clone(), value);
    }
    let identity_apps = app_map.values().map(|id| (id.clone(), id.clone())).collect();
    let identity_workflows = documents.keys().map(|id| (id.clone(), id.clone())).collect();
    let mut configured = remap_documents(&documents, &identity_apps, &identity_workflows, &bindings).unwrap();
    record_pending_requirements(&mut configured, &preview.manifest.requirements).unwrap();
    let (reopened, _) = configuration_plan(root_id, configured.clone(), "test".into()).unwrap();
    assert!(reopened.manifest.requirements.is_empty());
    assert!(configured.iter().all(|workflow| !pending_value(&workflow.document)));
    let root = configured.iter().find(|workflow| &workflow.id == root_id).unwrap();
    let agent = &root.document["nodes"][2]["data"];
    assert_eq!(agent["toolIds"][0], app_map[&tool_id]);
    assert!(
        agent["toolCompensations"]
            .as_object()
            .unwrap()
            .contains_key("mcp:local:echo")
    );
    let mut changed = catalog;
    changed[0].document["settings"]["name"] = "Changed".into();
    assert_ne!(
        configuration_plan(root_id, changed, "test".into())
            .unwrap()
            .0
            .fingerprint,
        preview.fingerprint
    );
}

#[tokio::test]
async fn catalog_write_failure_rolls_back_both_snapshots_and_activated_sources() {
    let source = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let (plan, _, _, _) = fixture(source.path());
    let path = output.path().join("workflow.zip");
    write_share_archive(&path, AppShareFormat::Zip, &plan.metadata().unwrap(), &plan.files).unwrap();
    let mut package = read_workflow_package(&path).unwrap();
    let managed = output.path().join("managed");
    for app in package.apps.values_mut() {
        app.project_root = Some(managed.clone());
    }
    let activated = activate_apps(package.staging.path(), &package.apps).unwrap();
    let paths = activated.paths.clone();
    assert!(paths.iter().all(|path| path.exists()));
    let apps = Draft::new(IProcessNodes::default());
    let workflows = Draft::new(IWorkflows::default());
    let app_path = output.path().join("apps.json");
    let workflow_path = output.path().join("workflow-is-a-directory");
    std::fs::create_dir(&workflow_path).unwrap();
    let retain = Arc::new(AtomicBool::new(false));
    let result = commit_import(
        apps.clone(),
        workflows.clone(),
        app_path.clone(),
        workflow_path,
        package.apps.values().cloned().collect(),
        Vec::new(),
        retain.clone(),
    )
    .await;
    assert!(result.is_err());
    assert!(apps.data_arc().get_process_nodes().is_empty());
    assert!(workflows.data_arc().workflows.is_empty());
    assert!(
        read_json::<IProcessNodes>(&app_path)
            .unwrap()
            .get_process_nodes()
            .is_empty()
    );
    assert!(!retain.load(std::sync::atomic::Ordering::Acquire));
    drop(activated);
    assert!(paths.iter().all(|path| !path.exists()));
}

#[tokio::test]
async fn successful_catalog_commit_keeps_existing_objects_and_adds_entire_bundle() {
    let source = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    let (plan, _, _, _) = fixture(source.path());
    let path = output.path().join("workflow.zip");
    write_share_archive(&path, AppShareFormat::Zip, &plan.metadata().unwrap(), &plan.files).unwrap();
    let package = read_workflow_package(&path).unwrap();
    let old_app = app(source.path(), ProcessNodeKind::Workflow);
    let old_workflow = workflow(&id(), "Existing", json!([]));
    let apps = Draft::new(IProcessNodes::from_nodes(vec![old_app.clone()]));
    let workflows = Draft::new(IWorkflows {
        workflows: vec![old_workflow.clone()],
    });
    let app_map = package
        .apps
        .iter()
        .map(|(id, app)| (id.clone(), app.id.clone()))
        .collect();
    let workflow_map = package.documents.keys().map(|old| (old.clone(), id())).collect();
    let imported = remap_documents(&package.documents, &app_map, &workflow_map, &BTreeMap::new()).unwrap();
    commit_import(
        apps.clone(),
        workflows.clone(),
        output.path().join("apps.json"),
        output.path().join("workflows.json"),
        package.apps.values().cloned().collect(),
        imported,
        Arc::new(AtomicBool::new(false)),
    )
    .await
    .unwrap();
    assert_eq!(apps.data_arc().get_process_nodes().len(), 4);
    assert_eq!(workflows.data_arc().workflows.len(), 3);
    assert!(apps.data_arc().get_process_node(&old_app.id).is_some());
    assert!(workflows.data_arc().find_workflow(&old_workflow.id).is_some());
}
