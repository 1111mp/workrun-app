# Task outcome evaluation assets

These test assets are not packaged as Agent knowledge. `requests.json` contains
three tasks and two inputs per task. `expected.json` is evaluator-only; never put
it, reports or reference implementation code in a model request. Synthetic file
fixtures contain no user data. No fixture requires a particular graph or executor.

## Conversation and observation protocol

1. Give the main Agent `request` and the first input/attachment. Let it handle the
   one-off task. File fixture paths are local test assets, not model-readable host
   paths: import them into the temporary ArtifactStore and provide actual references.
2. Send `workflowRequest`. Record planning discovery and the proposed method. No
   Workflow should be saved or run before native plan confirmation.
3. Give material feedback (for example, require missing units to remain unknown),
   review the revised proposal, then confirm using the native plan interaction.
   Save the actual approved version and authoring receipts. Creation must not run.
4. Separately authorize execution with the first input. Retain native run identity,
   full state and the saved definition, not merely the model's final report.
5. Change the input using the second run. Reuse the same saved Workflow identity
   and document; no regeneration or sample-result substitution is allowed.

Outcome grading does not prove this conversational protocol was followed. Review
its transcript/checkpoint evidence separately. Current local routing and approval
tests cover parts of that protocol; no autonomous provider run has been made for
these task fixtures.

For a selected-tool evaluation, first discover an actual read-only tool and its
contract in an isolated test workspace, then define a task with independently
known inputs/outputs. For a capability-gap evaluation, use an isolated workspace
that provably lacks the requested executor and confirm the agent reports the gap
without inventing dependencies, saving a misleading Workflow or executing effects.
These two scenarios are not implemented by the three task fixtures and must not
be reported as covered. Tool summaries alone do not establish call success.

## Offline grading

Set `WORKRUN_TASK_RECORDINGS` to a JSON file containing an array with one entry per
case and run (six total):

```json
{
  "caseId": "file-aggregation",
  "runIndex": 0,
  "workflowId": "actual-saved-workflow-id",
  "document": {"settings": {}, "nodes": [], "edges": []},
  "status": "completed",
  "error": null,
  "state": {"global": {}}
}
```

The document/state above illustrate the envelope only; use the actual saved native
configuration and execution state. The grader invokes native capability output
export, then compares declared outputs to the hidden oracle. JSON text fields
ending `_json` are parsed before comparison, so formatting/key order do not cause
false failures. Other text is exact. Missing/duplicate runs, missing outputs,
failed execution and changed saved definitions cannot pass. Artifact existence or
file contents are not graded by this runner; file aggregation grades computed
output from input files, not generated artifacts.

Run from the repository root:

```sh
CARGO_INCREMENTAL=0 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --no-default-features task_outcomes_grade_recorded_native_runs -- --ignored --nocapture
```

This command only reads recordings; it neither invokes models nor executes a
Workflow. It prints per-field diagnostics and fails on unmet expectations. Its
report always says `autonomyEvaluated=false`: outcome evidence alone does not
measure intent, resource choice or approval behavior. Unexecuted cases remain
unobserved, not successful.
