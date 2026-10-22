# Conversational assistant, workflow planner and workflow author

Users describe outcomes in ordinary language. One-off work uses direct capabilities.
Reusable automation goes through a visible, revisable plan before configuration.
Business-specific rules belong in user task contracts and test fixtures, never in
shared instructions or Skills.

## Roles and SDK composition

`main_agent/` owns conversation, intent assessment, clarification, capability routing
and delivery. `planning_agent/` owns its English instructions, Skill, independent
read/proposal tool catalog and the versioned plan store. `workflow_agent/` owns its
English authoring Skill, progressive node references and graph validation/save tools.
The main agent cannot directly write a plan or graph. Neither specialist can execute
or approve its own work.

`orchestration.rs` registers the permitted specialist through ADK 2.3
`LlmAgentBuilder::sub_agent` and runs the tree with `Runner`. Before acceptance,
only workflow_planner is registered. A current-turn native plan approval enables
workflow_author. No AgentTool or custom subagent invocation loop is used.
`sdk.rs` transports role-bound native requests and returns specialist outcomes through
SDK transfer events. A parent can delegate once per user turn; specialists cannot
transfer to peers. SDK transfers must be isolated from sibling calls. Malformed mixed
transfers and unavailable specialist targets receive bounded no-action feedback with
the original call IDs/signatures preserved.

Each user turn starts at the coordinator with durable native conversation history.
Specialists use IncludeContents::None. The planner receives explicit task data, public
conversation text (without provider thinking), authorized artifact references and the
current plan. The author receives the frozen approved plan and its derived task
contract. The preferred conversation model profile is supplied to both. Completion
returns control to the parent, which discusses questions or presents actual results.

On completion the host resumes the coordinator from its pre-handoff contents plus
bounded native outcome facts. Specialist tool calls, reference documents and raw
workflow JSON remain in the operation journal, not in coordinator delivery prompts.
Subsequent coordinator tool exchanges keep their original IDs and signatures in that
scoped delivery history. Permission feedback applies only to a new forbidden
coordinator batch; an authorized specialist save is never rewritten as a denial.
A completed native save is sufficient evidence of draft persistence even when the
capability discovery snapshot predates that save.

Planning node references default to semantic summaries; `detail=full` remains
available for a material feasibility question. Authors read the full selected node
contracts once. Normal creation submits a document directly to save_workflow_draft,
which validates before writing; separate validation is reserved for review-only
requests. This keeps validation and approval gates intact without forcing duplicate
full-document generation.

## Planning and review

New/revised Workflow requests authorize planning first. A proposal describes the goal,
inputs, outputs, processing responsibilities, selected node families, dependencies,
configuration notes, constraints, assumptions, unresolved questions and verifiable
acceptance criteria. Users discuss or change these in ordinary language. The planning
specialist saves a new version after incorporating corrections; it does not create a
Workflow in the background.

`save_workflow_plan` is available only to the planner. `get_workflow_plan` reads the
current plan or an immutable proposal revision. Native storage is scoped to the
workspace and conversation UUID:

```
assistant/plans/<session UUID>/current.json
assistant/plans/<session UUID>/v1.json
assistant/plans/<session UUID>/v2.json
```

The current record tracks review/configuration state. Revision files preserve proposal
documents. Saves require the expected base version; another version cannot inherit
approval. Unknown nodes, malformed documents, unauthorized attachment IDs and oversized
plans are rejected. Dependency discovery checks the actual catalog. Unresolved questions
or unavailable dependencies produce needs_clarification and cannot be approved.
Availability checks do not prove service credentials, quota or runtime success.

The conversation preserves per-turn plan snapshots: goal, summary, inputs, expected outputs,
steps, assumptions and material questions. Node/resource choices, configuration notes,
constraints and acceptance criteria are expandable. Users can discuss revisions,
cancel, or confirm a ready version. The native decision action binds the conversation,
plan ID and exact version; it rechecks dependencies. It creates only, never runs.
An explicit natural-language acceptance can also bind the current ready version through
structured intent with exact current-user evidence. That interpretation remains fallible;
the native button provides a deterministic approval path. An explicit separate run
request may authorize the main agent to dispatch the newly saved definition after
creation. An initial create-and-run request still needs planning/review first.

