---
title: Human review and resume
description: Pause a run where a person must be accountable, then continue safely from a checkpoint.
---

Not every step should run automatically. Put a person in charge when a flow sends external content, changes production data, handles high-risk classification, or uses a high-privilege tool.

## Configure Human Review

1. Drag **Human Review** from the node palette and connect it to the step that needs a decision.
2. In **Review request** in the right inspector, enter a clear title and description.
3. Set **Content key** to the state field under review, for example `recommendation`.
4. Add the fields a reviewer needs as **Context keys**, for example `category, priority, source_url`.
5. Turn on **Allow editing** when the reviewer should be able to revise the content.
6. Connect both approved and rejected outputs; do not only connect approval.

When a run reaches this node, its state is written to a local SQLite checkpoint and the run panel shows “Waiting for input.” Once a reviewer submits a result, Workrun continues from that checkpoint without rerunning completed nodes.

## Configure Ask User Question

Use **Ask User Question** when a user must choose a path rather than review content. Enter the question, optional context, and choices. Each choice maps to a canvas output. Its identifier stays stable even if you later change the visible label, so saved branches do not break.

Tool calls can also require confirmation every time. If the user rejects a call, the reason is returned to the Agent so it can try an alternative rather than failing silently.

For every review, make three things explicit: what the reviewer sees, what they can do, and how the flow proceeds after rejection.

> **Media placeholder · video `human-review/01-pause-edit-resume.mp4` (30–45 seconds)**  
> Pause at Human Review, inspect context, edit the recommendation, approve it, and show the flow continuing from the checkpoint rather than rerunning.
