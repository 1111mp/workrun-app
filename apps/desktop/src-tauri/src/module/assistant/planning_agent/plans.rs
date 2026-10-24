//! Workspace/session-scoped versioned plans. Models cannot approve their own plans.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Feedback {
    pub id: String,
    pub version: u32,
    pub quote: String,
    pub decision: String,
}
impl Feedback {
    pub fn valid(&self, plan: &Value, message: &str, turn: &str) -> bool {
        plan["id"] == self.id
            && plan["version"] == self.version
            && match self.decision.as_str() {
                "approve" => plan["status"] == "ready",
                "cancel" => matches!(
                    plan["status"].as_str(),
                    Some("ready" | "needs_clarification" | "failed" | "approved")
                ),
                _ => false,
            }
            && plan["createdTurnKey"] != turn
            && !self.quote.trim().is_empty()
            && message.contains(&self.quote)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub name: String,
    pub description: String,
    pub artifact_id: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Dependency {
    pub kind: String,
    pub id: String,
    pub purpose: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub title: String,
    pub description: String,
    #[serde(default)]
    pub node_types: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<Dependency>,
    #[serde(default)]
    pub configuration_notes: String,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub goal: String,
    pub summary: String,
    pub inputs: Vec<Input>,
    pub outputs: Vec<String>,
    pub steps: Vec<Step>,
    pub constraints: Vec<String>,
    pub assumptions: Vec<String>,
    pub questions: Vec<String>,
    pub acceptance_criteria: Vec<String>,
    pub target_id: Option<String>,
}
impl Document {
    pub fn parse(value: &Value) -> Result<Self> {
        ensure!(serde_json::to_vec(value)?.len() <= 65536, "Plan exceeds 64 KiB");
        let document: Self = serde_json::from_value(value.clone())?;
        fn text(value: &str) -> bool {
            !value.trim().is_empty() && value.len() <= 6000
        }
        ensure!(
            text(&document.goal) && text(&document.summary),
            "Plan requires a bounded goal and summary"
        );
        ensure!(
            !document.steps.is_empty() && document.steps.len() <= 30,
            "Plan requires 1-30 steps"
        );
        ensure!(
            !document.outputs.is_empty() && !document.acceptance_criteria.is_empty(),
            "Plan requires outputs and acceptance criteria"
        );
        for values in [
            &document.outputs,
            &document.constraints,
            &document.assumptions,
            &document.questions,
            &document.acceptance_criteria,
        ] {
            ensure!(
                values.len() <= 30 && values.iter().all(|v| text(v) && v.len() <= 2000),
                "Invalid plan entries"
            );
        }
        ensure!(
            document.inputs.len() <= 30 && document.inputs.iter().all(|v| text(&v.name) && text(&v.description)),
            "Invalid plan inputs"
        );
        for step in &document.steps {
            ensure!(
                text(&step.title)
                    && text(&step.description)
                    && step.configuration_notes.len() <= 6000
                    && step.node_types.len() <= 20
                    && step.dependencies.len() <= 30,
                "Invalid plan step"
            );
            if !step.node_types.is_empty() {
                super::super::workflow_agent::authoring::reference(
                    &json!({"topic":"node-schema","node_types":step.node_types}),
                )?;
            }
            for dependency in &step.dependencies {
                ensure!(
                    matches!(
                        dependency.kind.as_str(),
                        "model" | "tool" | "skill" | "workflow" | "app"
                    ) && text(&dependency.id)
                        && text(&dependency.purpose),
                    "Invalid plan dependency"
                );
            }
        }
        if let Some(id) = &document.target_id {
            uuid::Uuid::parse_str(id).context("Revision target must be a workflow UUID")?;
        }
        Ok(document)
    }
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub id: String,
    pub session_id: String,
    pub version: u32,
    pub status: String,
    pub document: Document,
    pub dependency_issues: Vec<String>,
    pub created_turn_key: String,
    pub approved_turn_key: Option<String>,
    pub workflow_id: Option<String>,
    pub outcome: Option<Value>,
}
// Mutations run under the native conversation lease (including restart recovery).
pub struct Store {
    root: PathBuf,
}
impl Store {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.join("assistant/plans"),
        }
    }
    fn directory(&self, session: &str) -> Result<PathBuf> {
        Ok(self.root.join(uuid::Uuid::parse_str(session)?.to_string()))
    }
    pub fn current(&self, session: &str) -> Result<Option<Plan>> {
        let path = self.directory(session)?.join("current.json");
        match std::fs::read(path) {
            Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    pub fn revision(&self, session: &str, version: u32) -> Result<Plan> {
        Ok(serde_json::from_slice(&std::fs::read(
            self.directory(session)?.join(format!("v{version}.json")),
        )?)?)
    }
    fn write(&self, session: &str, name: &str, plan: &Plan) -> Result<()> {
        let directory = self.directory(session)?;
        std::fs::create_dir_all(&directory)?;
        let mut file = tempfile::NamedTempFile::new_in(&directory)?;
        file.write_all(&serde_json::to_vec_pretty(plan)?)?;
        file.as_file().sync_all()?;
        file.persist(directory.join(name))?;
        Ok(())
    }
    pub fn save(&self, session: &str, turn: &str, base: u32, document: Document, issues: Vec<String>) -> Result<Plan> {
        let old = self.current(session)?;
        ensure!(
            old.as_ref().map_or(0, |p| p.version) == base,
            "Plan changed; read its latest version before revising"
        );
        ensure!(
            old.as_ref()
                .is_none_or(|p| !matches!(p.status.as_str(), "approved" | "building")),
            "Cannot revise an approved or building plan"
        );
        let plan = Plan {
            id: old
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            session_id: session.into(),
            version: base.checked_add(1).context("Plan version exhausted")?,
            status: if document.questions.is_empty() && issues.is_empty() {
                "ready"
            } else {
                "needs_clarification"
            }
            .into(),
            document,
            dependency_issues: issues,
            created_turn_key: turn.into(),
            approved_turn_key: None,
            workflow_id: None,
            outcome: None,
        };
        self.write(session, &format!("v{}.json", plan.version), &plan)?;
        self.write(session, "current.json", &plan)?;
        Ok(plan)
    }
    pub fn decide(&self, session: &str, id: &str, version: u32, approve: bool, turn: &str) -> Result<Plan> {
        let plan = self.preview_decision(session, id, version, approve, turn)?;
        self.write(session, "current.json", &plan)?;
        Ok(plan)
    }
    pub fn preview_decision(&self, session: &str, id: &str, version: u32, approve: bool, turn: &str) -> Result<Plan> {
        let mut plan = self.current(session)?.context("No plan to review")?;
        ensure!(
            plan.id == id && plan.version == version,
            "Plan changed; review the latest version"
        );
        ensure!(
            matches!(plan.status.as_str(), "ready" | "needs_clarification" | "failed")
                || (!approve && plan.status == "approved"),
            "Plan decision is stale"
        );
        if approve {
            ensure!(
                plan.status == "ready" && plan.document.questions.is_empty() && plan.dependency_issues.is_empty(),
                "Resolve plan questions and dependency issues before creating"
            );
            ensure!(
                plan.created_turn_key != turn && !turn.is_empty(),
                "A plan needs a subsequent user decision"
            );
        }
        plan.status = if approve { "approved" } else { "cancelled" }.into();
        plan.approved_turn_key = approve.then(|| turn.to_owned());
        Ok(plan)
    }
    pub fn transition(
        &self,
        session: &str,
        id: &str,
        version: u32,
        status: &str,
        outcome: Option<Value>,
    ) -> Result<Plan> {
        let mut plan = self.current(session)?.context("Plan is missing")?;
        ensure!(
            plan.id == id && plan.version == version,
            "Workflow result belongs to a different plan version"
        );
        ensure!(
            matches!(
                (plan.status.as_str(), status),
                ("approved", "building") | ("building", "saved") | ("building", "failed")
            ),
            "Invalid plan state transition"
        );
        if status == "saved" {
            let id = outcome
                .as_ref()
                .and_then(|v| v["workflow_id"].as_str())
                .context("Saved outcome needs a workflow ID")?;
            plan.workflow_id = Some(id.into());
        }
        plan.status = status.into();
        plan.outcome = outcome;
        self.write(session, "current.json", &plan)?;
        Ok(plan)
    }
}

/// Preserve the proposal's committed resources without freezing implementation
/// hints. Native schema/compiler validation checks the actual generated nodes.
pub(in crate::module::assistant) fn validate_graph(plan: &Value, workflow: &Value) -> Result<()> {
    let document: Document = serde_json::from_value(plan["document"].clone())?;
    let nodes = workflow["nodes"].as_array().context("Workflow nodes are missing")?;
    for step in &document.steps {
        for resource in &step.dependencies {
            let matched = nodes.iter().any(|node| {
                let data = &node["data"];
                match resource.kind.as_str() {
                    "model" => data["modelProfileId"] == resource.id,
                    "tool" => data["toolIds"]
                        .as_array()
                        .is_some_and(|ids| ids.iter().any(|id| id == &resource.id)),
                    "skill" => data["skillRefs"].as_array().is_some_and(|refs| {
                        refs.iter()
                            .any(|r| r["name"] == resource.id || r.as_str() == Some(resource.id.as_str()))
                    }),
                    "workflow" => data["workflowId"] == resource.id,
                    "app" => {
                        data["processNodeId"].as_str() == Some(resource.id.strip_prefix("app:").unwrap_or(&resource.id))
                    },
                    _ => false,
                }
            });
            ensure!(
                matched,
                "Approved dependency '{}' ({}) is not used by the generated workflow",
                resource.id,
                resource.kind
            );
        }
    }
    Ok(())
}
