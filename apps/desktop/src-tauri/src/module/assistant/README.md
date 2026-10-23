# Conversational assistant, workflow planner and workflow author

Users describe outcomes in ordinary language. Operational tasks search bounded capability
summaries and reuse a matching saved workflow, or use direct capabilities when none fits.
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
contract. For revisions, native code reads the confirmed target once and supplies its
current definition to the author, preserving identity without another model round trip.
The preferred conversation model profile is supplied to both. Completion
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
after saving succeeded and the user confirmed execution. Reruns resolve the latest saved definition, including editor
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
Task requests can authorize a matching existing workflow within their scope, never
creation or edits. Saved-workflow amendments use authoring/planning with the exact
`document.target_id`; new input data alone uses a new run of the existing ID.
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

## User documentation

The official guide is maintained in English and Simplified Chinese:

- [Build workflows through conversation](../../../../../docs/src/content/docs/guides/conversational-workflows.md)
- [通过对话编排工作流](../../../../../docs/src/content/docs/zh-cn/guides/conversational-workflows.md)

Keep user-facing instructions aligned with the native plan, execution and tool
confirmation gates.

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
Once the current version is approved for this turn, native routing transfers to
the author through the same SDK checks and journal without a coordinator model
call merely to choose that specialist. Planning and execution routing remain separate.
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

### Local evaluation and cost scope

The opt-in `evaluation::live_assistant_evaluation_baseline` uses
`run_with_discovery` with an isolated fixture catalog, including summary search,
native fallback and exact contract lookup. It returns execution proposals and
feeds synthetic success/failure receipts back through the runtime; it does not
execute business workflows. Ordinary one-off requests expect `task`; explicitly
requested workflow runs and retries remain `execution`.

Version 2 reports identify `runtimePath: native_discovery`. Each case retains every
attempted model call, final cumulative usage snapshot, failure status and missing
usage count. `cost.phases` separates intent, coordinator conversation, planning,
authoring (creation/revision) and receipt-continuation delivery. Specialist return
narration remains coordinator conversation. `knownTokens` includes only reported
usage; `usageComplete: false` means it is not the complete cost. Execution model
usage is excluded explicitly (`executionIncluded: false`), never inferred as zero.
Do not compare version 1 legacy-route totals directly with version 2 totals.

Local scripted checks verify discovery/contract binding and terminal delivery
without redispatch. Existing temporary-workspace lifecycle checks also assert
phase accounting for reuse planning, creation/repair and same-ID revision. These
checks validate mechanics, not semantic model quality or actual token savings.
External model runs remain opt-in and require the applicable external-call scope.

`evaluation::local_cross_task_prompt_comparison` is an opt-in offline check over
all baseline cases. Set `WORKRUN_ASSISTANT_BASELINE_DIR` to a prompt snapshot and
optionally `WORKRUN_ASSISTANT_BUDGET_OUTPUT` to a temporary report path. It replaces
only the intent, main-agent and capability-orchestration instruction texts while
asserting unchanged history, tools and model configuration. Reports retain resource
fingerprints and label the scope as prompt text only. They measure serialized
character counts, excluding other changed resources and historical routing behavior;
they neither count provider tokens nor establish end-to-end savings.

Missing-input evaluation requires a user-facing clarification without an execution
proposal; empty arrays and missing placeholders do not count as correct routing.
The opt-in `lifecycle_tests::live_native_save_cost_comparison` covers confirmed
creation/revision in temporary directories. `WORKRUN_ASSISTANT_SAVE_CASE` can select
`confirmed-create` or `confirmed-edit`; `WORKRUN_ASSISTANT_SAVE_REPORT` is required.
It never executes the saved graphs. Reports retain full saved settings for
inspection when strict settings equality fails (descriptions can contain changed
business rules). A settings mismatch needs review, not automatic attribution to
workflow identity or behavioral loss.

Required inputs bound from user messages cannot use empty placeholders based on a
generic task quote. Empty strings/whitespace, collections, objects and null require
an exact typed JSON literal in that evidence quote. This provenance check does not
change schemas or impose nonempty constraints on optional fields. Declared defaults
and validated native result bindings retain their original semantics; numeric zero
and boolean false are values. A rejected proposal returns the input key and a
clarification hint without dispatching a workflow. This deterministic boundary does
not prove semantic equivalence of arbitrary nonempty values or guarantee fewer
model discovery rounds; those still need live multi-task measurement.

Native missing-input errors aggregate absent/ungrounded required fields in one
`InputIssue`. Once diagnosed, the coordinator stops advertising capability discovery
for that invocation; direct reads and corrected execution bindings remain available.
A scoped `input_clarification` operation records only the selected identity, field
names, goal and original user-message count. A successful correction in the same
invocation marks that record resolved. This is historical audit evidence, not an
independent pending task or execution grant.

On the immediately following actionable user turn, the coordinator may reuse that
record as a candidate hint. It fetches the exact current contract again; deleted
capabilities produce no hint. Discovery remains available on the new turn, so goal
changes can select another target. Status turns, old message counts and other
sessions do not inherit the hint. The mechanism adds no model call, query cache or
automatic execution. Scripted multi-type tests validate these boundaries, not real
model behavior or net token savings.

### Native pre-execution confirmation

Every assistant-selected workflow pauses after input validation and before native
preparation/dispatch. `awaiting_run_confirmation` persists the chosen definition,
inputs and an opaque confirmation ID, with historical card metadata stored outside
model conversation contents. Only `runDecision` for that active ID can approve or
cancel. Continue/reload and model output cannot approve it. Cancellation pairs the
original tool call with a cancelled receipt and returns idle without a model call.

Approval binds the resolved workflow snapshot and input digest. Before dispatch,
launch resolves and validates again; a changed snapshot requires a new confirmation
and marks the old card superseded. Missing inputs use the existing input form first,
then the same confirmation gate. Interrupted pre-dispatch approvals return to a new
review on explicit Continue. Existing persisted run IDs remain observation-only.
The renderer uses the Human Review card layout and retains confirmed/cancelled
history while disabling stale or in-flight controls.

The secondary execution-card action is selection feedback (`runDecision/reselect`),
not a silent cancellation. It closes the original signed proposal with a cancelled
receipt naming the rejected identity, marks its card rejected, and appends the
localized button feedback as a new user turn. The normal assistant loop then
reconsiders the earlier request or asks for clarification. The per-turn dispatch
budget resets for this explicit feedback; no approval is carried to another target.
Replacement proposals still stop at the native execution confirmation gate. Legacy
plain cancellation remains supported and returns idle without model continuation.
