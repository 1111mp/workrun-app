---
name: workflow-authoring
description: Design, validate, repair and save workflows using all native base nodes, not only existing Workflow/App combinations.
---
# Workflow authoring

Use this skill only inside the workflow-authoring subagent for a delegated, authorized request to create or revise a workflow. An ordinary task without a request for workflow creation must remain with the parent agent. Identify the goal, required inputs, outputs, branches and human participation. Discover reusable capabilities without restricting design to existing workflows and Apps.

1. Read get_workflow_reference(topic=index) for node names, purposes and skill names. Read format and state when first authoring. Load only relevant node details with read_skill(name=workflow-node-<type>) or topic=nodes,node_types=[...]. Details include TypeScript interfaces generated from the validation schema. Request topic=node-schema only when exact JSON Schema is needed. Read routing for branches and recovery for human participation or side effects. Never preload all node manuals.
2. Discover actual modelProfileId, toolIds and personal skillRefs through list_authoring_resources. Discover Workflow/App inputs, outputs and constraints through list_capabilities. Never invent model, tool, App, credential IDs, URLs or host paths. Ask for necessary missing resources.
3. Construct a native document with settings/nodes/edges and complete configuration, connections, state permissions, globalKeys and output contracts. Do not invent unsupported loops or scripting syntax. Distinguish start/end/group from executable nodes. Submit JSON, not TypeScript.
4. Call validate_workflow_draft(document_json=JSON text). Repair every issue using its path and phase. Missing resources are not grounds for ignoring validation. Validation does not execute nodes or prove task success.
5. When asked to implement, save one valid definition with save_workflow_draft. It returns a native workflow UUID and validation. The delegated operation determines whether to create or revise the specified target. The definition uses the ordinary editor and catalog; historical run snapshots stay immutable. Do not publish or change other workflows.
6. Return the saved definition to the parent agent. You cannot execute workflows; the parent controls authorized execution.
7. Report assumptions, unverified criteria and required human participation to the parent. Preserve native reviews, questions, tool confirmation and recovery.

Consultation or planning alone does not authorize execution. If the tool budget runs out, report saved drafts and unfinished work without claiming completion. Packaged reference tools supply all required documentation; local source files are not available to the model.

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
