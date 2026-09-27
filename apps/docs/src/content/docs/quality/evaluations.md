---
title: Evaluations and quality gates
description: Validate workflow changes on real cases and stop regressions before publishing.
---

Evaluation Lab runs a workflow over an evaluation suite in bulk. Each case stores its decision and reason for failure, helping you distinguish occasional model variation from an actual regression. Evaluation input becomes the initial workflow State for that run.

## Create your first evaluation suite

1. Open **Evaluation suites** in a workflow.
2. Create one named “Customer feedback classification regression” and describe its scope.
3. Create a Case with a name, description, and **Input JSON**.
4. Add expected results in **Validation rules**. You can validate final output fields or final output text.
5. When safety matters, add **Safety assertions** listing field paths or text that must not appear.
6. To verify that an Agent used a tool or followed the correct branch, add tool trace, node-path, or branch-hit assertions.
7. Save and run the suite, then inspect the evidence and failure reason for each Case.

Example input JSON:

```json
{ "feedback": "The CSV exported after the upgrade cannot be opened, and Finance must reconcile accounts this afternoon." }
```

One rule can require final output field `priority` to equal `high`, require the node path to include “Classify and recommend,” and forbid an unauthorized phone-number field in the final output.

## Recommended loop

1. Collect real inputs covering common, edge, and high-risk cases.
2. Define an observable expected result and scoring standard for every case.
3. Run the suite in bulk after changing a prompt, node, model, or tool.
4. Compare versions to find new failures, fixes, and unchanged cases.
5. Before publishing, require key conditions through a quality gate. Record a reason for any manual waiver.

Evaluations store the corresponding workflow snapshot, so draft changes are never mistaken for the result of a published version.

## Configure a publishing quality gate

Open **Publishing quality gate** on the same page:

- Turn on **Require at least one evaluation**.
- Set a minimum pass rate, maximum cost, and maximum duration.
- Choose critical suites in **Required evaluation suites for publishing**.
- Save. When publishing, Workrun reads the latest evaluation for the current candidate workflow snapshot.

If it does not pass, you can explicitly confirm a bypass and write a reason. That is an auditable exception, not the usual substitute for fixing the problem.

> **Media placeholder · video `evaluations/01-create-case-and-gate.mp4` (60–90 seconds)**  
> Create a suite, add a Case with JSON input and a field assertion, run it, inspect failure evidence, and set a minimum-pass-rate quality gate.
