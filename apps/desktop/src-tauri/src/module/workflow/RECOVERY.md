# Execution and recovery: Remote, tools, Process and child workflows

A workflow run is the user-visible business task. Continuing a failed or
interrupted task requeues its original run ID and checkpoint thread. `executionId`
and logical operation IDs stay stable. Replay creates a new run, thread and
business execution ID. Recovery uses the original DSL recipe and validates the
checkpoint's workflow fingerprint; it does not apply edits from the editor.

## Durable records

- `run_attempts` retains each task execution interval, outcome, error and output
  snapshot. Existing historical runs are backfilled. Resume after a user-input
  pause starts another interval in the same task.
- `run_events` remains append-only with a monotonically increasing cursor. A
  previous writer drains before failure is published and recovery can begin.
  Telemetry span IDs include the task-attempt sequence.
- `workflow_operations` owns stable logical identities and execution decisions.
  Paths include parent invocation, node ID, checkpointed ADK super-step and slot.
  Inputs and adapter configuration are hashed; changed inputs fail closed.
- `workflow_operation_attempts` distinguishes submit, reconcile and reuse. HTTP
  discovery/read retries are communication retries inside one operation attempt.
- `remote_tasks` retains encrypted A2A connection/task identities and protocol
  state. Adapter completion and the common reusable output commit together,
  before publishing Workrun State or the next graph checkpoint.
- `workflow_tool_inputs` stores encrypted resolved tool inputs, linked to the
  common operation. Tool results are encrypted envelopes in the common journal.
- `workflow_process_inputs` stores encrypted scoped inputs and resolved catalog
  snapshots. Process receipts include structured output, logs and exit status,
  encrypted in the common journal before State/checkpoint publication.
- `workflow_subworkflow_invocations` binds each parent logical operation to a
  unique child checkpoint thread and encrypted input/DSL/scope snapshot.
- `run_recovery_jobs` persists claim status, retry count, next check time and last
  error. It is independent of in-memory supervisor notifications.

The first graph frontier is checkpointed before any node may submit an operation.
The dispatch timestamp is committed before sending a Remote message. A crash
between marking dispatch and sending is conservatively unknown. Records created
before this boundary existed are treated as potentially dispatched on upgrade.

| Fact | Recovery behavior |
| --- | --- |
| Successful output exists | Verify artifact metadata and SHA-256, then reuse |
| No dispatch has begun | Safe preflight retry, retaining logical identity |
| Task identity exists, output missing | GetTask against the original task |
| Dispatched, task identity missing | Await confirmation; never auto-resubmit |
| Remote failed/rejected/canceled | Preserve failure; no business resubmission contract |
| Another local execution is active | Reject competing recovery |
| Permanent adapter error | Manual recovery; no automatic retry |

## Scheduling and UI

The supervisor polls persisted jobs every two seconds. Transient, safe-to-recover
Remote operations use exponential delays starting at 10 seconds, capped at five
automatic claims per task. Startup closes abandoned attempts, releases recovery
claims and reopens jobs for interrupted journaled tasks. It preserves the retry
budget. There is no work while the application is exited.

Before automatic requeue, the worker validates the original checkpoint. Every
pending node must be Remote Agent; other executors stay manual. The Remote node
reconciles the existing operation before permitting downstream graph progress.
Taskless unknown outcomes and definite remote failures block the job. Startup
never turns an unknown submission into a fresh business request.

Run details expose Continue task, Run again, task attempts, stable operation IDs,
operation attempts, awaiting-confirmation state and recovery scheduling status.
Completed outputs and failed execution rows remain visible after continuation.
Only the latest inactive conversation turn can be continued, preventing a retry
from overwriting a newer conversation's state.

## Agent/tool recovery

Production Agent nodes scope a journal around every poll of the ADK stream.
Managed Process and MCP tools use paths `[scope, node, step, "tool", ordinal]`.
Provider function-call IDs are telemetry IDs only. Two identical calls in one
turn remain two operations; another loop step has a separate path. On manual
continuation, tool order, resolved arguments and catalog definition/bindings must
match the recorded operations. A different or skipped call blocks graph progress;
there is no attempt to infer identity from an argument hash.

