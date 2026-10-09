# Current product policy

Workflow failure automatically cleans successful Process App node/tool calls with a saved App entry. Stop only cancels unfinished Remote tasks; Remote cancellation is one best-effort CancelTask. Failed/stopped tasks require a new run. There are no user-facing abandon, compensation retry, or compensation approval commands. Unknown execution outcomes retain the internal reconciliation API; there is no separate execution-history/reconciliation panel. Only application-interrupted tasks can continue.

The generic Saga design below documents legacy/internal machinery and its tests, not currently exposed product actions. Database records and internal recovery remain for compatibility with existing tasks. The automatic App cleanup section describes the active path.

# Saga: contracts, durable abandonment and compensation scheduling

Production workflow tasks can explicitly be abandoned and compensated from Run
Workspace. Failure, timeout and Stop alone are not abandonment. Execution status
remains independent of compensation status. Compensation runs locally while the
application is open, pauses on exit, and resumes persisted work at startup.

## Declarations

Process and Remote nodes accept `data.compensation`. Agent business tools accept
`data.toolCompensations`, keyed by selected tool ID, including skill-authorized
tools. Declaring compensation for the Agent as a whole is rejected: the tool
boundary owns its effects. CodeAct is not covered. Subworkflow containers default
to `delegated` and cannot declare a second compensation for descendant effects.

Available modes:

- `unspecified`: no compensation promise; the default for existing executors.
- `read_only`: author asserts the operation has no business effects.
- `irreversible`: requires a reason; reversal is not promised.
- `compensatable`: requires a target, original-record bindings and an explicit
  external idempotency contract.
- `delegated`: subworkflow container only; descendants own their compensation.

Example declaration for a Remote publish node (the same contract can be attached
to an Agent tool entry or a Process node):

```json
{
  "compensation": {
    "mode": "compensatable",
    "action": {
      "kind": "remote_agent",
      "url": "https://publisher.example/undo-agent",
      "authentication": { "type": "bearer", "credentialId": "publisher" }
    },
    "bindings": {
      "publicationId": { "from": "output", "pointer": "/publicationId" },
      "tenant": { "from": "input", "pointer": "/tenant" }
    },
    "idempotency": {
      "keyArgument": "requestId",
      "contract": "The undo service deduplicates business effects by requestId"
    }
  }
}
```

The pointer must match the actual saved adapter output. Remote output currently
contains `response`, `artifacts`, `messages` and `remoteTaskId`; an arbitrary
`publicationId` is not extracted from response text automatically. A binding to
`/remoteTaskId`, for example, is usable only when that identity is durably known.
A2A CancelTask is not a generic reversal of a published business effect.

Other targets are `{"kind":"tool","toolId":"delete-upload"}` and
`{"kind":"process","processNodeId":"cleanup-app"}`. Process compensators must
be Workflow Apps. Tool and Process catalog definitions are resolved and captured
before the original effect. Remote targets capture URL and authentication
references; credentials are not embedded. Whole local projects, dependencies and
mutable external services are not frozen by these catalog snapshots.

Bindings use JSON pointers into the original input or normalized saved output,
or `{"from":"literal","value":...}`. They cannot access latest State. Tool
output is its raw returned value; Process/child output is the receipt's structured
`result`; Remote output is its original common result object. Input bindings are
checked before dispatch. Output bindings can remain unavailable until an outcome
is reconciled. The stable compensation intent UUID is injected into the declared
idempotency key argument, which cannot be overwritten by another binding.

The idempotency contract is an author declaration. A local UUID does not verify
that an external service deduplicates requests. Executors must enforce/check that
contract before automatic compensation retries are introduced.

## Durable boundary

The wired adapters prepare `workflow_compensation_intents` before marking
execution dispatched. The encrypted context contains declaration, original
input, execution snapshot and compensation target snapshot. The operation's
required-intent flag and intent creation commit together; a missing required
intent blocks dispatch. Low-level operation clients must call
`prepare_compensation` before dispatch when adding a new adapter.

Operation success and its encrypted compensation outcome commit in the same
SQLite transaction, including Remote adapter completion. Outcome normalization
preserves raw values and artifact references separately from display redaction.
Malformed artifact metadata is marked as unverified, without discarding the
external execution fact. Reuse does not overwrite the original compensation
context/outcome or duplicate intent/outcome events.

`workflow_compensation_events` records intent and outcome capture in order. The
compensation status starts at `not_requested` and is independent of execution
status. Run inspection exposes mode, status, provenance, outcome availability and
argument availability without exposing raw parameters or results. Argument
availability is not authorization to run a compensation executor.

