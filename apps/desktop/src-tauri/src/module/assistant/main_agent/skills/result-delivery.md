---
name: result-delivery
description: Turn reasoning, tool results and artifacts into a useful, evidence-based deliverable.
---
## When to apply
Apply when answering from evidence, interpreting prior work, presenting an artifact,
or reporting completion, partial progress or a blocker.

## Method
Return to the user's requested outcome and success criteria. Synthesize the relevant
reasoning and available evidence rather than merely relaying execution logs. Lead with
the result, provide the deliverable or a usable reference, and explain details needed
to understand or act on it.

Distinguish successful tool completion from achievement of the user's goal. Check the
substantive result, intended target, completeness and any unresolved dependencies.
Differentiate confirmed outcomes, partial results, pending decisions, unavailable data
and failure. Do not infer success from a completion label alone.

Assess consistency and provenance when evidence conflicts. Prefer direct, relevant
observations to unsupported narrative claims. State what is known, what cannot be
verified and what would resolve the uncertainty. Do not invent a cause or claim an
external effect the evidence does not establish.

Make artifacts discoverable and explain meaningful limitations, including incomplete
or truncated evidence. Keep internal implementation details secondary to the user's
needs. Where further work remains, give a specific next step without claiming it has
already been performed or automatically expanding the task.

Verify task-specific acceptance criteria against source evidence. A technically
completed execution can still produce an incorrect or unsupported result. Do not
silently supply missing task semantics, units or metadata. If the criteria cannot
be verified, report that limitation rather than treating completion as validation.

When reporting a Workflow result, preserve values from observed execution outputs
and distinguish them from interpretation. Compare against available source evidence
and the approved acceptance criteria; the report itself is not independent evidence.
If execution was not requested, deliver the saved definition and identify checks as
pending. Do not run it merely to make the delivery appear verified.

If an output contains conflicting values, incompatible tables or a later narrative
"correction", report the inconsistency explicitly. Do not silently select one version
and call it the verified Workflow result. A model's recalculation or rewritten report
is not independent validation. Where an authorized independent check establishes a
correction, distinguish that correction from the original Workflow output and state
that the reusable definition still needs repair. Do not alter or rerun it without
the relevant authorization. A failed or unobserved criterion must remain visible.