The tool intent and encrypted bound input commit before marking dispatch. Returned
results commit before output schema validation and Agent post-processing, so
failure to generate the Agent answer does not lose the upload result. Replay
returns the saved result through the same validation and redaction boundary.
A tool error or timeout is conservatively unknown, because an error/exit code
cannot prove that an upload or other effect did not happen. These adapters declare
result reuse but no reconciliation capability. Unknown operations stop the node,
even if ADK catches the tool error and the model produces a successful answer.

This is conservative invocation replay, not durable model conversation replay.
A different model plan requires manual reconciliation. Graph resume creates a
fresh Agent invocation, including after tool-confirmation pauses. Previously
completed calls still need to replay in the original order; confirmation handlers
can request approval again before ManagedTool receives a call. This change does
not persist model conversations or redesign the existing confirmation flow.

## Standalone workflow Process/App nodes

Process paths are `[scope, node, step, "process"]`. The catalog definition is
resolved once and the same definition is passed to the executor and hashed by
the common gate. A saved receipt is reused without launching Python, syncing its
environment or opening an IPC execution session. Workrun artifact references in
the saved result are checked against metadata and SHA-256 before publication.
Missing or changed artifacts fail the reuse attempt, preserving the original
successful operation; restoring the original artifact enables another reuse.
Arbitrary paths and externally managed resources are not verified.

These nodes declare result reuse but no in-place resume or reconciliation.
Nonzero exit, invalid/missing IPC output, cancellation or a crash without a saved
receipt are conservatively unknown. Manual continuation rejects unknown process
operations before queueing. The dispatch marker currently precedes registry
preparation as well as Python execution: dependency-sync/IPC preparation failures
also require review rather than claiming that no process could have started.
Ordinary catalog lookup/input access failures occur before this marker.

The journal retains the input and catalog snapshot, but does not copy or freeze
the whole local project, its dependencies or mutable external resources. Catalog
changes fail input/config matching even for saved results. A Python child is
killed on future drop on a best-effort basis; that does not undo effects or prove
that subprocesses/external work have stopped. There is no cancellation-result
reconciliation contract in this phase.

## Child workflows and mixed manual recovery

A child invocation is a common operation at
`[parentScope, parentNode, parentStep, "subworkflow"]`. Its thread includes the
operation UUID, so loop iterations and parallel parent branches cannot share a
checkpoint namespace. The definition is captured when that child invocation
first begins, not by recursively freezing every workflow at root-task creation.
Once saved, recovery and child review/question responses use this original DSL,
even if the saved workflow has subsequently been edited or deleted.

Before starting the child, its invocation snapshot and dispatch intent are
persisted. A failed or paused child remains unfinished in the common journal;
its next attempt reconciles the original child checkpoint rather than relying
on the parent's in-memory/graph resume flag. Missing child checkpoints or missing
snapshots after dispatch block restart. This includes the conservative crash
window between dispatch intent and initial child checkpoint creation. Legacy
`parentThread/node` checkpoints without invocation bindings also block recovery.

Completed declared outputs, trace and termination state are encrypted and saved
before parent State/checkpoint publication. The parent can then reuse the child
receipt directly. Artifact outputs are checked before reuse; a failed reuse
attempt retains the original child success. Parent and child operations share the
root business execution identity but have separate stable paths and attempts.
Compensation uses descendant leaf records; the parent container never compensates the same effects twice (see [SAGA.md](SAGA.md)).

Manual Continue validates every pending root branch and recursively checks
unfinished child frontiers before requeueing. Remote, Agent/tool and Process
adapters apply their existing recovery rules at the child scope. Control/review
nodes remain graph-driven. CodeAct frontiers reject continuation because they
have no durable side-effect contract; a new business run remains available.
Automatic recovery remains restricted to Remote root frontiers. Child tool
approval decisions are not newly forwarded across the parent boundary; complex
nested tool-confirmation recovery remains outside this change.

## Remaining boundaries

