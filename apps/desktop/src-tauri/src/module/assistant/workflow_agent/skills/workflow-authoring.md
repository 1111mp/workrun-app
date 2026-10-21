---
name: workflow-authoring
description: Configure, review, validate and save native Workflows from approved plans.
---
# Workflow authoring

Follow the authoring role boundaries; use workrun-capabilities for selection guidance.

1. Discover summaries with get_workflow_reference(topic=index). Read format/state
   and selected node behavior via topic=nodes,node_types=[...] or workflow-node-<type>
   Skills; CodeAct node details include runtime support. Read configuration, routing,
   recovery or compensation/execution-recovery only as relevant.
2. Resolve real models with list_authoring_resources; discover tools/Skills with
   list_workspace_tools/list_workspace_skills, then retrieve selected tool_id contracts
   and read_workspace_skill bodies/references. Use expected_id and pagination as
   needed; trigger=true requires explicit @name invocation. Discover Workflow/App
   contracts through list_capabilities. Reading a Skill does not attach its tools:
   configure actual dependencies, including toolIds/skillRefs where supported.
3. Build settings/nodes/edges using the same fields as the visual editor. Native
   global/namespace state is the data-sharing mechanism; use the state/configuration
   references for visibility and output publication. Do not invent mappings, node
   types, loops, scripting APIs or host access. Submit JSON, not TypeScript.
4. Compare the actual configuration with the approved processing rules: input
   selection/meaning, capable executor, produced outputs, downstream visibility and
   Workflow export. Executing code or calling a tool does not prove the intended
   rules were implemented. Use supported capabilities for exact work; preserve
   computed values through presentation. Keep useful check evidence/failures visible,
   without requiring a fixed output form or topology. Return substantive gaps for
   discussion rather than guessing. Sample answers are not reusable implementations.
5. Call validate_workflow_draft(document_json=JSON text) and repair every phase/path.
   Validation checks configuration/compilation, not execution or business correctness.
   Save one valid definition with save_workflow_draft; report its actual identity,
   assumptions and pending criteria. Respect the operation's creation/revision
   target. If interrupted or out of budget, report unfinished work without claiming
   success or creating duplicates. The parent alone handles authorized execution.
