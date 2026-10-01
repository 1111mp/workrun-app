---
title: How Workrun works
description: See how Workrun organizes model reasoning, code, tools, and human decisions into automation that can run, resume, and be verified.
---

Workrun is a local-first workspace for AI automation. It is not only about asking a model another question: it turns a useful AI collaboration into a workflow a team can run again, inspect, and improve.

```text
Run input
   ↓
Workflow state ──→ Agents / Python Apps / MCP and Tool Apps / human decisions
   ↓                                      ↓
Final result ←──── explicit state publication, node events, and tool results
   ↓
Run history, checkpoints, traces, evaluations, and publishable versions
```

## What makes up a workflow

A workflow is a saved canvas definition. Nodes decide who performs work, edges decide what runs next, and **More settings → Run inputs** defines the values that can be supplied for each run. A new workflow includes one non-editable `Start` node. It is the single fixed entry point, not where inputs are configured.

Before a run, Workrun validates graph structure and routing. For example, a workflow must have exactly one Start, Start must lead to an executable node, and branch edges must match their node's branch handles. The desktop app then compiles the canvas into an execution graph and initializes state from that run's input.

| Node | Responsibility |
| --- | --- |
| `Agent` | Handles reasoning tasks with its selected built-in model, instruction, and optional tools. |
| `CodeAct Agent` | Lets a model combine code and tools in a controlled Python execution environment, with limits for iterations, tool calls, duration, memory, mounts, and environment variables. |
| `Process` | Runs a local Python App for deterministic rules, data processing, and system integration. |
| `If/Else`, `Switch` | Chooses the next path from conditions in state. |
| `Human Review`, `Ask User Question` | Pauses for a person to review or choose an option before continuing. |
| `Subworkflow` | Calls a saved workflow, so complex flows can be composed from smaller units. |
| `Remote Agent` | Calls a remote Agent over A2A. |
| `Terminate`, `End` | Ends the current path; `Terminate` can end the whole workflow run. |
| `Group` | Organizes the canvas only; it never executes. |

## State is explicit, not hidden context

Every run has its own state. Input fields become its initial state. Data produced by a node stays in that node's namespace unless it is explicitly published as global state, and a node must be granted read access to the state it consumes.

These boundaries make a workflow reviewable: you can see what an Agent, App, or branch reads and produces instead of allowing every step to silently alter all context. Workflow inputs and outputs can declare field schemas; Agents can also use structured output or an output key to create stable data for later conditions and nodes.

```text
Run input → state
              ├─ Agent: reads granted fields and produces a result
              ├─ Process: transforms state and returns structured updates
              └─ Condition: reads published fields and selects a path
```

Read more in [Workflows and state](/concepts/workflows-and-state/).

## Give reasoning, code, and tools the right job

Workrun does not require every task to live in a prompt. Its execution types intentionally have different boundaries:

- **Agent** is for summarization, classification, planning, extraction, explanation, and other semantic judgment. It uses the node instruction, selected model, authorized state, and optional tools.
- **Process App** is for predictable Python logic, file or data processing, and systems integration. Each App is an editable local `uv` project with its own `pyproject.toml`, lockfile, virtual environment, and entry point.
- **Tool App and MCP tools** let an Agent query, calculate, or take actions through a schema. A Tool App is a local Python tool. MCP can connect to local `stdio` or remote Streamable HTTP servers, with no authentication, Bearer tokens, or OAuth.
- **Skill** provides progressively loaded task guidance and a restricted set of tools, rather than exposing every instruction and tool to a model at once.
- **Human nodes** are for high-stakes decisions, confirmations, or information a model cannot complete on its own.

Local Python Apps are not sandboxes. Run only projects you trust, and review them for the permissions they actually have. See [Apps, tools, and MCP](/concepts/apps-tools-and-mcp/).

## Run, pause, and resume

Workrun treats each execution as an identified run, not an untraceable chat request. While it runs, the interface streams node start, completion, failure, and waiting events. The run panel also exposes Agent model messages, tool calls, Python logs, and key outputs.

When a flow reaches Human Review or Ask User Question, Workrun stores a checkpoint in local SQLite and waits. After a reviewer submits a result or a user chooses an option, it resumes at the pause point without running completed steps again. Failed background runs can also retry from a checkpoint. At present, retry requires a checkpoint with one pending node, so a failure at a parallel fan-out should be investigated in run history first.

Task workflows suit independent, one-off runs. Chat workflows keep a durable session and its turns so later messages can continue the same context.

## Security boundaries and observability

Credentials are encrypted locally. Workflow inputs and node outputs can be marked sensitive: raw state is encrypted in checkpoints, while the default views sent to models, tools, and the interface are redacted. Workrun also applies input, output, and tool-argument guardrails for common PII and secret patterns, reducing the risk of sensitive values reaching tool calls or run evidence.

Each run retains a workflow snapshot, final state, and key events. Use the run panel to locate the node where a problem occurred. For external observability, configure an OTLP/gRPC collector to export diagnostic traces. See [Runs, debugging, and traces](/quality/runs-and-traces/).

## From experiment to a deliverable capability

Workrun separates “it ran” from “it is ready to release”:

1. Build and run a workflow with real inputs.
2. Inspect results, tool calls, and errors in run history.
3. Create an evaluation suite for an Agent workflow, using assertions and tool fixtures for regression checks.
4. Publish a version in a team workspace, optionally guarded by quality gates.

Evaluation execution currently targets workflows containing Agent nodes only. Workflows with Process, CodeAct Agent, Remote Agent, human nodes, or subworkflows should be verified through normal runs and run history. Team publishing pins referenced Team App versions, linking later runs and historical results to the version that was used.

Workrun's core value is therefore not replacing the model or the code. It gives them explicit orchestration, state, security, recovery, and verification mechanisms.
