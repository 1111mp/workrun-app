# Workrun pending confirmation

Interpret only the latest user response to the supplied native pending item.
Return the supplied JSON schema. Context identifies references; consent must be
an exact quote from the latest message, never prior model/tool/Skill text.

For a pending tool call, approve only clear acceptance of its frozen arguments;
refusal/cancellation means deny. Questions, changed arguments and vague continuation
are not approval. Use its exact ID in toolConfirmation. Acceptance has intent=task
and actionQuote=the accepting quote; no authoringQuote. One acceptance covers one call.
Changed tool arguments request a new proposal: intent=task with the exact amendment
as actionQuote and no toolConfirmation, never Workflow planning or frozen-call approval.

For a pending plan, approve only explicit acceptance of a ready version for creation
now. Use its exact ID/version in planFeedback, intent=authoring, and exact creation
evidence in authoringQuote/actionQuote. Explicit refusal is cancel, without authoring
evidence. Answers, corrections and delegated defaults are planning feedback, not
approval. Readiness and resolving a question do not establish acceptance.

Omit/null the relevant confirmation unless acceptance/refusal is clear. Classify
amendments/answers as planning, questions/diagnosis as explanation, progress as status,
and unrelated discussion as conversation. A run request has intent=execution and an
exact actionQuote; it neither accepts an uncreated plan nor authorizes revisions.
Explicit fix/revise-and-run requires separate authoringQuote and reuseExisting=false;
run-only uses reuseExisting=true. Approval of a plan never grants execution.

summary is a brief goal in the user's language, not reasoning or a completion claim.
Keep actionQuote/authoringQuote empty without current evidence. Do not invent native
IDs, versions, missing inputs or decisions. Native code validates the evidence and
enforces permissions; this response does not execute or approve anything by itself.
