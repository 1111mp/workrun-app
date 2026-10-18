# Workrun main agent

The main agent is a conversational runtime, independent of workflow chat nodes.
Workflows remain executable capabilities backed by the existing run manager.
Tauri commands handle credentials and durable workspace-scoped sessions; the
runtime owns instructions, skills, turn interpretation, tool policy and the model loop.

## Product contract

Workrun's main agent helps users understand, plan and accomplish work through a
continuous conversation. Users describe outcomes; the agent handles capability
discovery, input preparation, coordination and delivery. Direct reasoning, writing,
analysis and discussion are useful deliverables without an execution tool call.

“Everything is workflow” describes how executable work is represented and reused.
Workflows encapsulate operations; apps and connected services contribute capabilities
through actual tool interfaces. Skills describe methods. The agent connects goals to
these capabilities without making the user navigate the implementation structure.

The base contract lives in `AGENT.md`. Core skills divide its methods by responsibility:

| Skill | Responsibility |
| --- | --- |
| `conversation` | Understand goals, resolve references and maintain continuity. |
| `task-planning` | Establish success criteria and a proportionate approach. |
| `capability-orchestration` | Discover, select and reuse available capabilities. |
| `execution-collaboration` | Coordinate execution, progress and human participation. |
| `result-delivery` | Synthesize evidence and deliver useful answers or artifacts. |

All five core skills are injected as base guidance. Workspace-selected skills add
specialist knowledge and are loaded on demand. Permissions belong to the runtime;
workflow-specific invocation details belong to tool schemas and handlers, not to the
agent's general identity or method skills. Concrete business examples belong in
regression/evaluation fixtures rather than the production instructions.

## Current capability boundary

The runtime currently exposes workflow discovery and invocation, enabled-skill reading
and conversation-receipt inspection. It does not yet expose direct app execution,
arbitrary service tools, or workflow creation/composition. The general instructions
allow those capabilities to participate when registered, without asserting that they
already exist. A missing capability must remain an explicit gap.

## Turn lifecycle

1. Normalize conversation history, preserving tool call IDs and provider signatures.
2. Interpret the latest user message using structured output and **no tools**.
   Intent is conversation, status, explanation, clarification or execution.
3. Open a bounded agent loop with read-only tools. Only an execution decision with
   an exact action quote from the current message opens workflow execution tools.
4. `list_workflow` discovers capabilities on demand, with search, exact ID lookup
   and pagination. Workflow definitions never create individual model tools.
5. `execute_workflow({workflow_id, input})` yields to the native session owner. Rust
   resolves the authorized definition, validates input, prepares dependencies,
   persists run identity, then dispatches through the existing native RunManager.
6. The native task observes durable execution receipts and resumes the model to
   answer. This continuation has no execution grant. The task survives renderer
   reload/disconnection; a process restart exposes explicit reattachment by run ID.
   Frontend code only submits turn actions and observes snapshots/stream events.

No regex or keyword routing selects workflows. The model interprets intent and picks
an available capability. The runtime validates the resulting grant/tool name, but
semantic intent classification remains model-dependent and needs provider evaluation.

## Files maintained independently

- `AGENT.md`: base agent contract.
- `INTENT.md`: structured intent assessment instructions.
- `skills/*.md`: the five core working-method skills.
- `skills.rs`: mandatory and workspace-selected skill catalog.
- `tools.rs`: fixed `list_workflow` / `execute_workflow` contracts, plus skill/receipt tools.
- `catalog.rs`: native local/Team discovery, authorization, schemas and App preparation.
- `session.rs`: durable native session ownership, dispatch, observation and continuation.
- `protocol.rs`: model messages, streaming, history compatibility and call validation.
- `mod.rs`: profile, turn grants, provider boundary, bounded model/tool loop.

The Gemini ADK 2.3 adapter ignores `system` messages. For Gemini the runtime uses
ADK's own LlmAgent convention of a user instruction preamble; other providers retain
system instructions. This conversion does not alter persisted user messages.

## Workspace profile

Optional file: `<active workspace>/assistant/agent.json`. Absence uses defaults;
malformed profiles fail closed. The runtime reads this file afresh each invocation.

```json
{
  "skills": [],
  "instructions": "Answer concisely in the user's language.",
  "workflowExecution": true,
  "maxModelSteps": 8
}
```

`skills` lists names from the existing workspace skill catalog. Enabled custom skill
summaries are discoverable and `read_skill` loads their bodies. Mandatory skills
cannot be overridden by name. Skills provide guidance, not new tool permissions:
their `allowed-tools` metadata does not attach arbitrary workflow-node tools to the
main agent. New native main-agent tools must be registered with a handler and policy
in `tools.rs`. The profile is currently file-configured; there is no new settings UI.

