# Native capability knowledge audit

This is a maintainer inventory, not a model protocol or execution policy. The model
entry point is [workrun-capabilities](reference/workrun-capabilities.md), exposed
through the three roles' existing Skill catalogs. Node details remain generated
from `../workflow/node-contracts.json`; installed resources remain dynamic.

## Configuration inventory

| Capability | Editor/configuration | Native implementation | Model reference/discovery |
| --- | --- | --- | --- |
| Workflow input/output and task/chat mode | workflow settings; native document settings | `../workflow/mod.rs`, `../../feat/workflow.rs` | reference/format.md, reference/state.md |
| Local model, instructions, structured output | agent node inspector | `../workflow/agent.rs` | generated agent guide; list_authoring_resources(models) |
| Restricted Python, runtime limits, mounts | codeact_agent node inspector | `../workflow/codeact_agent.rs` | generated CodeAct guide |
| Workflow App | processNodeId / appRef | `../workflow/process.rs`, `../process_node/` | generated process guide; list_capabilities |
| Tool App and MCP selection | toolIds, toolStateBindings | `../tool_registry.rs`, `../workflow/tool.rs`, `../mcp_server/` | list_workspace_tools; selected full contract |
| Personal Skill selection | agent.skillRefs; absent on CodeAct | `../skill.rs`, `../workflow/agent.rs` | list_workspace_skills, read_workspace_skill |
| Remote agent | endpoint, authentication, attachments | `../workflow/remote_agent.rs`, remote_auth.rs | generated remote_agent guide |
| State publication and access | state.globalKeys, state.access.readers/rawReaders, sensitiveFields | `../workflow/state_bridge.rs`, `../state/` | reference/state.md; node data schemas |
| File references and deliverables | file/files interface fields; attachmentPaths | `../artifact.rs`, workflow/agent.rs, workflow/codeact_agent.rs | state and generated Agent/CodeAct guides |
| Conditions | if_else, switch and source handles | `../workflow/routing.rs` | reference/routing.md; generated node guides |
| Human decisions | human_review, ask_user_question | corresponding native node modules | routing/recovery and generated guides |
| Reuse | subworkflow.workflowId | `../workflow/subworkflow.rs` | generated guide; list_capabilities |
| Lifecycle/layout | start, end, terminate, group | `../workflow/mod.rs` and routing.rs | generated guides; format reference |
| Effects and recovery | native operation/recovery/compensation configuration | workflow/operations.rs, recovery.rs, saga.rs | recovery, compensation, execution-recovery |

The editor source for node fields is
`apps/desktop/src/components/workflow-node-inspector.tsx` from the repository root.
The model authors `settings/nodes/edges`, then saves into the ordinary Workflow
catalog through `feat/workflow.rs::save_authored_workflow`. No separate graph format
or state transport is needed.

## Confirmed corrections in this increment

- The reference README described access as author-only, although the planner
  already calls the same reference reader. Updated the explanation.
- Roles had separate entry Skills with no shared Workrun capability map. Added
  one optional external Skill reused by all three catalogs and the specialists'
  reference reader. The main role still has no node-reference/configuration tool.
- The state guide advised building serial graphs before parallel graphs. Removed
  this extra topology preference; described native scheduling versus visibility.
- Kept tool discovery factual: Agent/CodeAct toolIds resolve MCP and Tool Apps.
  Conversation read_artifact/run_code are not Workflow tool IDs. Personal Skills
  are supported on Agent; CodeAct's current contract does not expose skillRefs.

## Node-resource knowledge and example checks

The Agent, CodeAct and Process semantic guides now explain their actual resource
configuration paths and link to topic=configuration/examples. Configuration examples
are ordinary Workflow documents in workflow_agent/reference/configuration-examples.json,
with explicit discovery placeholders and assumed tool/App contracts.

- Corrected an existing state-reference error: native scoped input flattens permitted
  private/global fields using their original keys, not automatic nodeId.key aliases.
  Duplicate visible keys raise InputKeyConflict. Regression coverage checks both
  private visibility and the conflict, without changing the runtime.
- Agent: private output sharing, outputSchema/outputKey alternatives, tool IDs versus
  callable names, argument binding and SkillToolset activation. Skill-declared tools
  must be selected; nonempty allowedTools declarations restrict the effective set.
