# Native capability knowledge and coverage

This is a maintainer audit, not an Agent instruction or a prescribed graph. It
compares existing product surfaces and identifies verification gaps. A documented
or compilable capability is not evidence of autonomous selection or correctness.
No task-specific rule or new state/plan protocol is introduced.

## Node inventory

The editor union (`components/workflow.d.ts`), native `workflow/contracts.rs`
NODE_TYPES and `workflow/node-contracts.json` contain the same 13 node kinds.
`contracts::tests` checks that set and validates each contract example against its
schema. Generated references expose summaries, detailed guides and exact schemas.
The native compiler dispatch is in `workflow/mod.rs`.

| Node | Configuration/behavior to preserve | Verification still needed across autonomous tasks |
| --- | --- | --- |
| start | Run inputs enter global state; entry restrictions | Deriving reusable input contracts from user intent |
| end | Completion and Workflow-declared global outputs | Export completeness and correct required/type choices |
| agent | Visible state, file references, output modes, selected tools/Skills | Selecting real executable dependencies when needed; factual quality |
| codeact_agent | Restricted runtime, manifest, final_result, files and limits | Environment-aware implementation and changed-input execution |
| process | Discovered App identity/release and exact input/output names | Local/team resource selection and unavailable dependencies |
| remote_agent | Endpoint, authentication, attachments and timeout | Authorized configuration, service failure and returned output handling |
| if_else | Independent true/false expressions and source handles | Boundary cases and paths where neither condition matches |
| switch | Ordered cases and default | Overlapping cases, unmatched inputs and downstream visibility |
| human_review | Native pause/resume, editability and decision handles | Resume/cancel behavior and safe handling of human edits |
| ask_user_question | Native option selection and source handles | User decision integration across run lifecycle |
| subworkflow | Discovered definition, recursion constraints, declared global outputs | Reuse with changing inputs and parent output publication |
| terminate | Explicit early completion | Intentional termination versus missing-result failure |
| group | Layout only, no executable edges | Preserving layout without treating it as processing |

This inventory establishes existence and documentation coverage, not full field
or behavioral parity. The editor inspector also provides dynamic record-based
controls; a TypeScript declaration alone does not establish its behavior.

## Cross-cutting contracts and discovery

| Capability | Current implementation/reference | Evidence boundary / next verification |
| --- | --- | --- |
| Native document | workflow_agent/reference/format.md; authoring validator/compiler | Positive/negative generated definitions; no goal correctness implied |
| Scoped state | workflow/state_bridge.rs; reference/state.md and configuration.md | Global/private/raw access, conflicts, branch ordering, nested values |
| Models | list_authoring_resources(kind=models) | Profile discovery does not establish credentials or service availability |
| Tool Apps and MCP | workspace_resources.rs; ToolRegistry; Agent toolIds/toolStateBindings | Exact schemas, confirmation policy, selected ID versus callable name |
| Personal Skills | workspace discovery/read; Agent skillRefs | Declared tools, lazy loading, trigger and compatibility requirements |
| Workflow Apps | Catalog list_capabilities and Process App contracts | App IDs/release identity and actual input/output keys |
| Existing Workflows | Catalog discovery; subworkflow or authorized execution | Explicit/current target identity, reuse and revision boundaries |
| Files | ArtifactRefs; Agent attachmentPaths; CodeAct manifest/export | Supported content types, sizes, authorization and actual generated files |
| Runtime environment | codeact_agent.rs; CodeAct node details use linked runtime capabilities | Language/OS briefing is discoverable; complete API inventory and autonomous implementation remain unverified |
| Recovery/effects | workflow/SAGA.md, RECOVERY.md; operation records | Interrupted operations, retries and external effects in isolated fixtures |
| Conversation lifecycle | main/planning/authoring roles, task_runtime checkpoints | Clarification, version feedback, creation versus execution authorization |
| Outcome evidence | Test-only outcome_evaluation.rs and task fixtures | No production-wide business verifier; autonomous multi-task evidence incomplete |

References are progressively available through shared workrun-capabilities Skill,
get_workflow_reference and workspace resource discovery. Reading an installed Skill
or describing a tool does not grant execution. Tools available to the conversation
are not automatically selectable Workflow tools.

## Current evidence and limits

- Editor state declarations match the existing data.state shape. Ordinary values
  use scoped state; attachmentPaths selects file references. Neither introduces a
  separate data transport or task-specific interpretation.
- CodeAct language/OS information is appended when its node details are requested,
  using the linked runtime briefing. It is not a complete Python API inventory or
  evidence that a generated implementation will work.
- Planner receives the current conversation with user/model source labels, the
  current plan and authorized artifacts. There is no automatic operation-directory
  scan or historical code/result replay. Existing operation receipts remain intact.
- Existing requests are not routed through a new mandatory diagnostics writer.
  The earlier wrong-target incident remains unresolved; no complete historical
  provider request is available to attribute its source.
- Planning feedback uses existing proposal fields/versions and native confirmation.
  Questions are visible in the plan card and answered through the existing composer.
  Answers, delegated preferences and proposal confirmation remain distinct.

## Local verification

| Coverage | Test location | What it establishes |
| --- | --- | --- |
| Editor/native node set and schema examples | workflow/contracts.rs | 13-kind inventory and example/schema validity |
| Role boundaries, clarification, confirmation and execution grants | planning_tests.rs, multi_agent_tests.rs, authoring_tests.rs | Scripted lifecycle behavior; not autonomous reasoning |
| Outcome grading | outcome_evaluation.rs | Passed, incorrect, unobserved and failed execution stay distinct |
| Saved routing definitions and varied inputs | native_outcome_tests.rs | Actual native Graph behavior and negative-rule grading |
| Saved human participation | native_outcome_tests.rs | Four paths through pause, SQLite reload, native decision preparation and branch/output checks |
| Persisted child reuse and disappearance | native_outcome_tests.rs | Actual child Graph outputs and resource failure; cfg(test) temporary catalog substitutes Config storage |
| File aggregation, deduplication and exact formatting | task_outcome_tests.rs; fixtures/tasks | Independent expectations and offline recorded-output grading; recordings remain required |
| CodeAct environment | workflow/codeact_agent.rs; authoring references | Linked briefing discovery and basic runtime probes, not all APIs |
| Numeric redaction regression | workflow/guardrails.rs | Numeric values preserved while tested real PII remains protected |

Rust checks use CARGO_INCREMENTAL=0. Run the Assistant suite with:

```sh
CARGO_INCREMENTAL=0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib module::assistant::
```

Resource consistency: `node apps/desktop/scripts/generate-workflow-reference.mjs --check`.
Desktop declarations: `pnpm --dir apps/desktop typecheck`.
Ignored real-provider/network tests are not evidence of a pass. Use temporary
storage and independent expectations; no user Workflow execution is needed here.

## Remaining product questions

Knowledge availability, compilation and scripted acceptance do not establish
correct autonomous capability selection. Evaluate the plan, saved native definition
and observed outcome together across unrelated tasks and changed inputs. Judge
behavior, not node names, topology or a preferred executor.

Installed tool/Skill composition, unavailable external resources, team ACLs and
production child journaling/persistence need separate isolated coverage. No complete
autonomous multi-task benchmark or external-provider result is claimed. Preserve
missing observations as unverified; completed execution is not business correctness.

Keep Agent documents focused on responsibilities and handoffs, Skills on methods
and formats, and native references on configuration contracts. Update source
contracts/guides and regenerate packaged resources; do not add domain-specific
rules, mandatory topologies or another state/plan protocol.
