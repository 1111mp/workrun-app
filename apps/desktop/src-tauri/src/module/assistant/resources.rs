//! Assistant manuals are external Tauri resources, never embedded document bodies.
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

pub(super) fn root() -> Result<PathBuf> {
    // Debug builds and headless unit tests share prebuild's generated directory.
    // Release builds must resolve the installed bundle, never a source checkout.
    #[cfg(debug_assertions)]
    {
        Ok(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/assistant"))
    }
    #[cfg(not(debug_assertions))]
    {
        Ok(crate::utils::dirs::app_resources_dir()?.join("assistant"))
    }
}

pub(super) fn read(relative: &str) -> Result<String> {
    read_at(&root()?, relative)
}

fn read_at(root: &Path, relative: &str) -> Result<String> {
    // All callers use fixed manifest paths; reject traversal if a future caller
    // accidentally forwards a model-supplied path instead of a catalog key.
    anyhow::ensure!(
        !relative.is_empty()
            && Path::new(relative)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_))),
        "Invalid assistant resource path"
    );
    let path = root.join(relative);
    std::fs::read_to_string(&path).with_context(|| {
        format!("Missing or unreadable assistant resource {}. Run pnpm workflow:generate for development, or reinstall the application bundle.", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installed_resource_layout_reads_without_a_source_checkout() {
        let bundle = tempfile::tempdir().unwrap();
        let root = bundle.path().join("resources/assistant");
        std::fs::create_dir_all(root.join("workflow_agent/reference/nodes")).unwrap();
        std::fs::write(
            root.join("workflow_agent/reference/nodes/agent.md"),
            "external node skill",
        )
        .unwrap();
        assert_eq!(
            read_at(&root, "workflow_agent/reference/nodes/agent.md").unwrap(),
            "external node skill"
        );
        assert!(read_at(&root, "workflow_agent/reference/nodes/missing.md").is_err());
        assert!(read_at(&root, "../secret").is_err());
        assert!(read_at(&root, "/secret").is_err());
    }
}
