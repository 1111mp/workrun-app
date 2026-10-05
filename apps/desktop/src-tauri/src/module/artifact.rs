//! Immutable workspace-local resources. State and checkpoints carry references only.
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRef {
    #[serde(rename = "$type")]
    pub kind: String,
    pub id: String,
    pub version: u32,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct ArtifactStore {
    root: PathBuf,
}

impl ArtifactStore {
    pub fn active() -> Result<Self> {
        Ok(Self::new(crate::utils::dirs::artifacts_dir()?))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn directory(&self, reference: &ArtifactRef) -> Result<PathBuf> {
        if reference.kind != "artifact" || reference.version != 1 || Uuid::parse_str(&reference.id).is_err() {
            bail!("Invalid artifact reference");
        }
        Ok(self.root.join(Uuid::parse_str(&reference.id)?.to_string()))
    }

    /// External viewers receive a disposable copy with a PDF extension, so
    /// saving changes in a viewer cannot modify the immutable run snapshot.
    pub fn pdf_preview_copy(&self, reference: &ArtifactRef, directory: &Path) -> Result<PathBuf> {
        if reference.mime_type != "application/pdf" {
            bail!("Resource is not a PDF");
        }
        let source = self.resolve(reference)?;
        fs::create_dir_all(directory)?;
        // A viewer can keep its file locked on Windows. Never overwrite a copy
        // already open in another application when the user previews again.
        let destination = directory.join(format!(
            "{}-{}-{}.pdf",
            Uuid::parse_str(&reference.id)?,
            reference.version,
            Uuid::new_v4()
        ));
        fs::copy(source, &destination)?;
        Ok(destination)
    }

    pub fn save_bytes(&self, name: &str, bytes: &[u8]) -> Result<ArtifactRef> {
        self.save_bytes_with_mime(name, bytes, None)
    }

    /// Keep a remote media type for formats without a recognizable header.
    /// Known binary signatures take precedence over external labels.
    pub fn save_bytes_with_mime(&self, name: &str, bytes: &[u8], mime: Option<&str>) -> Result<ArtifactRef> {
        if bytes.len() as u64 > MAX_FILE_BYTES {
            bail!("Resource exceeds the 512 MiB limit");
        }
        let temporary = tempfile::tempdir()?;
        let filename = Path::new(name).file_name().context("Invalid resource filename")?;
        let source = temporary.path().join(filename);
        fs::write(&source, bytes)?;
        self.import_with_mime(&source, mime)
    }

    pub fn import(&self, source: &Path) -> Result<ArtifactRef> {
        self.import_with_mime(source, None)
    }

    fn import_with_mime(&self, source: &Path, mime: Option<&str>) -> Result<ArtifactRef> {
        if let Some(mime) = mime {
            let mut header = [0u8; 16];
            let count = fs::File::open(source)?.read(&mut header)?;
            validate_media_type(&header[..count], mime)?;
        }
        let normalized_mime = mime.map(|m| m.split(';').next().unwrap_or(m).trim().to_ascii_lowercase());
        let mime = normalized_mime.as_deref();
        let mut input = fs::File::open(source).context("Cannot open resource file")?;
        let metadata = input.metadata()?;
        if metadata.len() > MAX_FILE_BYTES {
            bail!("Resource exceeds the 512 MiB limit");
        }
        if !metadata.is_file() {
            bail!("Resource must be a regular file");
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .context("Invalid resource filename")?
            .to_string();
        let id = Uuid::new_v4().to_string();
        let dir = self.root.join(&id);
        fs::create_dir_all(&dir)?;
        let result = (|| {
            let mut output = fs::File::create(dir.join("data"))?;
            let mut hash = Sha256::new();
            let mut size = 0u64;
            let mut header = Vec::new();
            let mut buffer = [0u8; 65536];
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                if size > MAX_FILE_BYTES {
                    bail!("Resource exceeds the 512 MiB limit");
                }
                if header.is_empty() {
                    header.extend_from_slice(&buffer[..count.min(16)]);
                }
                hash.update(&buffer[..count]);
                output.write_all(&buffer[..count])?;
            }
            output.sync_all()?;
            let reference = ArtifactRef {
                kind: "artifact".into(),
                id,
                version: 1,
                mime_type: mime
                    .filter(|m| *m != "application/octet-stream")
                    .unwrap_or_else(|| detect_mime(&header, &name))
                    .into(),
                name,
                size,
            };
            fs::write(dir.join("sha256"), format!("{:x}", hash.finalize()))?;
            // Metadata is the commit marker: incomplete imports cannot be resolved.
            fs::write(dir.join("metadata.json"), serde_json::to_vec(&reference)?)?;
            Ok(reference)
        })();
        if result.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        result
    }

    pub fn resolve(&self, reference: &ArtifactRef) -> Result<PathBuf> {
        let dir = self.directory(reference)?;
        let stored: ArtifactRef = serde_json::from_slice(
            &fs::read(dir.join("metadata.json"))
                .context("Resource is missing; restore the original file before replay")?,
        )?;
        // Display names may be redacted in visible State; identity and media metadata must match.
        if stored.id != reference.id
            || stored.version != reference.version
            || stored.size != reference.size
            || stored.mime_type != reference.mime_type
        {
            bail!("Resource metadata does not match its snapshot");
        }
        let path = dir.join("data");
        let mut input = fs::File::open(&path)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != fs::read_to_string(dir.join("sha256"))? {
            bail!("Resource snapshot is corrupted");
        }
        Ok(path)
    }
}

pub fn validate_input(schema: &Value, input: &Value) -> Result<()> {
    let Some(fields) = schema.get("fields").and_then(Value::as_array) else {
        return Ok(());
    };
    for field in fields {
        let Some(key) = field.get("key").and_then(Value::as_str) else {
            continue;
        };
        let kind = field.get("type").and_then(Value::as_str);
        if !matches!(kind, Some("file" | "files")) {
            continue;
        }
        let value = input.get(key);
        if value.is_none_or(Value::is_null) {
            if field.get("required").and_then(Value::as_bool) == Some(true) {
                bail!("Missing required file input: {key}");
            }
            continue;
        }
        let value = value.unwrap();
        let valid = if kind == Some("file") {
            value.get("$type").and_then(Value::as_str) == Some("artifact")
                && serde_json::from_value::<ArtifactRef>(value.clone()).is_ok()
        } else {
            value.as_array().is_some_and(|values| {
                !values.is_empty()
                    && values.iter().all(|value| {
                        value.get("$type").and_then(Value::as_str) == Some("artifact")
                            && serde_json::from_value::<ArtifactRef>(value.clone()).is_ok()
                    })
            })
        };
        if !valid {
            bail!("Invalid file input: {key}");
        }
    }
    Ok(())
}

pub fn references(value: &Value) -> Result<Vec<ArtifactRef>> {
    fn collect(value: &Value, result: &mut Vec<ArtifactRef>) -> Result<()> {
        match value {
            Value::Object(object) if object.get("$type").and_then(Value::as_str) == Some("artifact") => {
                let reference: ArtifactRef =
                    serde_json::from_value(value.clone()).context("Malformed artifact reference")?;
                if !result.contains(&reference) {
                    result.push(reference);
                }
            },
            Value::Object(object) => {
                for value in object.values() {
                    collect(value, result)?;
                }
            },
            Value::Array(values) => {
                for value in values {
                    collect(value, result)?;
                }
            },
            _ => {},
        }
        Ok(())
    }
    let mut result = Vec::new();
    collect(value, &mut result)?;
    Ok(result)
}

pub fn validate_media_type(header: &[u8], mime: &str) -> Result<()> {
    if mime.len() > 255 || !mime.bytes().all(|b| b.is_ascii_graphic() || b == b' ') {
        bail!("Invalid resource media type");
    }
    let essence = mime.split(';').next().unwrap_or(mime).trim().to_ascii_lowercase();
    let Some((kind, subtype)) = essence.split_once('/') else {
        bail!("Invalid resource media type");
    };
    let token = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    if !token(kind) || !token(subtype) {
        bail!("Invalid resource media type");
    }
    let detected = detect_mime(header, "");
    if detected != "application/octet-stream" && detected != essence && essence != "application/octet-stream" {
        bail!("Resource media type does not match its binary signature");
    }
    Ok(())
}

fn detect_mime(header: &[u8], name: &str) -> &'static str {
    if header.starts_with(b"%PDF-") {
        return "application/pdf";
    }
    if header.starts_with(b"\x89PNG\r\n\x1a\n") {
        return "image/png";
    }
    if header.starts_with(b"\xff\xd8\xff") {
        return "image/jpeg";
    }
    if header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a") {
        return "image/gif";
    }
    if header.starts_with(b"RIFF") && header.get(8..12) == Some(b"WEBP") {
        return "image/webp";
    }
    match Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "txt" | "md" | "csv" => "text/plain",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_media_types_are_preserved_and_known_signatures_validated() {
        let directory = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(directory.path().join("artifacts"));
        let json = store
            .save_bytes_with_mime("result", b"{}", Some("application/json"))
            .unwrap();
        assert_eq!(json.mime_type, "application/json");
        assert_eq!(fs::read(store.resolve(&json).unwrap()).unwrap(), b"{}");
        let pdf = store
            .save_bytes_with_mime("result", b"%PDF-example", Some("application/octet-stream"))
            .unwrap();
        assert_eq!(pdf.mime_type, "application/pdf");
        let parameterized = store
            .save_bytes_with_mime("result", b"%PDF-example", Some("application/PDF; charset=binary"))
            .unwrap();
        assert_eq!(parameterized.mime_type, "application/pdf");
        assert!(validate_media_type(b"", "application/").is_err());
        assert!(
            store
                .save_bytes_with_mime("wrong.png", b"%PDF-example", Some("image/png"))
                .is_err()
        );
        assert!(
            store
                .save_bytes_with_mime("result", b"{}", Some("application/json\n"))
                .is_err()
        );
    }

    #[test]
    fn external_pdf_preview_uses_a_copy_with_a_pdf_extension() {
        let temporary = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(temporary.path().join("store"));
        let reference = store.save_bytes("resume.pdf", b"%PDF-original").unwrap();
        let directory = temporary.path().join("previews");
        let copy = store.pdf_preview_copy(&reference, &directory).unwrap();
        assert_eq!(copy.extension().unwrap(), "pdf");
        fs::write(&copy, b"viewer edits").unwrap();
        assert_eq!(fs::read(store.resolve(&reference).unwrap()).unwrap(), b"%PDF-original");
        let reopened = store.pdf_preview_copy(&reference, &directory).unwrap();
        assert_ne!(copy, reopened);
        assert_eq!(fs::read(reopened).unwrap(), b"%PDF-original");
        assert_eq!(fs::read(copy).unwrap(), b"viewer edits");
        let image = store.save_bytes("image.png", b"\x89PNG\r\n\x1a\nimage").unwrap();
        assert!(store.pdf_preview_copy(&image, &directory).is_err());
    }

    #[test]
    fn validates_single_and_multiple_file_input_contracts() {
        let temp = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(temp.path().join("store"));
        let file = store.save_bytes("report.pdf", b"%PDF-report").unwrap();
        let single = serde_json::json!({"fields":[{"key":"document", "type":"file", "required":true}]});
        let multiple = serde_json::json!({"fields":[{"key":"documents", "type":"files", "required":true}]});
        assert!(validate_input(&single, &serde_json::json!({"document":file})).is_ok());
        assert!(validate_input(&single, &serde_json::json!({})).is_err());
        assert!(validate_input(&single, &serde_json::json!({"document":"/tmp/report.pdf"})).is_err());
        assert!(validate_input(&multiple, &serde_json::json!({"documents":[file]})).is_ok());
        assert!(validate_input(&multiple, &serde_json::json!({"documents":[]})).is_err());
    }
    #[test]
    fn oversized_files_are_rejected_before_copying() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("large.mp4");
        fs::File::create(&source).unwrap().set_len(MAX_FILE_BYTES + 1).unwrap();
        let root = temp.path().join("store");
        assert!(ArtifactStore::new(root.clone()).import(&source).is_err());
        assert!(!root.exists());
    }

    #[test]
    fn snapshots_survive_source_changes_and_detect_tampering() {
        let temp = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(temp.path().join("store"));
        let source = temp.path().join("invoice.pdf");
        fs::write(&source, b"%PDF-original").unwrap();
        let reference = store.import(&source).unwrap();
        fs::write(&source, b"replacement").unwrap();
        let path = store.resolve(&reference).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"%PDF-original");
        assert_eq!(reference.mime_type, "application/pdf");
        fs::write(path, b"tampered").unwrap();
        assert!(store.resolve(&reference).is_err());
    }
    #[test]
    fn rejects_path_traversal_and_collects_nested_references() {
        let temp = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(temp.path().join("store"));
        let source = temp.path().join("photo.png");
        fs::write(&source, b"\x89PNG\r\n\x1a\nimage").unwrap();
        let mut reference = store.import(&source).unwrap();
        let value = serde_json::json!({"nodes": {"process": {"files": [reference.clone()]}}});
        assert_eq!(references(&value).unwrap(), vec![reference.clone()]);
        reference.id = "../../other".into();
        assert!(store.resolve(&reference).is_err());
    }
}
