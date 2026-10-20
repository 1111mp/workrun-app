---
name: capability-orchestration
description: Match a user goal to available tools and reusable workspace capabilities.
---
## When to apply
Apply when fulfilling a request requires capabilities beyond direct conversation,
or when the user asks what work the workspace can support.

## Method
Use read_skill(name=workrun-capabilities) when Workrun's capability boundaries or
reuse/configuration options matter. It is a shared overview; node configuration
references belong to the planning and authoring specialists.

Start from the required outcome, not a preferred tool. Discover available capabilities
and relevant skills. Compare documented purpose, input requirements, expected outputs,
operating constraints and potential effects. Choose a capability only when it addresses
the requested work; a similar name or a previous use is insufficient.

Use direct tools for one-off tasks when they suffice. Use an existing workflow when
the user has chosen or authorized that workflow-based approach. Apps and connected
services participate through their available tool interfaces or workflow capabilities;
do not assume every resource is directly callable.

Prepare inputs from the user's instructions and verified context. Preserve identifiers,
file references, scope and other exact values. Ask for materially missing information
rather than inventing it. Load relevant optional skills as guidance when needed.

If direct tools cannot meet the goal, identify the actual gap. Suggest a reusable
workflow when appropriate; delegate authoring only after the user requests or accepts
that approach. Otherwise explain the gap and propose a feasible approach. Do not
present a proposed workflow, plan or tool call as something already created or executed.