Failed/unknown operations retain intent even without output. Argument preparation
currently requires a stopped, known successful original operation; incomplete
outcomes require reconciliation. This does not imply that failures had no effects.
The scheduler blocks the entire plan while those effects remain unresolved. Old dispatched operations first seen by this phase have
`after_dispatch` provenance and cannot pretend their intent existed before the
original effect. No intent is invented for historical operations until they are
encountered again.

## Abandonment and dispatch fencing

`workflow_abandonments` is durable authorization. It is inserted before local
Stop is requested. The same transaction revokes queued forward work and blocks
its recovery job. Continuing/resuming/recovering the original task checks this
record transactionally; the common operation gate also checks it before every
external dispatch. Once abandoned, the original task cannot continue, including
after compensation has completed. Run again creates a fresh business execution.

A running native owner is stopped through its existing cancellation token. The
worker repeats Stop if the application exited between authorization and Stop,
and waits for the root execution/operation to stop. Process cancellation remains
best effort; absent a durable result or a business reconciliation contract, that
operation is unknown and blocks compensation. Cancelling a Remote task is not
proof that it produced no effects. Late success must be collected first.

## Dependency scheduling

New forward leaf operations persist conservative happens-before edges in their
creation transaction: every already successful, dispatched leaf of the same
execution is a predecessor. This captures serial tool calls, loop iterations,
child leaves and joins. Concurrent leaves that have not finished do not acquire
an edge to each other. The model may serialize independent work that happened
to complete before a later call; it does not infer independence from timestamps.

Subworkflow containers are excluded from effect ordering and cannot execute a
second parent compensation. The worker checks their captured child DSL and all
tracked descendant leaves, including incomplete child invocations, before
starting reversal. It currently runs one compensation at a time per task, in
reverse dependency order. A failed successor blocks its predecessors.

New tasks carry a backend-owned `compensationJournalVersion` marker. Already
started legacy tasks without complete journal coverage are blocked even when
there are no operation rows: absence of old logs is not proof of no effects.
Historical dispatched operations have `dependencies_recorded=0`; the migration
does not invent a safe ordering for them. They require manual remediation. The
worker also blocks if any dispatched effect has an unknown outcome, lacks a
before-dispatch compensatable/read-only contract, is irreversible, or belongs to
a CodeAct workflow. This conservative global gate can prevent compensating an
otherwise independent branch; partial remediation/waivers are not implemented.

## Executors and retries

Compensation has its own common operation with purpose `compensation`, execution
identity `compensation:<runId>` and the stable intent ID as its path. Arguments
come only from encrypted original records. It uses the same Attempt history,
pre-dispatch marker and durable result reuse as execution, without creating a
new user task or feeding results into the original workflow State.

- Process targets execute their saved Workflow App catalog definition.
- Tool targets execute the saved Tool App definition or an MCP tool whose saved
  contract and server routing/runtime configuration still match. Credentials
  can refresh independently. Tools requiring `ask_every_time` persist a separate
  approval bound to the compensation operation and frozen arguments. The internal legacy executor stores redacted arguments; approval is consumed atomically at
  dispatch. This approval path is not exposed by the current UI or Tauri API. Preflight retries preserve an unused grant. Denial keeps this
  operation blocked; Retry cannot silently override it. Automatic tools can run.
- Remote targets reuse the existing A2A discovery/submit/GetTask transport. A
  timeout with a saved task ID reconciles that same task; no task ID means
  unknown and resubmission is disabled. Original Remote operations are queried
  before reversal; completed results and compensation provenance are saved
  together without resuming the forward workflow. Still-working original tasks
  remain pending and are polled; terminal failure/cancellation without a full
  result remains blocked because partial effects are possible.

A committed compensation result precedes the intent's `succeeded` update. A
crash in between reuses that result. Startup reopens running plan/intent claims;
it does not reinterpret a dispatched operation without a receipt as unexecuted.
Compensation operations are excluded from forward Remote cancellation.

The Retry compensation action reopens a blocked plan and failed items, keeping
identities and attempts. A pre-dispatch failure can submit safely. Unknown
Process/tool outcomes cannot blindly retry; unknown Remote outcomes query the
existing task. The external idempotency declaration alone is not used as proof
that resubmitting an unknown operation is safe. Automatic business resubmission
and bounded compensation retry policies remain future work.

## Remaining boundaries

- Partial remediation and irreversible waivers; a blocked whole plan cannot be
  acknowledged as manually handled.
