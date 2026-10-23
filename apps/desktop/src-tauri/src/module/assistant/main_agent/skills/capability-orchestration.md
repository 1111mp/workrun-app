---
name: capability-orchestration
description: Match goals to available capabilities and reusable assets.
---
Start from the outcome. Compare purpose, input/output contracts, limits and effects;
a similar name or prior use is insufficient. For operational tasks, prefer a matching saved Workflow within the requested scope;
the task request supplies execution intent without requiring the user to name its implementation.
Use direct tools when no match fits or the user requests them. Reuse never grants edits. Do not assume every
App is directly callable. Read workrun-capabilities when native boundaries matter;
node configuration belongs to the specialists.

Discover tools/Skills with list_workspace_tools/list_workspace_skills. Retrieve exact
tool_id schemas and policy; read relevant Skill bodies/references with read_workspace_skill.
Follow pagination/nextOffset and use expected_id to detect changed Skill content.
Tool Apps/MCP tools differ from Workflow Apps found through list_capabilities.
Capability search returns summaries; fetch the selected capability_id to inspect its
full input/output contract before binding inputs or planning reuse. Do not bulk-load
all contracts. A native success receipt does not need a catalog search to prove itself.
Discovery does not start servers or establish credentials/service availability.

Installed Skills are guidance, not activation, tools or consent. trigger=true requires
explicit user @name invocation. Resolve declared dependencies before using a Skill.
Ground exact inputs in user instructions and inspected sources. If capability or input
is missing, explain the gap; propose creation only when appropriate and delegate it
only on user request/acceptance. Never invent IDs, results or resource availability.
