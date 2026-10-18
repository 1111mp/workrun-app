//! Session-scoped file access and temporary computation, without a workflow graph.
use crate::module::{
    artifact::{ArtifactRef, ArtifactStore},
    workflow::codeact_agent::CodeActWorkspace,
};
use adk_rust::agent::codeact::{CodeRuntime, RunStep};
use adk_rust::codeact_monty::{MontyRuntime, PathAccess};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::HashMap, io::Read, time::Duration};

pub(in crate::module::assistant) fn declarations() -> HashMap<String, Value> {
    [
        ("read_artifact", json!({"name":"read_artifact","description":"Read a user-provided or tool-produced text artifact in this session. Returns a bounded text page with truncation and next_offset. Use the actual contents and schema; file metadata is not its content. Binary formats need an appropriate available tool.","parameters":{"type":"object","properties":{"artifact_id":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":32000}},"required":["artifact_id"],"additionalProperties":false}})),
        ("run_code", json!({"name":"run_code","description":"Run temporary Monty Python for this task, without creating or executing a Workflow. No network, subprocess, package installation or host files. Authorized session files are listed in /artifacts/manifest.json as [{reference:{id,name,...},path}]. Read entry.path using pathlib.Path. Supported modules: json,pathlib,re,datetime,typing,sys,os,asyncio. Put a JSON-serializable result as the LAST EXPRESSION, not a top-level return. Write optional deliverables under /outputs. Each call starts a fresh interpreter; errors return feedback for correction. Bound dictionary method callbacks are unsupported; use functions/loops. Inspect source data and derive task logic yourself.","parameters":{"type":"object","properties":{"code":{"type":"string","maxLength":32000}},"required":["code"],"additionalProperties":false}})),
    ].into_iter().map(|(name, declaration)| (name.into(), declaration)).collect()
}

pub(in crate::module::assistant) fn execute(
    store: ArtifactStore,
    name: &str,
    args: &Value,
    authorized: &[ArtifactRef],
) -> Result<Value> {
    match name {
        "read_artifact" => {
            let id = args["artifact_id"].as_str().context("artifact_id is required")?;
            let reference = authorized
                .iter()
                .find(|reference| reference.id == id)
                .context("Artifact is not attached to this session")?;
            ensure!(
                reference.size <= 1_048_576,
                "Text preview is limited to 1 MiB; use run_code to inspect a larger file incrementally"
            );
            let mut bytes = vec![];
            std::fs::File::open(store.resolve(reference)?)?
                .take(1_048_577)
                .read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 1_048_576, "Text preview exceeds 1 MiB");
            let text =
                String::from_utf8(bytes).context("Artifact is not UTF-8 text; use a suitable file-format tool")?;
            ensure!(!text.contains('\0'), "Artifact appears to be binary");
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(12000).clamp(1, 32000) as usize;
            let total = text.chars().count();
            ensure!(offset <= total, "Offset is beyond the end of this artifact");
            let page = text.chars().skip(offset).take(limit).collect::<String>();
            let next = offset + page.chars().count();
            Ok(
                json!({"artifact":reference,"text":page,"offset":offset,"total_characters":total,"truncated":next<total,"next_offset":(next<total).then_some(next)}),
            )
        },
        "run_code" => {
            let code = args["code"].as_str().context("code is required")?;
            ensure!(
                !code.is_empty() && code.len() <= 32000,
                "Code must contain 1–32000 bytes"
            );
            let workspace = CodeActWorkspace::new(store)?;
            workspace.prepare(&json!({"files":authorized}), None)?;
            let runtime = MontyRuntime::builder()
                .max_duration(Duration::from_secs(5))
                .max_memory(64 * 1024 * 1024)
                .allow_path("/artifacts", workspace.inputs(), PathAccess::ReadOnly)
                .allow_path("/outputs", workspace.outputs(), PathAccess::ReadWrite)
                .build();
            match runtime.start(code, "assistant.py")? {
                RunStep::Complete { value, stdout, .. } => {
                    let value = if value["type"] == "final_result" {
                        value["value"].clone()
                    } else {
                        value
                    };
                    ensure!(
                        serde_json::to_vec(&value)?.len() <= 64000,
                        "Result exceeds 64 KB; write a deliverable under /outputs instead"
                    );
                    Ok(
                        json!({"value":value,"stdout":stdout.chars().take(16000).collect::<String>(),"artifacts":workspace.collect()?,"workflow_created":false}),
                    )
                },
                RunStep::Raised { message, stdout } => Ok(
                    json!({"error":message,"stdout":stdout.chars().take(16000).collect::<String>(),"artifacts":[],"workflow_created":false}),
                ),
                RunStep::Call { .. } => bail!("run_code cannot invoke external tools; use their authorized interfaces"),
            }
        },
        _ => bail!("Unknown direct tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn direct_text_and_computation_do_not_create_workflows_or_escape_session_scope() {
        let root = tempfile::tempdir().unwrap();
        let store = ArtifactStore::new(root.path().join("artifacts"));
        let reference = store.save_bytes("input.txt", "αβγ\n".as_bytes()).unwrap();
        let page = execute(
            store.clone(),
            "read_artifact",
            &json!({"artifact_id":reference.id,"limit":2}),
            std::slice::from_ref(&reference),
        )
        .unwrap();
        assert_eq!(page["text"], "αβ");
        assert_eq!(page["next_offset"], 2);
        assert!(
            execute(
                store.clone(),
                "read_artifact",
                &json!({"artifact_id":reference.id}),
                &[]
            )
            .is_err()
        );
        let result = execute(store.clone(), "run_code", &json!({"code":"from pathlib import Path\nimport json\nfiles=json.loads(Path('/artifacts/manifest.json').read_text())\ntext=Path(files[0]['path']).read_text()\nPath('/outputs/result.txt').write_text(text)\n{'length':len(text)}"}), &[reference]).unwrap();
        assert_eq!(result["value"]["length"], 4);
        assert_eq!(result["workflow_created"], false);
        assert_eq!(result["artifacts"].as_array().unwrap().len(), 1);
        assert!(!root.path().join("assistant/drafts").exists());
        let denied = execute(
            store,
            "run_code",
            &json!({"code":"from pathlib import Path\nPath('/etc/passwd').read_text()"}),
            &[],
        )
        .unwrap();
        assert!(denied["error"].is_string());
    }
}
