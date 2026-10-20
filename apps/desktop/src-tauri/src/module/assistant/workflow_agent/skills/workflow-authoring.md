---
name: workflow-authoring
description: Design, validate, repair and save workflows using all native base nodes, not only existing Workflow/App combinations.
---
# Workflow authoring

Use this skill only inside the workflow-authoring subagent for a delegated, authorized request to create or revise a workflow. An ordinary task without a request for workflow creation must remain with the parent agent. Identify the goal, required inputs, outputs, branches and human participation. Discover reusable capabilities without restricting design to existing workflows and Apps.

Use read_skill(name=workrun-capabilities) or get_workflow_reference(topic=capabilities)
when you need the capability map. Read reference topic=configuration for resource
wiring and topic=examples for summaries; add relevant node_types for full native
configuration examples. Resolve discovery placeholders against actual contracts.
Configure the same native fields as the visual
editor; state sharing uses the existing global/namespace mechanisms described in
reference topic=state. The overview points to details; it does not prescribe a graph.

1. Read get_workflow_reference(topic=index) for node names, purposes and skill names. Read format and state when first authoring. Load only relevant node details with read_skill(name=workflow-node-<type>) or topic=nodes,node_types=[...]. Details include TypeScript interfaces generated from the validation schema. Request topic=node-schema only when exact JSON Schema is needed. Read routing for branches and recovery for human participation or side effects. Never preload all node manuals.
2. Discover actual modelProfileId through list_authoring_resources. Search toolIds and personal skillRefs through list_workspace_tools and list_workspace_skills; retrieve selected tool contracts by tool_id and read only needed Skill bodies/references with read_workspace_skill. Discover Workflow/App inputs, outputs and constraints through list_capabilities. Never invent model, tool, App, credential IDs, URLs or host paths. Ask for necessary missing resources.
3. Construct a native document with settings/nodes/edges and complete configuration, connections, state permissions, globalKeys and output contracts. Do not invent unsupported loops or scripting syntax. Distinguish start/end/group from executable nodes. Submit JSON, not TypeScript.
4. Call validate_workflow_draft(document_json=JSON text). Repair every issue using its path and phase. Missing resources are not grounds for ignoring validation. Validation does not execute nodes or prove task success.
5. When asked to implement, save one valid definition with save_workflow_draft. It returns a native workflow UUID and validation. The delegated operation determines whether to create or revise the specified target. The definition uses the ordinary editor and catalog; historical run snapshots stay immutable. Do not publish or change other workflows.
6. Return the saved definition to the parent agent. You cannot execute workflows; the parent controls authorized execution.
7. Report assumptions, unverified criteria and required human participation to the parent. Preserve native reviews, questions, tool confirmation and recovery.

Before step 4, review the actual draft against the approved task, not just its JSON
shape. Trace material operations through existing native fields: input availability,
selected executor and resource IDs, output production, allowed state access, checks
and final Workflow output export. Inspect those configurations rather than trusting
node labels or instructions. Native state remains the only data-sharing mechanism;
do not create a separate mapping document or require one node per plan step.

If exact processing is assigned only to an untooled model, or a needed parser/package
is unsupported, repair the method with available capabilities. If no authorized
implementation fits, return the specific gap. Specify relevant runtime checks and
how their failure becomes visible; do not call those checks passed before execution.
When explaining coverage, state which material operations the saved configuration
implements and which outcome criteria remain unverified. Preserve the approved scope.

Consultation or planning alone does not authorize execution. If the tool budget runs out, report saved drafts and unfinished work without claiming completion. Packaged reference tools supply all required documentation; local source files are not available to the model.

For exact operations, follow the shared overview's capability-selection guidance:
configure a suitable discovered executor or supported CodeAct environment, including
actual inputs and output/state contracts. Instructions alone do not execute an
operation. Keep changing run inputs configurable and preserve computed values when
passing them to language/reporting nodes. Implement relevant acceptance checks with
existing capabilities where useful; do not impose a fixed graph or claim that native
validation verified task results.

Before constructing nodes, derive a task contract from the user's request and
available input/resource schemas: intended outcome, operations, assumptions,
required outputs and verifiable acceptance criteria. Clarify ambiguous semantics.
Write task-specific logic and constraints into the generated node instructions
and supported output schemas, not into assumptions about built-in node behavior.
Use available base nodes/tools to implement checks when appropriate. Structural
validation checks configuration and compilation; it does not prove that the task
contract is semantically correct or that execution fulfilled the request.
Return the contract and any unverified criteria to the parent for comparison with
actual execution results. Changes require an authorized revision, not hidden rewriting.

Approved plan node_types are optional implementation suggestions. Choose the actual
node types and configuration using native capability contracts. Preserve committed
dependencies, intended behavior and material constraints; return substantive changes
for user feedback. A proposal does not need a complete graph before confirmation.
