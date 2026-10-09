//! Personal App sharing uses ordinary ZIP/TAR files with a versioned root manifest.
use super::process_node::collect_app_source_files;
use crate::{
    config::{
        Config, IProcessNode, ProcessNodePublicationStatus, validate_process_node_catalog,
        validate_process_node_definition,
    },
    module::process_node::{ProcessNode, ProcessNodeRegistry},
    process::AsyncHandler,
    utils::dirs,
};
use anyhow::{Context, Result, bail};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tempfile::TempDir;
use uuid::Uuid;

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_JSON_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppShareManifest {
    pub format: String,
    pub format_version: u32,
    pub exported_at: String,
    pub workrun_version: String,
    pub source_directory: String,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppShareFormat {
    Zip,
    Tar,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSharePreview {
    pub manifest: AppShareManifest,
    pub app: serde_json::Value,
    pub files: Vec<String>,
    pub total_bytes: u64,
    pub sha256: Option<String>,
}

fn ensure_personal() -> Result<()> {
    if dirs::is_team_workspace() {
        bail!("App sharing is available in personal mode only");
    }
    Ok(())
}

fn manifest(version: String) -> AppShareManifest {
    AppShareManifest {
        format: "workrun-app".into(),
        format_version: 1,
        exported_at: Utc::now().to_rfc3339(),
        workrun_version: version,
        source_directory: "app".into(),
    }
}

// Use an allowlist so new local catalog fields never silently become public.
fn portable_app(definition: &IProcessNode) -> Result<serde_json::Value> {
    let mut value = serde_json::to_value(definition)?;
    value.as_object_mut().context("Invalid App settings")?.retain(|key, _| {
        matches!(
            key.as_str(),
            "name"
                | "description"
                | "version"
                | "entry"
                | "compensation"
                | "kind"
                | "toolExecutionPolicy"
                | "toolRiskLevel"
                | "toolPermissions"
                | "inputs"
                | "outputs"
        )
    });
    Ok(value)
}

fn local_definition(mut value: serde_json::Value, name: Option<String>) -> Result<IProcessNode> {
    let object = value.as_object_mut().context("app.json must be an object")?;
    // Imported settings cannot select a local path, reuse an ID or impersonate a Team release.
    object.retain(|key, _| {
        matches!(
            key.as_str(),
            "name"
                | "description"
                | "version"
                | "entry"
                | "compensation"
                | "kind"
                | "toolExecutionPolicy"
                | "toolRiskLevel"
                | "toolPermissions"
                | "inputs"
                | "outputs"
        )
    });
    object.insert("id".into(), Uuid::now_v7().to_string().into());
    if let Some(name) = name {
        object.insert("name".into(), name.trim().into());
    }
    let mut definition: IProcessNode = serde_json::from_value(value).context("Invalid app.json settings")?;
    let now = Utc::now().to_rfc3339();
    definition.created_at = now.clone();
    definition.updated_at = now;
    definition.publication_status = ProcessNodePublicationStatus::Published;
    validate_process_node_definition(&definition)?;
    portable_path(&definition.entry)?;
    if let Some(compensation) = &definition.compensation {
        portable_path(&compensation.entry)?;
    }
    Ok(definition)
}

fn portable_path(path: &Path) -> Result<()> {
    let text = path.to_str().context("Archive paths must be UTF-8")?;
    // Reject Windows separators/drive paths on every host, not just on Windows.
    if text.is_empty()
        || text.contains(['\\', ':', '\0'])
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || text.split('/').any(|part| part == "." || part == "..")
    {
        bail!("Invalid archive path: {text}");
    }
    Ok(())
}

fn validate_source(root: &Path, definition: &IProcessNode, files: &[PathBuf]) -> Result<()> {
    for required in [
        Some(&definition.entry),
        definition.compensation.as_ref().map(|item| &item.entry),
        Some(&PathBuf::from("pyproject.toml")),
    ]
    .into_iter()
    .flatten()
    {
        if !files.contains(required) || !root.join(required).is_file() {
            bail!(
                "Required App source file is missing or excluded: {}",
                required.display()
            );
        }
    }
    Ok(())
}

fn source_preview(root: &Path, definition: &IProcessNode, version: String) -> Result<AppSharePreview> {
    let files = collect_app_source_files(root)?;
    validate_source(root, definition, &files)?;
    let mut total_bytes = 0;
    for file in &files {
        portable_path(Path::new(&file.to_string_lossy().replace('\\', "/")))?;
        total_bytes += root.join(file).metadata()?.len();
    }
    if files.len() + 2 > MAX_FILES || total_bytes > MAX_BYTES {
        bail!("App exceeds the sharing size or file-count limit");
    }
    Ok(AppSharePreview {
        manifest: manifest(version),
        app: portable_app(definition)?,
        files: files
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect(),
        total_bytes,
        sha256: None,
    })
}

pub async fn app_share_export_preview(id: String, version: String) -> Result<AppSharePreview> {
    ensure_personal()?;
    let definition = super::process_node_inspect(&id).await?.definition;
    let root = ProcessNodeRegistry::project_path(&definition)?;
    AsyncHandler::spawn_blocking(move || source_preview(&root, &definition, version)).await?
}

pub async fn app_share_export(
    id: String,
    destination: PathBuf,
    format: AppShareFormat,
    excluded_files: Vec<String>,
    expected_files: Vec<String>,
    version: String,
) -> Result<()> {
    ensure_personal()?;
    let definition = super::process_node_inspect(&id).await?.definition;
    let root = ProcessNodeRegistry::project_path(&definition)?;
    AsyncHandler::spawn_blocking(move || {
        let preview = source_preview(&root, &definition, version)?;
        if preview.files != expected_files {
            bail!("App source file list changed; reopen the export preview");
        }
        write_package(&root, &definition, &destination, format, &excluded_files, preview)
    })
    .await?
}

fn write_package(
    root: &Path,
    definition: &IProcessNode,
    destination: &Path,
    format: AppShareFormat,
    excluded: &[String],
    preview: AppSharePreview,
) -> Result<()> {
    let files: Vec<PathBuf> = preview
        .files
        .iter()
        .filter(|path| !excluded.contains(path))
        .map(PathBuf::from)
        .collect();
    validate_source(root, definition, &files)?;
    let metadata = [
        ("manifest.json", serde_json::to_vec_pretty(&preview.manifest)?),
        ("app.json", serde_json::to_vec_pretty(&preview.app)?),
    ];
    if metadata.iter().any(|(_, bytes)| bytes.len() as u64 > MAX_JSON_BYTES) {
        bail!("App metadata is too large");
    }
    let parent = destination.parent().context("Export destination has no parent")?;
    let mut output = tempfile::NamedTempFile::new_in(parent)?;
    match format {
        AppShareFormat::Zip => {
            let mut archive = zip::ZipWriter::new(output.as_file_mut());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .unix_permissions(0o644);
            for (path, bytes) in &metadata {
                archive.start_file(*path, options)?;
                archive.write_all(bytes)?;
            }
            for path in &files {
                let mut source = File::open(root.join(path))?;
                #[cfg(unix)]
                let options = {
                    use std::os::unix::fs::PermissionsExt;
                    options.unix_permissions(if source.metadata()?.permissions().mode() & 0o111 != 0 {
                        0o755
                    } else {
                        0o644
                    })
                };
                archive.start_file(format!("app/{}", path.to_string_lossy().replace('\\', "/")), options)?;
                std::io::copy(&mut source, &mut archive)?;
            }
            archive.finish()?;
        },
        AppShareFormat::Tar => {
            let mut archive = tar::Builder::new(output.as_file_mut());
            for (path, bytes) in &metadata {
                let mut header = tar::Header::new_gnu();
                header.set_size(bytes.len() as u64);
                header.set_mode(0o644);
                header.set_cksum();
                archive.append_data(&mut header, *path, bytes.as_slice())?;
            }
            for path in &files {
                archive.append_file(Path::new("app").join(path), &mut File::open(root.join(path))?)?;
            }
            archive.finish()?;
        },
    }
    if output.as_file().metadata()?.len() > MAX_BYTES {
        bail!("Exported archive exceeds 512 MiB");
    }
    output.as_file().sync_all()?;
    // Publish only a complete archive; failed exports do not truncate the destination.
    output.persist(destination).map_err(|error| error.error)?;
    Ok(())
}

struct Package {
    staging: TempDir,
    preview: AppSharePreview,
    definition: IProcessNode,
}

fn extract_entry(
    reader: &mut impl Read,
    root: &Path,
    path: &Path,
    size: u64,
    directory: bool,
    seen: &mut HashSet<PathBuf>,
    total: &mut u64,
) -> Result<()> {
    portable_path(path)?;
    if !seen.insert(path.to_path_buf()) {
        bail!("Duplicate archive entry: {}", path.display());
    }
    *total = total.checked_add(size).context("Archive size overflow")?;
    if seen.len() > MAX_FILES || *total > MAX_BYTES {
        bail!("Archive exceeds the size or file-count limit");
    }
    if matches!(path.to_str(), Some("manifest.json" | "app.json")) && size > MAX_JSON_BYTES {
        bail!("App metadata is too large");
    }
    let destination = root.join(path);
    if directory {
        std::fs::create_dir_all(destination)?;
    } else {
        std::fs::create_dir_all(destination.parent().context("Invalid archive entry")?)?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(destination)?;
        let copied = std::io::copy(&mut reader.take(size + 1), &mut output)?;
        if copied != size {
            bail!("Archive entry size mismatch");
        }
    }
    Ok(())
}

fn restore_executable(root: &Path, path: &Path, mode: u32, directory: bool) -> Result<()> {
    #[cfg(unix)]
    if !directory {
        use std::os::unix::fs::PermissionsExt;
        // Preserve executability without restoring ownership or special permission bits.
        std::fs::set_permissions(
            root.join(path),
            std::fs::Permissions::from_mode(if mode & 0o111 != 0 { 0o755 } else { 0o644 }),
        )?;
    }
    #[cfg(not(unix))]
    let _ = (root, path, mode, directory);
    Ok(())
}

fn read_package(path: &Path) -> Result<Package> {
    let mut input = File::open(path)?;
    if input.metadata()?.len() > MAX_BYTES {
        bail!("Archive exceeds 512 MiB");
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut input, &mut digest)?;
    let sha256 = format!("{:x}", digest.finalize());
    use std::io::{Seek, SeekFrom};
    input.seek(SeekFrom::Start(0))?;
    let staging = tempfile::tempdir()?;
    let mut seen = HashSet::new();
    let mut total = 0;
    match path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("zip") => {
            let mut archive = zip::ZipArchive::new(input)?;
            if archive.len() > MAX_FILES {
                bail!("Archive contains too many entries");
            }
            for index in 0..archive.len() {
                let mut entry = archive.by_index(index)?;
                let mode = entry.unix_mode().unwrap_or(0);
                if !matches!(mode & 0o170000, 0 | 0o100000 | 0o040000) {
                    bail!("Archive links and special files are unsupported");
                }
                let path = PathBuf::from(entry.name()?.as_ref());
                let size = entry.size();
                let directory = entry.is_dir();
                extract_entry(
                    &mut entry,
                    staging.path(),
                    &path,
                    size,
                    directory,
                    &mut seen,
                    &mut total,
                )?;
                restore_executable(staging.path(), &path, mode, directory)?;
            }
        },
        Some("tar") => {
            let mut archive = tar::Archive::new(input);
            for entry in archive.entries()? {
                let mut entry = entry?;
                let kind = entry.header().entry_type();
                if !kind.is_file() && !kind.is_dir() {
                    bail!("Archive links and special files are unsupported");
                }
                let path = entry.path()?.into_owned();
                let size = entry.size();
                let mode = entry.header().mode()?;
                extract_entry(
                    &mut entry,
                    staging.path(),
                    &path,
                    size,
                    kind.is_dir(),
                    &mut seen,
                    &mut total,
                )?;
                restore_executable(staging.path(), &path, mode, kind.is_dir())?;
            }
        },
        _ => bail!("Select a ZIP or TAR archive"),
    }
    let manifest: AppShareManifest = serde_json::from_reader(
        File::open(staging.path().join("manifest.json")).context("Missing root manifest.json")?,
    )?;
    if manifest.format != "workrun-app" || manifest.format_version != 1 {
        bail!("Unsupported App sharing format or version");
    }
    let source = PathBuf::from(&manifest.source_directory);
    portable_path(&source)?;
    if source.components().count() != 1 || matches!(manifest.source_directory.as_str(), "manifest.json" | "app.json") {
        bail!("Source directory must be a root-level directory");
    }
    if seen
        .iter()
        .any(|path| path != Path::new("manifest.json") && path != Path::new("app.json") && !path.starts_with(&source))
    {
        bail!("Unexpected file outside App source directory");
    }
    let app: serde_json::Value =
        serde_json::from_reader(File::open(staging.path().join("app.json")).context("Missing root app.json")?)?;
    let definition = local_definition(app.clone(), None)?;
    let mut files: Vec<PathBuf> = seen
        .iter()
        .filter(|path| staging.path().join(path).is_file() && path.starts_with(&source))
        .map(|path| path.strip_prefix(&source).unwrap().to_path_buf())
        .collect();
    files.sort();
    let root = staging.path().join(&source);
    validate_source(&root, &definition, &files)?;
    let total_bytes = files.iter().try_fold(0u64, |sum, path| -> Result<u64> {
        Ok(sum + root.join(path).metadata()?.len())
    })?;
    let preview = AppSharePreview {
        manifest,
        app: portable_app(&definition)?,
        files: files
            .iter()
            .map(|path| path.to_string_lossy().replace('\\', "/"))
            .collect(),
        total_bytes,
        sha256: Some(sha256),
    };
    Ok(Package {
        staging,
        preview,
        definition,
    })
}

pub async fn app_share_import_preview(path: PathBuf) -> Result<AppSharePreview> {
    ensure_personal()?;
    AsyncHandler::spawn_blocking(move || Ok(read_package(&path)?.preview)).await?
}

pub async fn app_share_prepare(id: String) -> Result<()> {
    ensure_personal()?;
    let definition = super::process_node_inspect(&id).await?.definition;
    let root = ProcessNodeRegistry::project_path(&definition)?;
    let version = crate::module::process_node::project_python_version(&root).await?;
    crate::module::python_runtime::PythonRuntime::sync_dependencies(&root, &version).await?;
    Ok(())
}

pub async fn app_share_import(path: PathBuf, sha256: String, name: String) -> Result<ProcessNode> {
    ensure_personal()?;
    let package = AsyncHandler::spawn_blocking(move || read_package(&path)).await??;
    if package.preview.sha256.as_deref() != Some(&sha256) {
        bail!("Archive changed since preview; select it again");
    }
    let mut definition = package.definition;
    definition.name = name.trim().to_owned();
    validate_process_node_definition(&definition)?;
    let destination = ProcessNodeRegistry::project_path(&definition)?;
    let parent = destination.parent().context("App directory has no parent")?;
    std::fs::create_dir_all(parent)?;
    // Stage on the destination filesystem so activation is a single rename.
    let prepared = tempfile::tempdir_in(parent)?;
    let source = package.staging.path().join(&package.preview.manifest.source_directory);
    let staged = prepared.path().join("source");
    let copy_source = source.clone();
    let copy_staged = staged.clone();
    AsyncHandler::spawn_blocking(move || -> Result<()> {
        std::fs::create_dir(&copy_staged)?;
        for entry in walkdir::WalkDir::new(&copy_source) {
            let entry = entry?;
            let target = copy_staged.join(entry.path().strip_prefix(&copy_source)?);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(target)?;
            } else {
                std::fs::copy(entry.path(), target)?;
            }
        }
        Ok(())
    })
    .await??;
    if destination.exists() {
        bail!("Imported App destination already exists");
    }
    tokio::fs::rename(staged, &destination).await?;
    let saved = Config::process_nodes()
        .await
        .with_data_modify(|mut data| async move {
            data.add_process_node(definition.clone());
            validate_process_node_catalog(&data)?;
            data.save_file().await?;
            Ok((data, definition))
        })
        .await;
    match saved {
        Ok(definition) => Ok(ProcessNodeRegistry::with_installation(definition).await),
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(destination).await;
            Err(error)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn settings() -> serde_json::Value {
        json!({"name":"Example", "description":"Shared source", "version":"1.2.3", "entry":"main.py",
            "kind":"tool", "toolExecutionPolicy":"ask_every_time", "toolRiskLevel":"medium",
            "toolPermissions":["files.read"], "inputs":{"message":{"type":"string"}}, "outputs":{},
            "compensation":{"entry":"cleanup.py"}})
    }

    fn source(root: &Path) {
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".venv")).unwrap();
        for (path, bytes) in [
            ("main.py", "print('hello')"),
            ("cleanup.py", "pass"),
            ("pyproject.toml", "[project]\nname='example'\nversion='1.2.3'\n"),
            ("uv.lock", "version = 1"),
            (".gitignore", "*.tmp\n!keep.tmp\n"),
            ("src/.gitignore", "private.txt\n"),
            ("src/module.py", "pass"),
            ("src/private.txt", "private"),
            ("skip.tmp", "cache"),
            ("keep.tmp", "included"),
            (".venv/cache.py", "cache"),
            (".env", "KEY=secret"),
            (".env.example", "KEY="),
        ] {
            std::fs::write(root.join(path), bytes).unwrap();
        }
    }

    #[test]
    fn zip_and_tar_roundtrip_settings_source_and_ignore_rules() {
        for (format, extension) in [(AppShareFormat::Zip, "zip"), (AppShareFormat::Tar, "tar")] {
            let project = tempfile::tempdir().unwrap();
            source(project.path());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(project.path().join("main.py"), std::fs::Permissions::from_mode(0o755))
                    .unwrap();
            }
            let output = tempfile::tempdir().unwrap();
            let path = output.path().join(format!("app.{extension}"));
            let definition = local_definition(settings(), None).unwrap();
            write_package(
                project.path(),
                &definition,
                &path,
                format,
                &["keep.tmp".into()],
                source_preview(project.path(), &definition, "0.1.0-test".into()).unwrap(),
            )
            .unwrap();
            let package = read_package(&path).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    package
                        .staging
                        .path()
                        .join("app/main.py")
                        .metadata()
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o755
                );
            }
            assert_eq!(package.preview.app, settings());
            assert_eq!(package.preview.manifest.workrun_version, "0.1.0-test");
            assert_eq!(package.preview.manifest.source_directory, "app");
            assert_ne!(package.definition.id, definition.id);
            assert!(package.definition.project_root.is_none());
            assert!(package.preview.files.contains(&"src/module.py".into()));
            assert!(package.preview.files.contains(&"uv.lock".into()));
            assert!(package.preview.files.contains(&".env.example".into()));
            for excluded in ["keep.tmp", "skip.tmp", "src/private.txt", ".venv/cache.py", ".env"] {
                assert!(!package.preview.files.contains(&excluded.into()));
            }
            assert_eq!(
                std::fs::read_to_string(package.staging.path().join("app/main.py")).unwrap(),
                "print('hello')"
            );
        }
    }

    #[test]
    fn importing_cannot_reuse_local_or_remote_identity() {
        let mut app = settings();
        for (key, value) in [
            ("id", "original-id"),
            ("projectRoot", "/outside"),
            ("remoteAppId", "team-app"),
            ("teamInstallationScope", "scope"),
            ("publicationStatus", "draft"),
        ] {
            app[key] = value.into();
        }
        let definition = local_definition(app, Some(" Copy ".into())).unwrap();
        assert_eq!(definition.name, "Copy");
        assert!(definition.project_root.is_none());
        assert!(definition.remote_app_id.is_none());
        assert!(definition.team_installation_scope.is_none());
        assert_eq!(definition.publication_status, ProcessNodePublicationStatus::Published);
        assert!(portable_app(&definition).unwrap().get("id").is_none());
    }

    #[test]
    fn required_source_cannot_be_excluded_and_failed_export_preserves_destination() {
        let project = tempfile::tempdir().unwrap();
        source(project.path());
        let output = tempfile::tempdir().unwrap();
        let path = output.path().join("app.zip");
        std::fs::write(&path, "previous").unwrap();
        let definition = local_definition(settings(), None).unwrap();
        for excluded in ["main.py", "cleanup.py", "pyproject.toml"] {
            assert!(
                write_package(
                    project.path(),
                    &definition,
                    &path,
                    AppShareFormat::Zip,
                    &[excluded.into()],
                    source_preview(project.path(), &definition, "test".into()).unwrap()
                )
                .is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous");
        }
    }

    fn custom_tar(path: &Path, manifest: AppShareManifest, extra: Option<(&str, tar::EntryType)>) {
        let mut archive = tar::Builder::new(File::create(path).unwrap());
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let app = serde_json::to_vec(&settings()).unwrap();
        for (name, data) in [
            ("manifest.json".to_string(), bytes),
            ("app.json".to_string(), app),
            (format!("{}/main.py", manifest.source_directory), b"pass".to_vec()),
            (format!("{}/cleanup.py", manifest.source_directory), b"pass".to_vec()),
            (
                format!("{}/pyproject.toml", manifest.source_directory),
                b"[project]".to_vec(),
            ),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(data.len() as u64);
            header.set_cksum();
            archive.append_data(&mut header, name, data.as_slice()).unwrap();
        }
        if let Some((name, kind)) = extra {
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o644);
            header.set_size(0);
            header.set_entry_type(kind);
            // Build raw malicious names because the TAR writer rejects traversal itself.
            header.as_mut_bytes()[..name.len()].copy_from_slice(name.as_bytes());
            if kind.is_symlink() || kind.is_hard_link() {
                header.set_link_name("/outside").unwrap();
            }
            header.set_cksum();
            archive.append(&header, std::io::empty()).unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn accepts_app_id_source_directory() {
        let output = tempfile::tempdir().unwrap();
        let path = output.path().join("app.tar");
        let mut metadata = manifest("test".into());
        metadata.source_directory = Uuid::now_v7().to_string();
        custom_tar(&path, metadata.clone(), None);
        assert_eq!(
            read_package(&path).unwrap().preview.manifest.source_directory,
            metadata.source_directory
        );
    }

    #[test]
    fn rejects_unknown_protocol_version_missing_metadata_links_duplicates_and_traversal() {
        let output = tempfile::tempdir().unwrap();
        let path = output.path().join("app.tar");
        let mut metadata = manifest("test".into());
        metadata.format_version = 2;
        custom_tar(&path, metadata, None);
        assert!(read_package(&path).is_err());
        for (name, kind) in [
            ("app/link", tar::EntryType::Symlink),
            ("app/link", tar::EntryType::Link),
            ("manifest.json", tar::EntryType::Regular),
            ("../outside", tar::EntryType::Regular),
            ("/outside", tar::EntryType::Regular),
            ("app\\outside", tar::EntryType::Regular),
            ("extra.txt", tar::EntryType::Regular),
        ] {
            custom_tar(&path, manifest("test".into()), Some((name, kind)));
            assert!(read_package(&path).is_err(), "accepted {name}");
        }
        let mut archive = tar::Builder::new(File::create(&path).unwrap());
        archive.finish().unwrap();
        assert!(read_package(&path).is_err());
    }

    #[test]
    fn rejects_oversized_entries_before_writing() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            extract_entry(
                &mut std::io::empty(),
                root.path(),
                Path::new("app/large"),
                MAX_BYTES + 1,
                false,
                &mut HashSet::new(),
                &mut 0
            )
            .is_err()
        );
        assert!(!root.path().join("app/large").exists());
    }
}
