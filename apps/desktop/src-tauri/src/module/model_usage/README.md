# Model usage ledger

`observe` is the common provider boundary used by assistant generation, workflow
model wrappers (including CodeAct), and workflow-chat memory summaries. SDK agent
forwarders are not provider calls and must not be instrumented again.

Each invocation generates a UUID and enqueues snapshots without waiting for SQLite.
One background worker owns a bounded queue (256 snapshots), retries a failed write
once, and bounds each attempt to 250 ms. Queue saturation or write failure never
changes the provider request or its response. No durable outbox or unbounded retry
queue is used. Snapshot revisions prevent a delayed older write from overwriting
a final result. Do not add streaming usage snapshots together.

A terminal response is enqueued before yielding because agents may stop polling
after a tool call; a later usage tail can refine the same row. Dropped requests are
interrupted; persisted requests left running by a crash are interrupted at startup.
Unknown usage is null, never fabricated as zero. Failed calls can still have known
usage. Transport retries hidden inside an adapter cannot be split into separate
calls by this boundary.

Normal quit/restart waits at most one second for queued writes. Abrupt process
termination or a failed flush can lose queued snapshots. `recordingDegraded` is a
conservative, process-wide warning about dropped/failed records, not a per-session
loss count; it resets after restarting the app. The panel always shows known
subtotals rather than a guaranteed complete bill. Reading statistics does not wait
for the writer, so recently completed calls can take a refresh to appear.

`CallContext` carries attribution via a scoped Tokio task local. Concurrent turns
must enter separate scopes. Workflow wrappers capture that context at compilation,
so graph tasks do not depend on inheriting task locals across spawns. Assistant
workflow dispatch persists its origin in native runtime metadata before queuing;
recovery retains that origin, while a new manual replay clears it. Memory summaries
belong to the conversation, not a workflow model node.

`model_usage_session(kind, id)` accepts `assistant` or `workflow_chat`, verifies the
session belongs to the active workspace, and returns known subtotals, coverage,
purpose groups, and call details. Execution is a separate subtotal, identified by
runId. Native historical receipts can link imported runs without duplicating calls.
The UI does not add run_spans to this ledger's totals. Existing run-history spans
remain a compatible observability projection; new events share the ledger call ID.

The migration imports only historical model spans. It cannot recover old assistant
usage, opaque remote-agent/tool charges, or provider usage that was never returned.
The panel explicitly reports recorded coverage rather than claiming a complete
historical bill. Cached and reasoning tokens are breakdowns, not additional tokens.
Request and tool sizes are characters, not token estimates. Provider-specific
billing prices are deliberately not inferred.

Records retain IDs, configuration/recipe hashes and request sizes, not prompt,
tool-result, file, or reasoning bodies. The ledger survives deleting a conversation;
the session query is no longer accessible after deletion. This is local diagnostic
storage, separate from opt-in OTLP export.

## First optimizations and measurement

The authoring skill now submits one document directly to save_workflow_draft,
which already validates before writing. Separate validation remains available for
review-only requests. Direct-code instructions specify unsupported csv/io/pandas
and the no-argument read_text signature, addressing observed sandbox retries.
Neither change relaxes execution authorization or native validation.

For subsequent optimization, use the same tasks and model/profile versions to
compare per-purpose calls, tokens, configuration hashes, request sizes, latency and
outcome correctness. Cover ordinary chat, long history, planning, creation,
revision, tool failure and execution delivery. Do not report character reductions
as measured token savings. No paid live calls are needed for ledger regression
tests; real savings require collecting a new representative baseline.

## Product-wide diagnostics

New provider records retain responseKind (content/tool_call), bounded requested
tool names and provider finishReason when supplied. Usage-only tails preserve the
preceding action. These fields explain model behavior; they do not assert user-task
success or imply permission. No arguments, response bodies or reasoning are stored.
Request sizes include the 20 largest tool-result groups by serialized character
count, plus the total distinct kind count. This measures repeated context without
guessing token allocation. All writes still use the existing nonblocking writer.

The session API also returns byTurn using existing native turnId, with conversation
and execution tokens separated, missing usage and incomplete calls retained. Null
turn IDs remain explicitly unattributed (including legacy calls). modelDurationMs sums
model durations, not task wall time; parallel calls can overlap. Do not infer a new
multi-turn task identity from message text. Use existing session/operation/run IDs
for related work and record actual task outcomes separately from model status.

Compare representative ordinary chat, long history, planning, creation, revision,
tool failure, cancellation and result delivery. Include quality and authorization
checks alongside tokens/calls/latency; a single workflow is not a product benchmark.

The opt-in assistant evaluation report includes per-case wall time and per-call
request character counts, configuration hash, status and observed provider usage.
Missing usage remains null; cumulative streaming snapshots replace earlier values.
Its routing/delivery fixtures do not execute workflows, so `executionIncluded=false`
prevents treating those costs as end-to-end task costs. Lifecycle execution costs
still come from the native ledger. Scripted tests verify accounting and context
preservation, not model quality or measured provider savings.

Assistant request projection keeps the latest full copy of identical large native
read results and replaces earlier copies with their tool-call reference. Comparison
includes all response metadata; writes, execution receipts and errors are excluded.
This affects only model-facing copies, not stored history or binding evidence.