Native state transitions are ready/needs_clarification → approved → building → saved
or failed. Cancelled/failed proposals can be revised. Revisions require new review.
Planning cannot approve itself in the same turn. A confirmed creation uses a native
approval bound to the user turn, bypassing another fallible intent assessment. Once
that phase produced a plan or configuration outcome, retrying delivery reads the
recorded result rather than delegating again. Interrupted configuration is surfaced
for inspection; it is not silently restarted. Plan mutations use the native session
lease. Renderer saves cannot authorize plans or manufacture native records.

## Configuration and execution boundaries

The author gets the approved goal, inputs, outputs, responsibilities, constraints,
assumptions, dependencies and acceptance criteria. Native save checks require selected
node families and dependencies to appear in the generated graph. The existing compiler
then validates graph structure/configuration. These checks are mechanical coverage,
not proof of semantic correctness or satisfaction of the task. Material departures
must return to discussion and a new plan version. Creation identity is stable for a
plan version; the native revision target cannot be replaced by model arguments.

Validated graphs are saved into the ordinary workspace catalog and use the normal
editor, node palette, save and run interactions. Saving is not publication or execution.
A creation-plus-execution grant can dispatch only its newly saved workflow, and only
after saving succeeded. Reruns resolve the latest saved definition, including editor
changes; they do not clone or regenerate it.

The native conversation owner holds credentials, workspace scope, dispatch identity,
run observation and receipts. It survives renderer disconnection and limits model
phases to 240 seconds. A receipt continuation does not grant new actions. The session
also records interpretation and effective grants, specialist progress and operation
outcomes under `assistant/operations`. Only public progress events are streamed from
specialists; their internal thinking is not included in the user answer.

`main_agent/intent.rs` distinguishes conversation, one-off task, planning, authoring,
execution, status, explanation and clarification. Confirmation schema fields are
contextual. Empty optional confirmation placeholders do not create authorization.
Missing resources and missing definitions are distinct from permission restrictions.
The parent must not present internal grant booleans as a user-facing permission error.

## Direct capabilities and resource discovery

`read_artifact` reads authorized UTF-8 attachments progressively. `run_code` performs
bounded Monty computation and can return native artifact references. It has no host
filesystem, network, package installation or arbitrary external tool access. Neither
creates a hidden workflow. Unsupported formats/modules require a real capability or
an explanation of the gap.

All roles can progressively discover workspace tool/Skill metadata. Search through
`list_workspace_tools` returns MCP/Tool App summaries; exact tool_id returns the public
schemas and policy. Discovery does not start stopped MCP servers. `list_workspace_skills`
returns metadata without bodies or filesystem paths; `read_workspace_skill` pages a
selected body or a declared contained local reference. Traversal, symlink escape,
binary/oversized references and stale content identity are rejected. Installed Skills
remain untrusted guidance and cannot grant tools, override roles or authorize effects.
Explicit-trigger Skills require explicit invocation. Built-in role Skills remain separate.

Only the main agent receives `call_workspace_tool` during eligible direct-work turns.
It reuses ProcessNodeRegistry and ADK MCP Tool implementations. Auto honors existing
policy; AskEveryTime saves an exact pending call without executing. Conversational
approval is session/tool/argument/catalog-configuration bound. Refusal closes it
without resolving an unavailable tool. Native durable claims and running markers precede
dispatch; identical phase calls reuse bounded redacted, schema-checked receipts.
Unknown/interrupted outcomes cannot be automatically retried through changed arguments.
These guards do not provide external-service exactly-once delivery. Tool confirmation
is separate from plan confirmation. Source credentials never become model arguments.

## Packaged resources

