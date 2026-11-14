---
title: Architecture and deployment boundaries
description: How the desktop runtime, team server, LiteLLM gateway, and Langfuse fit together.
---

Workrun executes workflows on the desktop. Team mode adds authentication, shared releases, and optional model access through a server. Trace export is a separate, opt-in path.

```text
Desktop (React UI → Tauri commands → Rust runtime)
  ├─ local SQLite: workflows, revisions, conversations, schedules, runs, checkpoints
  ├─ local files: Python App projects, environments, artifacts
  ├─ selected local Provider connection ──────────────────────────→ Provider
  ├─ Workrun session ─→ Workrun Server ─→ LiteLLM Team Virtual Key ─→ Provider
  │                          └─ MongoDB: accounts, shared releases, file resources
  └─ optional OTLP/gRPC ─→ OTel Collector ─→ Langfuse web/worker
                                                └─ PostgreSQL, ClickHouse,
                                                   Redis, object storage
```

Server, LiteLLM, and Langfuse can be deployed independently or replaced with existing services; a combined Compose project, shared network, or launcher is not required.

## Desktop owns orchestration and execution

The React interface submits commands and receives native events. The Rust host owns the durable state and permission checks; model messages alone cannot approve a plan, save an unapproved change, or authorize execution.

The homepage uses a small router to choose a conversation, task, or workflow path. Ordinary tasks can use available tools or a matching saved workflow. Workflow authoring follows these boundaries:

1. The planner searches capabilities, reads plausible exact contracts, and either identifies a reusable workflow or saves a proposal.
2. Plan approval authorizes the workflow author to validate and save the agreed definition. Saving does not run or publish it.
3. A separate execution request and any required confirmation permit the native run manager to launch the saved definition.
4. Repair requests inspect stored run diagnostics and the current definition before proposing an update to the intended workflow.

The run manager compiles the graph, streams node/model/tool events, records outcomes, and maintains checkpoints and interaction requests. Process Apps run in local Python environments; MCP tools and Remote Agents use their configured connections. These resources are not moved into the Server container.

The Scheduled Tasks page has an independent scheduling agent. It discovers existing targets and previews timing changes; a native confirmation commits the schedule. It cannot create workflows or launch an immediate run. Scheduling remains on the desktop, which must be running and able to access the target and credentials. See [Scheduled runs](/guides/scheduled-runs/).

## Local definitions and shared releases

Local storage is isolated by workspace; Team storage also distinguishes the server and signed-in account. A Personal workflow does not automatically appear in a Team workspace, and changing accounts does not expose the previous account's local drafts or history.

| Entry point                             | Definition selected in Team mode                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------- |
| Homepage capability discovery and reuse | Current account's saved local workflows, then accessible team releases and local Apps  |
| Homepage exact read and execution       | Latest local definition when the ID exists locally; otherwise the team release         |
| Team scheduling                         | Published definition, following the recipe's latest-published or pinned-release policy |
| Another member using a shared workflow  | Published release, with pinned Team App dependencies                                   |

A saved local workflow can therefore be reused without publishing. Unsaved editor changes are not saved capability definitions. When a local ID also has a published release, homepage discovery deduplicates it and reads the local definition. Local deletion after discovery causes that lookup to fail rather than silently executing an older release. Publishing is the explicit step that shares a version with other members.

## Server is the collaboration and model access service

The NestJS Server uses MongoDB for accounts, Workflow/App records, releases, and file resources (including GridFS-backed resources). Better Auth validates desktop sessions. Workflows, checkpoints, run histories, local artifacts, and schedules remain on the executing device.

With LiteLLM enabled, the desktop obtains its model catalog from `GET /api/v1/llm/models`. Inference uses `POST /api/v1/llm/chat/completions` or `POST /api/v1/llm/responses`. The Server verifies the session and model visibility, supplies its Team Virtual Key, and generates user attribution. Provider credentials remain in LiteLLM; the desktop receives neither the Team Key nor the master key.

When the gateway integration is enabled, one Server installation currently maps to one LiteLLM Team. Valid signed-in users share that Team's model access; there is no additional Workrun organization membership or member-specific model policy. Team mode also permits explicitly selected local Provider connections. Gateway failure does not automatically switch a request to a local Provider.

Responses is stateless: the desktop replays history, and the Server forces `store: false`. Hosted conversations, previous response IDs, and background Responses are not exposed. See [Model access](/getting-started/model-profiles/).

## Langfuse observes the desktop runtime

The optional exporter sends desktop conversation, workflow, node, generation, and tool observations over OTLP/gRPC. The Collector adds Langfuse project authentication and forwards traces over OTLP/HTTP; metrics are discarded by the supplied Collector configuration. No Langfuse AI Gateway or LiteLLM Langfuse callback is required for this path.

Exported metadata can include workspace/account identity and session/run/node/call IDs. Input/output content capture is off by default and is controlled separately in **Settings → Logs**. Local run history remains the source for recovery; exported traces do not restore checkpoints or artifacts. The current integration does not instrument the NestJS Server as a separate distributed-trace service.

See [Runs and traces](/quality/runs-and-traces/) and [Deploy Server, LiteLLM, and Langfuse](/team/deployment/).

## Source map

| Responsibility                                | Repository path                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Desktop UI and service adapters               | `apps/desktop/src`                                                                              |
| Conversation/task/planning/authoring runtimes | `apps/desktop/src-tauri/src/module/assistant`                                                   |
| Durable workflow revisions                    | `apps/desktop/src-tauri/src/feat/workflow`                                                      |
| Run manager, graph execution, scheduling      | `apps/desktop/src-tauri/src/module/{run_manager,workflow,schedule,schedule_agent}`              |
| Team model transport and identity             | `apps/desktop/src-tauri/src/module/team_model.rs`                                               |
| OTLP exporter and Langfuse observations       | `apps/desktop/src-tauri/src/core/telemetry*.rs`                                                 |
| Authentication, releases, model proxy         | `apps/server/src`                                                                               |
| Independent Compose deployment examples       | `apps/server/docker-compose.yaml`, `infra/litellm`, and `infra/langfuse` (independent examples) |
