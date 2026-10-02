---
title: Human review and resume
description: Pause a workflow for an accountable decision, edit an approved text draft when appropriate, and continue from the saved checkpoint.
---

Use a human checkpoint where the cost of an incorrect automated action is higher than the cost of asking someone. Typical examples are approving an external reply, choosing a production target, handling a sensitive classification, or allowing a consequential tool call.

Workrun has three different controls. Choose the one that matches the decision—not every pause is a review.

| Need | Use | What continues the run |
| --- | --- | --- |
| A person must approve, reject, or revise a draft | **Human Review** | Approve or reject; an approved text draft can be edited |
| A person must choose the next path | **Ask User Question** | One selected option |
| An Agent wants to execute one tool call | Tool confirmation | Approve or deny that tool call |

## Before you add a checkpoint

Decide what the person needs to see and what should happen for **every** outcome. The values named in a Human Review node must be available in workflow State when the run reaches it. Keep the review small: show the decision itself as the content, and only the facts needed to judge it as context.

This guide uses an Agent that produces a customer-facing reply in `reply_draft`, with supporting fields `customer_tier`, `case_priority`, and `order_status`.

```text
Start → Draft reply → Human Review → Send approved reply → End
                              └──→ Record rejection → End
```

The `reply_draft` and supporting fields must be available to the review node. If an earlier node produces them privately, publish the required values to global State or grant the review node the appropriate State access first. See [Workflows and State](/concepts/workflows-and-state/) for the visibility model.

## Configure Human Review

1. Drag **Human Review** from the node palette onto the canvas and connect the producing node to it.
2. Select the node. Under **Review request**, enter a title and description that tell the reviewer exactly what they are deciding.
3. Set **Content key** to `reply_draft`. This is the primary value shown in the review dialog.
4. Set **Context keys** to `customer_tier, case_priority, order_status`. Context is displayed as read-only JSON beneath the draft.
5. Turn on **Allow editing** only when the content key contains text the reviewer may safely revise. An approved edit writes back to that one content key; it does not allow editing arbitrary workflow State.
6. Connect the **Approved** handle to “Send approved reply” and the **Rejected** handle to “Record rejection.” Save the workflow.

| Field | Example | Why it matters |
| --- | --- | --- |
| Title | `Approve customer reply` | Identifies the decision in the approval queue |
| Description | `Check accuracy, tone, and whether the reply promises anything we cannot deliver.` | Gives the reviewer an accountable standard |
| Content key | `reply_draft` | The value to review; editable only when it is text |
| Context keys | `customer_tier, case_priority, order_status` | Read-only facts needed to make the decision |
| Allow editing | On | Lets an approved revision replace `reply_draft` |

> **Route both outcomes.** If an Approved or Rejected output has no connection, that outcome stops the run. A rejection is not an error path by default; make it an intentional path, such as recording the reason, notifying an owner, or ending safely.

## Run, review, and resume

Run the workflow with a small test case. When it reaches the checkpoint, the run becomes **Waiting for input** and Workrun opens an approval item.

The reviewer sees the configured title and description, the content value, and the selected context. For a text content value with editing enabled, the draft is editable. Choosing **Approve & continue** persists the decision and any edit, then follows the Approved output. Choosing **Reject** follows the Rejected output.

![Human Review dialog showing editable review content, read-only context, and rejection or approval actions.](/media/workflows-and-state/03-review-checkpoint.png)

The run resumes from its durable checkpoint: completed upstream nodes are not run again. Verify this in the run panel by checking that the earlier node retains its completed result and that only the selected downstream branch runs.

## Ask a question when the person chooses the path

Use **Ask User Question** for a choice, not a review. For example, after a deployment plan is prepared, ask “Where should this release go?” with options **Staging** and **Production**.

1. Add **Ask User Question** and connect the upstream node.
2. Set the question and optional description shown before the choices.
3. Add the choices the person may select. Give each a clear label and, when useful, a short description of its consequence.
4. Connect each option's output handle to its matching branch, then save.

```text
Prepare release → Ask User Question
                         ├── Staging    → Deploy to staging → End
                         └── Production → Human Review → Deploy to production → End
```

![Ask User Question dialog with a question, context, and branching options.](/media/human-in-the-loop/01-ask-user-question.png)

Each option has an internal identifier that remains stable when you change its visible label. This keeps existing branch connections intact. The selected option is validated before the workflow resumes, so an arbitrary answer cannot route the run to a different branch.

## Tool confirmation is narrower than review

Turn on human confirmation in an Agent tool's settings when each invocation needs consent—for example, before sending an email, creating a ticket, or modifying a record. The confirmation dialog shows the requested tool and its input; approval runs that call and rejection returns the decision to the Agent. It does not create Approved/Rejected canvas branches. Combine tool confirmation with a Human Review when both the generated content and the side effect need independent scrutiny.

## Verify and troubleshoot

| Symptom | Check first |
| --- | --- |
| The review content or context is empty | Confirm the named State keys exist when the review node starts and that the node is allowed to read them. Check spelling and case. |
| The draft cannot be edited | **Allow editing** must be on, **Content key** must be set, and that value must be text. Objects and arrays are displayed read-only. |
| The run stops after a decision | Connect the matching output handle. An unconnected Approved, Rejected, or question-option output ends that path. |
| The wrong branch runs after a question | Check that each canvas connection originates from the intended option handle, not merely from the node body. |
| A completed step runs again | Use the pending approval's **Approve**, **Reject**, or choice action to resume. Starting a new run or replaying a run is different from resuming its checkpoint. |
| A sensitive value is visible to a reviewer | Remove it from **Context keys**, restrict State access, and rerun with test data. Review dialogs should include only what is needed for the decision. |

For a full workflow that combines branching and human review, see [Build your first workflow](/guides/build-a-workflow/). For State publication, access, and persistence details, see [Workflows and State](/concepts/workflows-and-state/).