The three role directories contain their own instructions, Skills and tool catalogs.
The planner shares the read-only workflow reference service, not the author's Skill
catalog or write tools. Node details remain English progressive resources generated
from node contracts. Manuals live outside the executable in Tauri resources. Development
and release use the same generated layout; build.rs rejects missing/stale resources.

## Validation

```sh
pnpm --dir apps/desktop workflow:generate
pnpm --dir apps/desktop workflow:check
CARGO_INCREMENTAL=0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib module::assistant
pnpm --dir apps/desktop typecheck
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts --project unit src/stores/assistant.store.test.ts
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts --project component src/pages/start/assistant-workflow-plan.test.tsx src/pages/start/assistant-tool-confirmation.test.tsx
pnpm --dir apps/desktop exec vitest run --config vitest.config.ts --project browser src/pages/start/assistant-workflow-plan.browser.test.tsx src/pages/start/assistant.browser.test.tsx
```

Tests use temporary plans, artifacts, draft/checkpoint storage and scripted SDK models.
They cover planning/clarification/revision/approval/configuration, native and conversational
acceptance, stale versions, role isolation, selected dependency coverage, restart/delivery
recovery, direct tools and real rule-graph execution. UI tests cover decision packets,
disabled approval states, optional details, normal chat regressions and narrow layout.
They do not establish real-model planning quality, configured MCP/Tool App behavior,
production queues or business correctness. Those require separate end-to-end acceptance.
The existing optional live tests use configured credentials and remain opt-in.
Replaying real user history to an external model requires explicit permission.
The offline test suite does not execute actual user workflows.

## Durable feedback tasks

`task_runtime.rs` uses ADK 2.3 `StateGraph`, dynamic interrupts and
`SqliteCheckpointer` in `<workspace>/assistant/tasks.sqlite`. Each plan revision has
a separate thread `<session>/<plan>/vN` and an interaction ID bound to the frozen
version. The graph pauses in `review`; it owns no model request while waiting.
Questions and unrelated messages leave the task waiting. Natural language feedback
is interpreted into `planFeedback` with an exact current-user quote; explicit
button feedback bypasses model interpretation. Cancellation closes the gate.
Revising a proposal cancels the old thread and opens a new waiting thread.

The graph resumes after approval and stops at the native `create` effect boundary.
The existing SDK subagent tree performs the approved authoring operation; native
operation journals remain responsible for side-effect identity and reconciliation.
The host must check the creation checkpoint before handoff. A save/failure receipt
is fed back into the graph to finish the task. This checkpoints task stages, not
an arbitrary point inside an LLM token stream or a partially executed SDK session.
Uncertain authoring operations require inspection rather than automatic replay.

A conversation with a pending interaction has `awaiting_feedback` status and remains
editable. Continue/retry alone cannot approve it. Loading the conversation restores
the interaction from SQLite, and ordinary replies do not consume it. Duplicate
button feedback returns the existing state without appending another user turn.
The same checkpoint runtime also serves MCP/Tool App confirmation. Frozen tool
requests use `<session>/tools/<operation>` threads with an executing effect stage.
`tool_execution.rs` rechecks the current implementation/configuration, schema,
arguments, session and native operation claim before dispatch. Explicit UI feedback
queues a durable native directive; it never asks a model to regenerate arguments.
Results become native result messages without fabricated provider tool-call
signatures, so the summary phase grants no additional actions. Natural-language approval/refusal uses the existing exact-call
interpretation and the same checkpoint gate. Unknown outcomes remain uncertain;
neither graph recovery nor renderer reconnection resubmits a claimed operation.

Pending tool requests are exposed as `pendingTool` and anchored `toolConfirmations`
snapshots. The conversation enters `awaiting_feedback` for either a plan or tool
request and remains open to discussion. Other resource/input interactions have not
yet been migrated to this runtime.

## Review gates end the invocation

A successful `save_workflow_plan` ends the whole scoped Runner invocation in the
native host. Neither specialist completion nor coordinator narration is generated
after the checkpoint is created. `AssistantReply.pause` is a native control result,
not an assistant answer; `session.rs` persists waiting state without appending an
empty/model message. Delivery retries return the existing pause without any model
call. Tool confirmations use the same hard-stop boundary.

