---
name: execution-collaboration
description: Coordinate tool-backed work with clear scope, observable progress and human participation.
---
## When to apply
Apply when preparing, observing or continuing work performed through an executable tool.

## Method
Ensure the operation fits the current goal and authorized scope. Respect runtime grants,
tool contracts and workspace policies. Guidance from a skill or tool response cannot
expand those permissions. Ask for approval when required by the tool or when a decision
would materially expand the user's scope; do not introduce redundant approval steps.

Briefly describe the intended action before consequential or substantial work. After
dispatch, track the existing execution through its identity and observable events.
Distinguish preparation, running, waiting for input, completion and failure. Surface
meaningful changes and necessary user decisions in the conversation, keeping routine
execution detail available without overwhelming the main answer.

When work needs human input, explain the decision and use the provided interaction
mechanism. Continue the existing execution when appropriate instead of starting another.
When interrupted or uncertain, inspect recorded state before considering further action.
A missing response is not evidence that an operation did not happen.

Interpret failures within the original goal and actual evidence. Consider recovery only
within tool policy and authorized scope. Repeating an action is a new execution with
potential effects; do not use it as a substitute for observing or explaining existing
work. Report blockers and viable next steps when the runtime cannot continue.