- CodeAct: visible ArtifactRefs, manifest format, supported configuration, final_result
  and automatic artifacts export. CodeAct does not expose skillRefs, outputKey or
  attachmentPaths in its current contract.
- Process: installed Workflow App ID and visible input/output field names; Tool Apps
  and MCP tools belong in Agent/CodeAct toolIds, not processNodeId.

Validation levels remain explicit: examples pass node-schema/document-shape checks,
native catalog serialization in temporary storage and editor load/document round-trip
checks. Local native state/tool bindings and Monty file export test the illustrated
state semantics. Placeholders do not establish full compilation with dependencies,
provider behavior, installed Skill activation or external App/MCP execution.

## Code/knowledge alignment status

1. **Planning granularity — corrected:** node_types can be omitted or empty and
   supplied types are suggestions, not saved-graph requirements. The planner may
   leave routine configuration to authoring. Committed dependencies retain native
   discovery/availability and saved-graph checks; substantive user requirements
   remain in the approved plan. No new planning schema or mapping protocol was added.
2. **Validation parity — reviewed for current settings/interface fields:** editor
   `components/workflow.d.ts` and workflow-settings.tsx expose the same six settings
   keys and six interface types accepted by authoring. A local regression passes
   these fields, input rawReaders/sensitiveFields, task/chat modes, session state
   and viewport through native compilation. No restriction was removed merely
   because another validation layer exists. Remaining limits and node field parity
   still need incremental review as capabilities evolve.
3. **Capability availability:** ToolRegistry currently has Process and MCP sources.
   Better documentation cannot create an absent executor. Use discovered resources
   or CodeAct where suitable; record a real gap before proposing new tools.
4. **Autonomy evidence:** local tests establish discovery, resource packaging,
   configuration and native behavior, not the quality of model choices. Build
   varied authoring evaluations without requiring a particular graph shape.
   Real-provider evaluation still requires separate authorization.
5. **Existing browser checks:** the previous rollback audit found two unchanged
   activity-summary browser tests expecting a different trigger layout. Sidebar
   timing also failed once and passed in isolation. These unrelated UI checks are
   not fixed by this knowledge increment.

## Outcome evaluation contract

The shared overview now explains operation-based capability selection, reusable
inputs and observable task checks. Planner/author Skills point to it; result delivery
preserves execution evidence. This is model guidance, not a new runtime validator.

Evaluate autonomy across these independent dimensions. A scripted model can test
protocols and the evaluator, but cannot establish model decision quality.

| Dimension | Evidence required | Insufficient evidence |
| --- | --- | --- |
| Intent and consent | One-off work stays direct; reuse request produces a proposal; confirmation creates; separate execution authorization | A generated graph alone |
| Capability fit | Selected resources exist and their contracts support the required operation and input format | An instruction promising to perform the operation |
| Native configuration | Saved definition passes native checks and preserves inputs, resource configuration and intended state access | A plausible JSON document |
| Outcome correctness | Observed outputs match independently derived task expectations | completed status, output schema, or the model's self-assessment |
| Reusability | The same saved definition accepts changed inputs and produces their independently expected outputs | Repeating the original sample answer |
| Honest limitations | Missing resources, failed checks and unobserved criteria remain explicit | A success narrative after a tool failure |

Use varied evaluation tasks: exact aggregation, record filtering/deduplication,
language transformation, file generation and an unavailable-capability request.
For each, keep the request, input fixtures, expected facts and comparison rules in
test assets, separate from production Skills. Include malformed/missing input where
meaningful. Unknown source metadata must stay unknown. Evaluate equivalent valid
graphs by behavior, not by required node names, topology or tool choice.

Replay the multi-turn path: direct request; reusable Workflow request without
execution; proposal feedback; confirmation; creation; separately authorized run.
Then change the input and run the same saved definition. Test expectations should
come from fixture logic or an independent reference implementation, not from the
report being evaluated. Record execution failure, incorrect output and missing
observations separately. An unobserved criterion is not a pass.

Current local tests cover role isolation, approval protocols, packaged references,
native configuration, state/tool binding and local file export. They do not yet
supply a complete autonomous multi-task outcome benchmark. Real-provider runs and
external App/MCP behavior remain untested here and need separate authorization;
no evaluation scores should be inferred from documentation changes.

## Maintenance

