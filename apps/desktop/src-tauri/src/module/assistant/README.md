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

`report_progress({summary})` publishes a concise public approach/progress summary (1–600 characters). It is a read-only communication tool, not permission to execute a workflow and not a provider's private thinking transcript. Native `activity` events carry a stable activity ID and the originating user-message `turnId`; summaries are persisted in `session.activities` when the model phase ends, including a failed phase. While a phase is in flight, live summaries are transient; reloading can recover them after that phase commits. Provider thinking parts remain excluded from visible text.

The renderer groups assistant/tool records by the preceding user message. The collapsible public summary is visible only during the active model phase before answer text starts streaming; workflow execution and user-action waits use the inline run card instead. Native responsePhaseId and activity phaseId prevent discovery summaries from leaking into result delivery. Completed/failed turns hide the thinking indicator, and the final answer owns the feedback controls. Stored model/function exchanges remain intact for continuation; historical sessions use the same grouping without a database migration.
