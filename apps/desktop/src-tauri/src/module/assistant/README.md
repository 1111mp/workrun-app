# Conversational main agent and workflow specialist

Users describe outcomes in ordinary language. A one-off analysis does not require a
Workflow. Reusable automation is created only when requested or accepted by the user.
Business-specific instructions belong in delegated task contracts and generated node
configuration, never in global agent instructions.

## Roles and tools

The main agent owns conversation, clarification, direct work, capability discovery,
execution authorization and delivery. `read_artifact` reads authorized UTF-8 attachments;
`run_code` performs bounded Monty computation with attachment inputs and output files.
Neither tool creates a workflow. The sandbox has no host filesystem or network access.
Unsupported document formats, packages and external tools require a real available
capability; the agent must explain missing resources.

The coordinator registers `workflow_author` through `.sub_agent(...)` when the
current turn permits workflow authoring. ADK exposes `transfer_to_agent`; the model
chooses whether to transfer. `prepare_workflow_task` can supply a precise goal,
outputs, criteria, assumptions and optional revision target before handoff. It only
prepares data and never invokes a specialist. A direct handoff receives the interpreted
user goal and general validation criteria; the specialist derives task details or
returns questions rather than requiring the user to specify nodes.

The specialist discovers resources, progressively loads its own skills, validates and
saves. It cannot execute or delegate recursively. Completion, clarification and failure
are recorded natively, then its agent adapter emits an SDK transfer event back to
`main_agent`. Runner executes the return; the main agent delivers or performs an
independently authorized execution.

The main agent's skill catalog excludes node manuals and its tools exclude low-level
workflow authoring. The specialist has a separate catalog and tool allowlist. Both
use the selected conversation model initially; separate specialist model selection
is not implemented.

## Code ownership and ADK composition

`mod.rs` wires the assistant and exports the public runtime. `main_agent/` owns its
runtime, `tools.rs`, `skills.rs`, English instructions and general method skills.
`workflow_agent/` owns its ADK agent, tool catalog, skill catalog, persistence/validation
adapter and progressive node references. Neither role constructs the other role's
low-level tool registry. Shared `tools.rs` contains capability types and native service
ports only; shared `skills.rs` reads catalog entries without selecting an agent role.

Both roles use ADK 2.3 `LlmAgentBuilder`. `orchestration.rs` constructs the parent tree
with `.sub_agent(...)` and executes it through `Runner`. There is no `AgentTool` or
custom `delegate_workflow` invocation path. Runner owns model/tool iteration, the
registered transfer targets and control changes in both directions. The specialist's
completion adapter emits events; it never directly runs the parent.

A scoped SDK session is seeded from durable native history for each turn and always
starts with the coordinator. This avoids a specialist receiving the next unrelated
user message. `IncludeContents::None` limits the specialist's initial history to the
current user message; Workrun adds its explicit task contract and authorized artifact
references. Subsequent specialist tool history remains SDK-owned. Main and specialist
instructions/tool catalogs remain separate.

`sdk.rs` bridges turn-scoped native services to SDK-owned agents without exposing
credentials or workspace objects. Native execution tools return a validated signed
proposal to the durable session owner; Runner never submits business runs itself.
Existing provenance binding, workspace scope and receipt continuation remain enforced.

## Native boundaries

Structured turn interpretation distinguishes conversation, task, authoring and
execution (plus status/explanation/clarification). An ordinary task opens direct tools,
not workflow creation. Authoring and execution require evidence from the current user
message; creating and executing require separate grants. Model interpretation remains
fallible and needs provider evaluation.

One delegation and one workflow submission are allowed per user turn. Malformed task
contracts can be corrected before consuming the delegation. Child tools cannot bypass
execution policy. Independent reads can be batched (up to eight); writes and execution
must be isolated. Rejected bindings/tool calls return repairable errors when possible.

Validated authored workflows are saved directly into the normal workspace catalogue.
The delegation UUID is the stable creation identity; revising an existing target retains
its UUID. The ordinary editor, node palette, save and execution paths apply. Publication
is separate. Retries resolve the current saved definition, including user model edits.
No legacy draft migration or compatibility aliases are maintained.

The native session owns trusted artifact references, credentials, dispatch identity,
run observation and receipt continuation. Generated artifacts persist with assistant
messages. Only validated native capability outputs can serve as result bindings.
Workflow observation survives renderer disconnection; model phases are bounded to
240 seconds. Interrupted direct/delegation operations are inspectable and never
silently replayed after restart. This is not automatic subagent resumption.

Direct calls and specialist tool calls are journaled under
`assistant/operations/<UUID>.json`, scoped to the workspace and conversation.
`inspect_operations` exposes recent summaries to the main agent. Existing run receipts
remain the source of workflow execution status. Specialist internal reasoning is not
streamed as a user answer; explicit progress messages remain available.

## Resource layout

[main_agent/AGENT.md](main_agent/AGENT.md) and [main_agent/INTENT.md](main_agent/INTENT.md) define the general policy. Five core
skills are mandatory; workspace skills load on demand. The specialist's contract is
[workflow_agent/AGENT.md](workflow_agent/AGENT.md), with the separate
[authoring handbook](workflow_agent/reference/README.md). Skill bodies and authoring references live outside the executable
in Tauri resources; the generator and build check keep them synchronized.

## Validation and remaining scope

Offline regressions cover role/tool isolation, direct attachment computation, refusal
of workflows, clarification without saves, blocked specialist dispatch, graph repair,
normal catalogue identity, operation persistence, native session execution and receipts.
Scripted tests prove runtime boundaries, not real-model intent accuracy.

```sh
pnpm --dir apps/desktop workflow:generate
pnpm --dir apps/desktop workflow:check
CARGO_INCREMENTAL=0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib module::assistant
```

Optional real-model checks use configured credentials and temporary data:

```sh
WORKRUN_ASSISTANT_LIVE_CONFIG_DIR='/path/to/workrun/config' CARGO_INCREMENTAL=0 \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  live_main_agent_handles_natural_file_requests_without_workflows -- --ignored --nocapture
```

Direct Tool-kind Apps/MCP are not exposed yet: their confirmation context must be
preserved before integration. Workflow-kind Apps remain callable through the existing
capability adapter and native execution policy. Compilation proves structural validity,
not business correctness. Generated graphs still require semantic evaluation across
more tasks, providers and resource configurations. Full client/production queue testing
is separate from temporary-storage model and engine tests.

Validation on 2026-10-18: the SDK parent/sub-agent and Runner composition passes 64 offline assistant tests,
including real rule-graph execution, role-specific tool/skill isolation, private
parent-history isolation and repairable missing operation context. A configured Gemini
save-only acceptance also completed the SDK transfer, validation, save and parent
delivery without execution, using temporary storage. Frontend behavior
is unchanged by this backend reorganization. Temporary provider tests remain separate
from production client/queue acceptance.

```sh
WORKRUN_ASSISTANT_LIVE_CONFIG_DIR='/path/to/workrun/config' CARGO_INCREMENTAL=0 \
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  live_draft_only_authoring_has_no_execution_grant -- --ignored --nocapture
```

Prompt maintenance is product-level: describe roles, protocols, permissions, resource
limits and general methods. Business examples, formulas and expected outputs belong
in test fixtures, or in workflow configuration derived from the current authorized
task. Do not turn a failing example into a global instruction or fixed node topology.