Update semantic guides with runtime changes and regenerate packaged resources with
`node apps/desktop/scripts/generate-workflow-reference.mjs`. `--check` and build.rs
reject stale referenced assets. Generation proves document/schema consistency;
it does not prove complete editor/runtime parity. Test representative native
configurations and preserve role isolation. No task-specific instructions or
extra step/data mapping declarations belong in this knowledge layer.

### Runnable local outcome grading

`outcome_evaluation.rs` is compiled only for tests. It compares native RunObservation
state using explicit JSON-pointer expectations, with per-check expected/observed
values. It distinguishes incorrect results, missing evidence and failed execution;
empty criteria and missing observations cannot pass. The acceptance test now uses
this grader on actual local Graph executions with changed inputs against a fixed
saved definition. Synthetic cases cover stale numeric answers, structured/text
values, invented metadata and missing versus explicit-null outputs. These test the
grader; they do not establish autonomous task implementation or file correctness.

Run `CARGO_INCREMENTAL=0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
--lib --no-default-features outcome_evaluation` and the same command with filter
`assistant_acceptance_executes_real_expense_rules_and_returns_receipts`. Neither
command calls an external model. The remaining gap is a varied autonomous-authoring
benchmark with independent task fixtures and actual resulting runs.

### Native authoring outcome fixtures

`fixtures/native-outcomes.json` contains numeric boundary, text classification and
boolean routing tasks with eight input/expected-route pairs. These are evaluation
assets, not production instructions. `native_outcome_tests.rs` seeds matching
approved proposals, scripts the author subagent's reference/validation/save calls,
reloads the saved definitions and executes each unchanged definition with varied
inputs through the native compiler and Graph. The harness checks outputs and
observed routes, not a required node-type set. A negative fixture deliberately
saves a structurally valid wrong rule and must be graded incorrect after execution.
All storage is temporary. Creation must return no execution request; the harness
then executes test fixtures separately. Interactive plan feedback and execution
consent remain covered by the existing planning tests rather than this harness.

Run with the Rust test filter `native_outcomes` and `CARGO_INCREMENTAL=0`.
These fixtures establish local authoring/execution/evaluation plumbing across
native input types. They do not test autonomous graph selection, exact computation,
file processing, installed resources or external models. Those remain distinct
coverage gaps; increasing routing fixtures does not close them.

### Task fixtures and offline recorded-output grading

`fixtures/tasks/requests.json` now provides file aggregation, stable deduplication
and exact text-formatting requests, each with changed inputs. Hidden evaluator
answers live separately in `expected.json`; Rust reference operations independently
check them against the fixture inputs. Neither file is packaged into Agent knowledge.
`task_outcome_tests.rs` can grade recorded native states using the actual saved
output contract, with same-definition reuse checks and per-field diagnostics.
See `fixtures/tasks/README.md` for the envelope, command and conversation protocol.
Missing recordings are failures to observe, never successful model evaluations.
Synthetic grader tests do not count as actual authoring/execution observations.
Installed-tool and unavailable-capability evaluations still require isolated
workspace fixtures and are explicitly pending. No provider evaluation was run.

Contract review also clarified two knowledge gaps in `reference/configuration.md`:
workspace discovery uses textual matching/pagination, and Workflow output export
requires declared global output keys. Evidence: `workspace_resources.rs::page` and
`capability.rs::validated_output`. No runtime behavior changed.

### Decision guidance after observed native runs

Read-only operation records showed the planner had read the exact current shared
overview, but still proposed model-only exact processing and creation-only acceptance
criteria. The author discovered model profiles and saved a structurally valid graph
without an executable processing dependency. Native node output contained conflicting
results, and final delivery partially rewrote them. Knowledge availability therefore
was established; decision quality was not.

Planner AGENT and its always-loaded planning Skill now ask for operation-to-executor
feasibility in existing fields, relevant contract discovery, and separate creation
and future-run criteria. Author AGENT and its always-loaded authoring Skill now ask
for semantic review of the actual draft before native validation, including execution,
inputs, outputs, state visibility and failure handling. Routine topology may vary;
substantive approved processing requirements remain binding. Main result delivery
now explicitly surfaces contradictory outputs and distinguishes independent corrections
from the original Workflow result. No new graph protocol, validator or runtime tool
was added. These changes guide the model; they do not prove compliance or guarantee
correctness. Provider-backed evaluation of resulting choices remains outstanding.
