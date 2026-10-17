---
name: capability-orchestration
description: Match a user goal to available tools and reusable workspace capabilities.
---
## When to apply
Apply when fulfilling a request requires capabilities beyond direct conversation,
or when the user asks what work the workspace can support.

## Method
Start from the required outcome, not a preferred tool. Discover available capabilities
and relevant skills. Compare documented purpose, input requirements, expected outputs,
operating constraints and potential effects. Choose a capability only when it addresses
the requested work; a similar name or a previous use is insufficient.

Prefer a suitable existing workflow for executable work it already encapsulates. Treat
its invocation as a tool call with an explicit input/output contract. Apps and connected
services participate through their available tool interfaces or workflow capabilities;
do not assume every resource is directly callable.

Prepare inputs from the user's instructions and verified context. Preserve identifiers,
file references, scope and other exact values. Ask for materially missing information
rather than inventing it. Load relevant optional skills as guidance when needed.

If no capability covers the goal, determine whether available tools support composing
or creating the required capability. Use those tools only within their actual contracts
and the user's scope. Otherwise explain the gap and propose a feasible approach. Do not
present a proposed workflow, plan or tool call as something already created or executed.