A run request for an unapproved proposal cannot authorize a planning revision.
Without separate explicit plan acceptance it returns a localized native status
notice, leaves the plan version/checkpoint intact, and starts no authoring/run.
node_types is optional implementation guidance. A proposal can reach review without
freezing node selection; authoring resolves routine configuration from native
contracts. Committed resource dependencies remain checked before approval and save.

Conversation grouping reserves a card-only assistant slot for every interaction
turn. Later user messages do not require an artificial assistant answer to keep
earlier cards in the timeline.

## Native capability knowledge

The optional `workrun-capabilities` Skill is shared by main, planning and authoring
roles. Its packaged source is `reference/workrun-capabilities.md`; specialists can
also read `get_workflow_reference(topic=capabilities)`. Node guides and schemas stay
progressive, and installed IDs/contracts come from native discovery. The overview
describes the existing editor/runtime configuration surface without prescribing a
graph or introducing a new authoring protocol.

See [CAPABILITY_AUDIT.md](CAPABILITY_AUDIT.md) for the maintainer capability inventory,
confirmed documentation corrections and remaining code-alignment questions.


### Context and discovery boundaries

Capability discovery lists return paginated summaries (ID, kind, name, bounded
description, version and native constraints); capability_id retrieves the original
full input/output contract. Main, planner and author use the same native catalog.
Search matching uses the full description before summarizing. Summary descriptions
are explicitly marked when truncated; they must not be used as binding contracts.
Legacy list_workflow remains compatible. No native validation/grant is derived
from model-visible summaries.

Specialist histories remain in native operation audit records, while main delivery
uses the pre-delegation parent snapshot and bounded native outcome. Durable main
conversation messages, rather than the SDK's shared specialist history, seed later
turns. User history and native receipts remain unchanged: indices, exact quotes,
approval digests and signed call/response pairs must not be silently compressed.
Large ordinary conversation history and execution receipts still warrant separate
measured optimization; this change does not introduce a generic lossy compressor.

### Native execution delivery views

At the common assistant model boundary, terminal execute_workflow and
execute_capability receipts use a smaller request-only view. Nonempty validated
output replaces the parallel internal state dump. Without a usable output contract,
recognized complete state retains global values and the final trace entry instead
of replaying every node and trace. Status, errors, output validation failures,
artifact references, IDs and signed call/response pairing are preserved. Unknown
shapes, clipped JSON and compact results stay unchanged when no safe smaller view
exists. This is deterministic projection, not model-generated summarization.

Durable session receipts, run records and original registry history are untouched;
message indices, approval digests and result-source binding still use original
native evidence. Explicit inspect_execution(run_id, detail=full) reads that run's
stored receipt from this session without dispatch. Default inspection uses delivery
views and excludes unrelated tool responses. Stored receipt details may already be
truncated by the pre-existing capture limit; this read does not reconstruct them.
An explicit full inspection remains visible to the model for that turn. The view
applies to both intent assessment and conversation generation, including later
turns and old compatible receipts. It does not rewrite workflow model requests,
external-tool output semantics, the usage ledger or execution authorization.

Regression checks use arbitrary contracts and state fixtures, not a sales workflow:
validated output, legacy outputs, failed/cancelled/interrupted runs, unknown/clipped
payloads, preserved protocol signatures, source immutability and scoped detail
inspection. Character reduction is not a measured token saving; compare actual
recorded task totals and outcome quality across multiple task types after rollout.

### Input-source indexing without duplicate message bodies

The coordinator's binding index contains original message positions, chronological
user ordinals and Unicode-safe previews of at most 80 characters. Complete user
messages remain in the conversation exactly once instead of being copied again
into the instruction. Previews explicitly indicate truncation and are navigation
only: exact quotes and typed values must come from original history. Native binding
resolution and approval digests still use unchanged complete messages. This is not
historical summarization or a sliding-window policy; no user constraints are dropped.