- DSL editor declaration controls.
- Business-specific recovery of failed/unknown effects, and verification of
  external deduplication/reconciliation contracts.
- Immutable local code/dependency bundles and mutable-service version binding.
- Concurrent compensation execution, retry policy configuration, whole-graph
  fixture evaluation and background processing after application exit.

Tests cover pre-dispatch intent, encrypted original arguments, atomic outcome
commit, dispatch fencing, reverse serial/parallel ordering, failed-successor
blocking, stable compensation identity/attempts, restart after receipt-before-ack,
unknown/legacy coverage rejection, and same-task Remote timeout reconciliation.
Scheduler tests use isolated adapter fixtures. They do not exercise a live mixed
Process/upload/publish business workflow or real external undo services.

## Manual operation reconciliation

The internal reconciliation API can reconcile a dispatched failed/unknown leaf after execution and
compensation processing have stopped. A latest-attempt check rejects stale
submissions. The user must attest that related execution stopped and provide
provider/resource evidence. Workrun records this assertion encrypted; it does
not independently prove remote facts.

`completed` imports an adapter-compatible receipt (tool JSON; Process
`{exitCode:0,result:{...}}`; Remote `{response:"...",artifacts:[]}`), validates
artifact references, and commits success and original Saga outcome atomically
with the review. Compensation receipts remain encrypted. `no_effect` authorizes
a future submit of the same logical identity and excludes that original leaf
from reversal/dependency blocking. Historical attempts and Remote identities
remain archived. Fresh dispatch clears the no-effect flag; an unknown new
attempt again requires reconciliation. Compensation tools need a fresh approval
for another dispatch. Only application-interrupted forward execution has a Continue action;
a blocked abandoned plan is reopened for durable compensation scheduling.

Subworkflow containers cannot import success to hide descendant effects. Legacy
coverage gaps, missing compensation contracts and irreversible operations still
block the plan; per-operation review does not waive those constraints.

## Same-App Process compensation entry

App catalog `compensation: {entry}` declares a separate
relative Python entry in the same uv project. Normal execution keeps its entry,
input/output schemas and receipt channel. Workflow Process nodes and managed
Process tool calls freeze the App definition and inherit an `app_entry` action;
App entry configuration takes precedence for these calls. Each tool call owns an intent.

The entry receives original input, decoded original result, resource references,
original operation ID and stable compensation intent ID as JSON on stdin. It
returns `process.result` via `workrun_sdk.compensation.result`. Business schemas
are not applied to the compensation context or receipt. Cleanup never asks for execution-time approval, including Tool Apps.
The original business tool retains its normal approval policy. Operation logging, dispatch fencing, receipt reuse and
unknown-outcome handling remain common with other compensators.

The before-dispatch intent stores a digest of publishable source (including both
entries and uv.lock). Compensation checks the original project's digest before
dispatch and after environment preparation. Missing/changed source blocks undo;
this is detection, not an immutable source archive or automatic version restore.
The lockfile and both entries must be included in source. Generated outputs
should use artifact storage or ignored paths. Symlinked source is rejected.
External editable/path dependencies and concurrent file edits are not frozen.
No partial resource journal is added here; original failures still reconcile
before compensation. Standalone App runs outside a workflow remain outside Saga.

## Default automatic Process/App failure cleanup

New production workflow tasks carry `processCleanupVersion:1`. On final failure,
the finish path selects successful original same-App calls with a configured
entry, atomically activates their intents, and fences forward continuation.
Failed/unknown originals, unconfigured Apps, other executor kinds, evaluations,
normal completion and Stop do not trigger cleanup. This is best-effort cleanup
of successful App calls, not a claim of full workflow reversal. Failed App calls
own their try/except/finally cleanup. Manual whole-workflow Saga remains separate.

A failed task preserves its execution status and original error. The existing
local worker reverses selected dependencies, resumes durable claims after
restart, and reuses committed receipts. Failures are recorded while independent
branches continue; predecessors of unfinished cleanup remain fenced. No automatic
retry submits an unknown cleanup again. A successful process exit is sufficient
for cleanup; optional `process.result` can provide an object receipt.

`process.compensation` events and intent status changes commit together and are
rendered as messages on the original node invocation (or visible parent row for
child workflows). Automatic tasks do not display the approval/Saga action panel.
The App editor requires only a separate entry; legacy idempotency declarations
are accepted but are not required. Code fingerprints still protect against
changed source. Once cleanup has been activated, re-execution uses a new task.
A startup scan covers failure committed before cleanup was enqueued. Historical
pre-feature tasks are not retrospectively cleaned up.
