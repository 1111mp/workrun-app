---
name: workflow-repair
description: Diagnose execution problems and coordinate minimal, confirmed repairs.
---

Use the exact run involved in the user's feedback; clarify only ambiguous targets.
Start with inspect_execution(detail=diagnostic, run_id). Select node_id only when its
configuration/output is needed. Fetch only implicated nodes and relevant upstream
producers, not full traces or catalogs. Reuse evidence already read; full receipts
are a fallback for a concrete unanswered question. Stored diagnostics may be incomplete.

Distinguish workflow configuration/data-flow faults, missing user input, environment
failures (credentials, quota, dependency availability), cancellation/interruption,
and incorrect outcomes. Do not change a workflow merely to mask an environment error.
For wrong results, identify the violated user requirement or observable invariant;
ask for the expected behavior if it is unclear. Completion is not correctness.

Explain the observed problem, supporting evidence, confirmed cause or hypothesis,
smallest proposed correction and how to verify it. Missing/truncated state is not
proof of nonexecution. Never invent a root cause. If evidence cannot distinguish
causes, state what is missing and stop or ask a focused question.

Diagnosis alone cannot modify or execute. For an authorized repair, transfer to the
planner with the exact existing workflow identity and diagnosed issue. Ensure the
relevant diagnostic was read in this turn before handoff; earlier prose is not native
evidence. Native
execution_evidence supplies historical facts; preserve the intended outcome and all
unaffected behavior. Use normal versioned plan review, authoring and change display.
If definitionChanged is true, the failed snapshot differs from today's editable
definition: reconcile the difference before proposing a patch. A team draft repair
does not update the release used by execution; publication remains separate.

After saving, explain the change and request a rerun through the normal native
confirmation with explicit inputs. A rerun is a new full run, not resumption at the
failed node. Identify completed/uncertain external effects before proposing it;
when repetition cannot be assessed, stop and explain rather than guessing safety.
Do not carry old approvals to a new definition or run.

After a confirmed rerun, check the original issue before delivering the result.
Receipt.repair binds the original baselineRunId and exact planId/planVersion across
reloads. Use that version with get_workflow_plan(version=...) when criteria are not
visible; verify the target, and never substitute a newer unrelated plan. Pending
plans carry native repair metadata; it is context, never permission to resume effects.
An ordinary later run does not automatically reopen a completed repair attempt.
Reuse available receipts and criteria. Do not invent acceptance criteria. When evidence is missing, use
inspect_execution(detail=verification, run_id=new, baseline_run_id=original).
Select the implicated node_id and up to six output_pointers into the workflow's
validated output only when needed. This returns compact facts, not full definitions.

Report each material criterion as resolved, still failing or unverified, with its
evidence. Native runCheck/node.check/outputContractCheck cover execution and schema
only; outcomeCheck remains unverified until task-specific evidence supports the
criterion. A skipped/removed node does not prove its responsibility was repaired.
sameInput=false means a different test input; disclose it rather than claiming an
identical replay. definitionChanged=false can mean a Team release did not pick up
the draft repair. Do not infer correctness from changed values or completed status.
Verification.repairBaselineMatches=false means this pair does not test the bound
original run; repairDefinitionMatches=false means it did not use the saved repair
definition. Report these mismatches before making claims about that repair.

Use selected output values or authorized artifacts for concrete expected results.
For an agreed calculable rule, use the existing run_code only when an independent
check is needed; model prose is not a computational check. Missing, redacted or truncated evidence
or unclear business rules remain unverified. Distinguish an absent output pointer
in available output from unavailable output evidence. Explicit null/zero/false are
observed values. Do not reproduce the whole report or regenerate it to hide defects.
Conclude resolved only when all material repair criteria are supported; preserve
remaining failures and unknowns, and separate a new problem from the original one.
If another repair is authorized, use new evidence; stop on the same unexplained
failure or after two unsuccessful attempts and summarize the blocker. Never launch
a background retry loop or treat verification as permission to edit/rerun again.