`workflowExecution: false` makes this agent read-only. Step limits are 1–16; a whole
turn has a 120-second timeout. Existing workflow timeout/human-action policies apply
inside dispatched workflows. Credentials never enter the profile or model context.

## Verification

Runtime tests exercise the full model request/tool loop with a scripted model:
operation → receipt → status question → explanation → conversation → explicit retry.
They check tool grants, current-message binding, disabled execution, hostile tool
responses, skill/receipt tools and bounded loops. Renderer tests verify the native turn contract and observer-only reattachment.
Native session tests verify persistence before dispatch, detached waiting, and
recovery from an uncertain queue response without a second execution.

The optional `gemini_wire_keeps_instructions_and_status_turn_has_no_execution_tool`
test uses the real ADK Gemini adapter against a local HTTP stub, without API keys or
business side effects. Run it with `--ignored --nocapture` and a local listener allowed.
These tests verify runtime behavior and transport, not live-model classification quality.

A second opt-in test, `live_gemini_followups_do_not_propose_another_execution`, reads
the encrypted Gemini credential from the explicitly supplied
`WORKRUN_ASSISTANT_LIVE_CONFIG_DIR` installation directory. It evaluates direct writing, planning, capability discussion and report generation,
as well as status, explanation and explicit retry, against the configured provider. Set
`WORKRUN_ASSISTANT_LIVE_MODEL` to override the test model. It never instantiates a
workflow executor, writes configuration or dispatches business operations. Credentials
remain in memory and are not printed. Live tests are excluded from normal CI.

Live cases are paced to reduce provider request bursts. Set
`WORKRUN_ASSISTANT_LIVE_FILTER` to run only inputs containing a given substring,
for example when resuming an evaluation after provider rate limiting.

## Team transport

The renderer supplies its current Better Auth session token to the native turn command.
Rust uses it only in an authenticated HTTP client for the configured Team server;
it is never persisted in conversation JSON or passed to the model. The server enables
Better Auth's bearer plugin so native requests use the same session/ACLs as browser
requests. Deploy/restart the Team server with this change before using native Team
workflow discovery. Release-scoped App dependencies are downloaded and checksum-verified
through the existing native installer. No renderer-provided DSL or catalog is accepted.

The workflow manager owns workflow-level user actions and cancellation. Native assistant
model steps have a 120-second bound; workflow observation is outside that bound so
human review or long executions do not time out the assistant's model request.


### Public progress and turn presentation

`report_progress({summary})` publishes a concise public approach/progress summary (1–600 characters). It is a read-only communication tool, not permission to execute a workflow. Native `activity` events carry stable activity IDs and the originating user-message `turnId`; summaries persist in `session.activities` when the phase ends, including a failed phase.

Provider-returned `Thinking` text streams separately from answer text through `reasoning` events. Each model invocation owns a stable reasoning ID, cumulative text, completion flag and duration. Authoritative provider snapshots replace accumulated deltas. Signatures remain in model history and are never emitted as display text. Gemini conversation models request thought summaries; Gemini 3 Flash-Lite additionally uses Medium thinking because its default Minimal level may produce no displayable thinking. Workflow model defaults are unchanged. Intent classification does not emit its internal model output.

The renderer groups assistant/tool records by user turn and reasoning/activity records by model phase. Trace expands during thinking, folds when answer text starts, and respects manual expansion choices. Completed and failed provider thinking remains available for review. Public progress is labeled separately and only shown while its phase is active, so preparation messages do not remain as stale statuses after completion. Native persistence retains both records even when the model phase fails. Live records are transient until the phase commits. Workflow execution and user-action waits retain their inline run card; final answers own feedback controls.

## Data-driven evaluation baseline

`fixtures/baseline.json` is the versioned main-agent evaluation set. Its 26 cases
cover direct answers, planning, status/explanation, explicit retries, contextual
confirmation/rejection, missing inputs, ambiguity, unavailable capabilities, bilingual
routing, typed parameters, and result delivery. Four synthetic capabilities provide
competing destinations; the dataset is independent of a user's workflow catalog.

`evaluation.rs` runs the same main-agent runtime, with the default profile and core
skills, against a configured Gemini model. It separately scores:

- **Intent:** the structured current-turn assessment, observed from actual model output.
- **Routing:** no proposal, the correct workflow, or clarification/input collection.
- **Arguments:** exact fixture-defined values, including canonical reporting periods.
- **Delivery:** no second execution and fixture-specific factual anchors in the answer.

