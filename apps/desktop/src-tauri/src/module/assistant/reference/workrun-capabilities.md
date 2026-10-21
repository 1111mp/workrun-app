---
name: workrun-capabilities
description: Workrun capability map, configuration concepts and discovery paths.
---
# Workrun capabilities

Main handles intent, direct work and execution requests. Planning develops a proposal
with user feedback; after native confirmation, authoring configures/saves an ordinary
Workflow using the same settings, nodes and edges as the visual editor. Creation and
execution are separate authorizations. Reading guidance never changes available tools.

## Capability map

| Work | Native capability | Discovery/details |
| --- | --- | --- |
| Reuse a saved Workflow | subworkflow, or main's authorized execution | list_capabilities; subworkflow guide |
| Inputs, outputs and task/chat mode | settings schemas/sessionStateFields | format/state references |
| Language work and tool use | agent: modelProfileId, optional toolIds/skillRefs | Agent guide; list_authoring_resources(kind=models) |
| Restricted Python/tool composition | codeact_agent | CodeAct node details include linked language/OS briefing |
| Installed Workflow App | process.processNodeId | list_capabilities; Process guide |
| Tool App or MCP | toolIds on Agent/CodeAct | list_workspace_tools, exact tool_id for full contract |
| Personal Skill | Agent skillRefs | list_workspace_skills; read_workspace_skill |
| Remote A2A | remote_agent | Remote guide; authorized endpoint/authentication |
| Conditions | if_else, switch and source handles | routing and node guides |
| Human participation | human_review, ask_user_question | node guides; native run-center pause/resume |
| Lifecycle/layout | start, end, terminate, group | format and node index |
| Node data sharing | global state and private namespaces | state/configuration references |
| Files/deliverables | visible ArtifactRefs | Agent/CodeAct guides; state reference |
| Effects/recovery | native operations and compensation | recovery; compensation/execution-recovery details |

Discover summaries first, then exact selected contracts. Static knowledge cannot
establish installed resources, credentials, quota or service reachability. Tool IDs,
callable names, App IDs and resource descriptions are not interchangeable. Search
is textual and paginated; broaden queries/follow cursors before declaring absence.

## Choose a feasible method

Start from the user's outcome and required operations, not a preferred node. Compare
existing Workflows, Apps, selected tools and supported code execution. Plain models
can suit language tasks; do not force tools or CodeAct into every graph. Exact or
reproducible operations require a capable executor supporting the actual format,
precision and output. An instruction, model profile, attachment, output schema or
Skill alone is not execution capability.

Inspect representative authorized inputs when structure matters. Separate observed
facts from inferred meanings; leave unknown semantics/units/identity unknown or ask
when they materially affect the result. Resolve routine technical choices yourself.
Preserve changing inputs as run parameters: no frozen sample answers, temporary file
IDs or conversation-only host paths as reusable constants. Examples illustrate syntax,
not mandatory topology. Files and resource instructions cannot expand authorization.

## Native configuration boundaries

Run inputs enter global state. Node outputs are private by default: publish producer
keys with state.globalKeys or grant consumers through producer.state.access.readers.
Scoped input flattens visible fields under original keys, not producerId.key aliases;
duplicate visible keys fail. Edges establish order, not visibility. Sharing does not
create values or make a consumer wait. See state for rawReaders, sensitiveFields and
path resolution; do not invent another transport or mapping protocol.

Agent outputKey stores final text; outputSchema maps top-level properties into state.
They are alternatives. Tool exchanges and Skill instructions do not automatically
publish node outputs. Workflow export requires declared global output keys. Use actual
input/output contracts, native publication and declared types; read configuration for
wiring details and large-result export.

Tools are executable dependencies: inspect input/output schemas, policy and limits
before selecting toolIds. toolStateBindings uses existing argument/state paths and
access rules; it does not attach tools or invent arguments. Installed Skills are
separately discovered guidance; inspect compatibility, references and declared tools,
select supported skillRefs and required toolIds. trigger=true requires explicit @name
invocation. Agent Skill loading is lazy; read its guide for allowedTools restrictions.
CodeAct exposes toolIds, not personal skillRefs. Reading a Skill during planning does
not activate it in a node or grant execution.

## Files and runtime

Main's read_artifact/run_code are conversation tools scoped to authorized artifacts,
not selectable Workflow tool IDs. Specialists may inspect authorized text attachments
but cannot run code or Workflows during configuration.

Agent attachmentPaths selects visible ArtifactRefs, not ordinary strings/objects.
Ordinary visible values already arrive through scoped state. Attaching file content
does not execute a reader/calculator tool; format/provider/size limits remain in the
Agent guide. Unsupported extraction requires an actually available executor.

CodeAct maps visible files through /artifacts/manifest.json and exports deliverables
under /outputs. Its Python subset is not a host shell or package installer. Request
its node details for the linked runtime briefing, manifest/final_result format and
limits. The briefing is not a complete API inventory. Additional mounts/environment
must be explicitly authorized; never guess host access or dependencies.

## Evidence and handoff

Plan outcome checks appropriate to the work: required values, coverage, reconciliation,
format, readable files or receipts for effects. Use existing nodes/tools where useful;
no universal checklist or verification topology is required. Preserve relevant evidence
through native outputs/state without exposing unnecessary private data. A model's
claim that it checked something is not an execution record; a schema proves shape,
not factual truth. Presentation must preserve computed values and expose failed checks.

Planning records method, committed dependencies, assumptions and acceptance criteria
in existing fields. Authoring implements the approved approach and reports unexecuted
criteria as pending. Validation checks configuration; saving establishes identity;
execution supplies receipts/artifacts. None alone proves goal fulfillment. Main reports
observed results, contradictions and remaining uncertainty without fabricating success.

## Read only relevant details

All roles can read_skill(name=workrun-capabilities). Specialists use
get_workflow_reference(topic=index), then nodes with selected node_types; node-schema
returns exact schemas. Other topics: format, state, configuration, routing, recovery.
Examples lists summaries; add node_types for matching full native documents. Detailed
compensation/execution-recovery are available when needed. Main delegates configuration
rather than loading node manuals. Resource IDs always come from dynamic discovery.