- Top-level App runs outside a workflow and CodeAct execution are not journaled.
  Skill discovery tools bypass ManagedTool;
  only selected business tools are journaled.
- Agent/tool, Process and child-workflow continuation is manual. Automatic startup jobs still only recover
  Remote frontiers. Existing pre-upgrade tool effects have no operation identity.
- Process/MCP tools have no general idempotency/query contract. A crash after an
  external effect but before saving its result remains unknown and blocks reuse;
  no manual resolution UI or exactly-once guarantee is provided.
- Saved resource IDs are reused as returned; tools have no general resource
  existence/expiry verifier. Remote artifact checks do not apply to tool results.
- Automatic recovery of mixed pending frontiers and parent/child checkpoints is
  not enabled. Human review/question responses use saved child definitions;
  nested tool-approval forwarding still retains the pre-existing limitations.
- The original execution snapshot is used; changing inputs/DSL is not an implicit
  retry. Global provider settings and current credential references can still
  change independently of the saved DSL.
- Remote acceptance before task identity is saved requires an external
  query/deduplication contract. Local UUIDs alone provide no remote guarantee.
- Legacy remote records without a logical operation binding block recovery;
  node ID alone cannot identify a loop invocation safely.
- Permanent remote failures cannot be resubmitted under the current adapter
  contract. The user may need reconciliation or a new business execution.
- Recovery policy currently uses fixed local bounds, without per-node policy UI.
- Saga contracts and durable intent/outcome provenance are described in
  [SAGA.md](SAGA.md), including durable abandonment and compensation scheduling.
  Manual compensation reconciliation, fixture evaluation adapters and background
  execution remain future phases.

## Verification

SQLite tests cover same-task atomic enqueue, preserved failure history/cursors,
concurrent claims, dispatch boundaries, retry budgets and jobs reopened after a
second crash. Projection tests retain failed rows across task continuation while
preserving input-pause merging. The loopback A2A test fails checkpoint commit after
remote success and resumes the same task/thread with exactly one SendMessage;
it also requires GetTask when saved output is missing and forbids HTTP calls when
an unknown submission has no task ID.

Agent/tool tests run a real ADK LlmAgent with a fake upload executor: answer
generation fails after upload, runtime objects are rebuilt, and the same task
continues with one upload and submit/reuse attempt history despite changed
provider call IDs. Divergent/skipped calls and tool errors cannot dispatch again.
SQLite tests also distinguish repeated identical calls and loop invocations, and
keep an interrupted dispatched tool unknown after startup cleanup.

Process adapter tests omit checkpoint publication after saving a generated file
receipt, then reuse the same operation with exactly one executor invocation.
They also verify encrypted input/results, corrupt-file rejection and restoration,
and no restart after an unknown process outcome. These use an injected executor
at the durable boundary; they do not simulate an OS crash of a real Python child.

Child tests cover encrypted definition capture, stable resumed threads, distinct
loop invocations, missing-snapshot rejection, real child graph checkpoint resume
without a parent resume flag, and child receipt reuse before a parent checkpoint.
Mixed tests exercise Process/tool/Remote journals under one child identity with
one execution per adapter, validate mixed frontiers, and recursively block a
parent while a child Remote outcome is unknown. The mixed executor/transport
results are fixtures; this is not a live mixed-service integration evaluation.

## Operator reconciliation

Dispatched unknown/failed leaves can be reviewed from Run Workspace while the
task and compensation worker are inactive. Completed receipts reuse the stable
operation; verified no-effect evidence permits a new attempt with that same
identity. Review is a durable encrypted assertion tied to the latest attempt,
not an automatic inference from timeout. Imported artifact references must
resolve. Attempt history is preserved; Continue remains explicit for forward
execution. See SAGA.md for approval and compensation-specific behavior.

## Automatic App cleanup and continuation

New workflow failures first decide whether successful configured Process/App
calls need cleanup. Selected tasks enter durable cleanup and cannot continue
forward with deleted results; Run again creates a fresh business execution.
Without eligible calls, existing recovery behavior remains available. App
cleanup events stay on their original node messages without changing failure.