Delivery checks are targeted assertions, not a general semantic judge. Prior-turn
fixtures use synthetic conversation summaries. They complement the signed function
history and native session recovery tests; they do not replace those tests. Scripted
models validate the evaluation harness, not model classification accuracy.

Run all cases explicitly (this calls the configured provider and may consume quota):

```sh
WORKRUN_ASSISTANT_LIVE_CONFIG_DIR='/path/to/workrun/config' \
WORKRUN_ASSISTANT_EVAL_REPORT='/tmp/workrun-assistant-evaluation.json' \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  live_assistant_evaluation_baseline -- --ignored --nocapture
```

Use `WORKRUN_ASSISTANT_EVAL_CASES='greeting,sales-this-week,no-match-images'` to select
exact case IDs. `WORKRUN_ASSISTANT_LIVE_MODEL` overrides the model. Requests are paced
at six-second intervals, including tool discovery requests. A provider failure stops
the run and still writes a report; it does not silently count remaining cases as
passed. Reports include selected IDs, suite size, per-case results, per-dimension
counts, and an explicit completeness flag. Runtime rejections are failures, while
provider failures such as rate limits are recorded as incomplete coverage. Neither
credentials nor provider request URLs are written into reports. Reports contain only
synthetic fixture inputs/outputs; normal CI does not call a provider.

### Initial measured baseline and next steps

On 2026-10-18, `gemini-3.5-flash-lite` completed all 26 cases with no provider
errors: 22 cases passed, intent 24/26, routing 23/26, arguments 10/10, delivery 3/3.
These are one-run regression observations, not a production accuracy estimate.
The argument score covers explicitly specified inputs; invented defaults are
separately caught by missing-input routing cases.

The initial run identified four cases requiring fixes:

- `write-email`: answered directly but classified ordinary drafting as execution.
- `reject-plan`: classified explanation correctly, then the runtime rejected the
  turn. No execution was returned; investigate the rejected model/tool exchange.
- `missing-period`: proposed `sales-report` with `this_month` despite no supplied
  period, rather than collecting the missing input.
- `ambiguous-followup`: classified an unclear follow-up as execution and proposed
  `sales-report` with an invented `this_month` period.

The revised intent and coordination instructions distinguish in-conversation writing
from external actions, require an unambiguous contextual confirmation, honor a pause
or refusal over earlier execution intent, and require input values from the user,
established context, or a declared schema default. Enum choices/examples are not
defaults. Missing scope must be collected before execution. The instructions also
explicitly prohibit parallel tool calls, matching the runtime's existing constraint.
Evaluation errors now retain allowlisted runtime rejection categories without exposing
model text, credentials or request URLs.

On the same date/model, all four original failures passed a focused rerun, followed
by the unchanged complete baseline passing 26/26: intent 26/26, routing 26/26,
arguments 10/10, delivery 3/3, with no provider errors. These are model-behavior fixes
through runtime instructions, not a native proof of semantic input provenance. Native
execution grants, schema validation and rejection of unauthorized calls remain in force.
Before automatic composition, add explicit input provenance/collection and unify
Workflow/App capability contracts and output bindings, then introduce constrained
composition plus native graph validation.
The initial real-model acceptance passed with amount 1500, the actual graph's
manual-review branch and exactly one dispatch; production queue coverage remains
outside that acceptance test.

## Real read-only workflow acceptance

`fixtures/expense-review.workflow.json` is a local rule graph:
`Start → amount >= 1000 → End`. It uses no model nodes, Apps, network connections,
payments, or user files. A temporary SQLite checkpointer backs the actual compiler
and graph executor. The assistant dispatches through its normal durable identity and
result handoff, with a test execution transport replacing the production RunManager
queue. This verifies real graph execution and conversation handoff, not a launched
Tauri process, Team transport, production queue workers, or App runtimes.

The ordinary `assistant_acceptance_executes_real_expense_rules_and_returns_receipts`
test checks amounts 800, 1000 and 1500 with a scripted assistant. To exercise a real
model's selection, parameters and final answer with the real graph:

```sh
WORKRUN_ASSISTANT_LIVE_CONFIG_DIR='/path/to/workrun/config' \
WORKRUN_ASSISTANT_ACCEPTANCE_REPORT='/tmp/workrun-assistant-acceptance.json' \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  live_assistant_real_workflow_acceptance -- --ignored --nocapture
```

The acceptance report includes the computed graph state, final answer and dispatch
count. Nothing is installed in the user's workspace, and no business workflow is run.
