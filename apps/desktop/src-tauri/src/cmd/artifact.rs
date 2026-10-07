use crate::{
    cmd::{CmdResult, StringifyErr as _},
    module::artifact::{ArtifactRef, ArtifactStore},
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn artifact_pick(app: tauri::AppHandle, multiple: bool) -> CmdResult<Vec<ArtifactRef>> {
    let store = ArtifactStore::active().stringify_err()?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<Vec<ArtifactRef>> {
        let dialog = app.dialog().file();
        let paths = if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        paths.into_iter().map(|path| store.import(&path.into_path()?)).collect()
    })
    .await
    .stringify_err()?
    .stringify_err()
}

#[tauri::command]
pub async fn artifact_export(app: tauri::AppHandle, reference: ArtifactRef) -> CmdResult<bool> {
    let store = ArtifactStore::active().stringify_err()?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<bool> {
        let source = store.resolve(&reference)?;
        let Some(destination) = app.dialog().file().set_file_name(&reference.name).blocking_save_file() else {
            return Ok(false);
        };
        std::fs::copy(source, destination.into_path()?)?;
        Ok(true)
    })
    .await
    .stringify_err()?
    .stringify_err()
}

#[tauri::command]
pub async fn artifact_preview(reference: ArtifactRef) -> CmdResult<String> {
    let store = ArtifactStore::active().stringify_err()?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<String> {
        use base64::Engine as _;
        if reference.size > 20 * 1024 * 1024 {
            anyhow::bail!("Preview is limited to 20 MiB; download the file to view it");
        }
        if !matches!(
            reference.mime_type.as_str(),
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "video/mp4" | "video/webm" | "video/quicktime"
        ) {
            anyhow::bail!("Preview is not supported for this file type");
        }
        let bytes = std::fs::read(store.resolve(&reference)?)?;
        Ok(format!(
            "data:{};base64,{}",
            reference.mime_type,
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .stringify_err()?
    .stringify_err()
}

#[tauri::command]
pub async fn artifact_open_pdf(app: tauri::AppHandle, reference: ArtifactRef) -> CmdResult<()> {
    let store = ArtifactStore::active().stringify_err()?;
    let directory = crate::utils::dirs::runtime_dir()
        .stringify_err()?
        .join("artifact-previews");
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<()> {
        let copy = store.pdf_preview_copy(&reference, &directory)?;
        app.opener()
            .open_path(copy.to_string_lossy().into_owned(), None::<String>)?;
        Ok(())
    })
    .await
    .stringify_err()?
    .stringify_err()
}
