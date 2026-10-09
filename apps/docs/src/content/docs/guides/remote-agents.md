---
title: Remote Agents and A2A task handling
description: Connect a Remote Agent and understand best-effort cancellation after workflow failure or Stop.
---

A Remote Agent node calls an external Agent through A2A. Workrun runs the workflow locally; the external service owns its remote task. A workflow can fail while that task is still running, or after it has already completed.

After workflow failure or user Stop, Workrun automatically sends one best-effort cancellation request for remote tasks with a known task ID and a nonterminal local status. No execution-time confirmation is required. The request and returned status appear in the corresponding node’s messages, while the original workflow error remains visible.

## Configure a Remote Agent

1. Add a **Remote Agent** node and enter the A2A service URL. The service must expose an Agent Card and a compatible A2A 1.0 JSON-RPC interface; an ordinary chat API URL is not sufficient.
2. Configure the node’s authorized state input, including any business instructions the service expects. If needed, add attachment paths for files to send.
3. Select the service’s authentication: none, a saved Bearer credential, or a saved API-key credential with its header name. Credentials are associated with the service origin; keep secrets out of prompts and workflow input.
4. Use the connection test to check discovery and authentication. The test does not submit a business task.
5. Set the request timeout if needed: the default is 120 seconds, with a supported range of 1–600 seconds. Save and run the workflow.

The implementation uses the A2A JSON-RPC interface; this guide does not imply support for every A2A transport or optional feature.

## During normal execution

```text
Submit the message
 → Persist the remote task ID when received
 → Receive progress and results
 → Save the result locally
 → Continue to the next workflow node
```

Saved successful operation results can be reused when the same logical operation is recovered. A connection timeout or lost stream does not prove that remote business work failed. When a task ID is available, Workrun can query the original task instead of submitting the business request again.

## After workflow failure or Stop

Workrun stops subsequent local scheduling and uses the saved remote records to identify unfinished original calls, including calls in parallel branches. It sends `CancelTask` directly, without a preliminary status query:

| Saved local situation                                                               | Automatic handling                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Task ID available; submitted, working, awaiting input or authentication, or unknown | Send one cancellation request; show the returned status   |
| Completed, failed, canceled, or rejected                                            | Skip cancellation                                         |
| No task ID was received                                                             | Show submission unknown; do not cancel or resubmit        |
| Cancellation request fails or times out                                             | Show cancellation unconfirmed; do not automatically retry |

A cancellation request is not proof of cancellation. The service may return a task that is still working, or report that it finished before cancellation arrived. Workrun displays that response without polling for a later state. One request failure does not prevent cancellation of independent calls.

## Read the node messages

For example, one parallel branch fails while a Remote Agent is working:

```text
Remote task: Requesting cancellation…
Remote task: Canceled
```

If the request fails or times out, the message shows **Cancellation unconfirmed: request failed or timed out; no automatic retry**. The workflow retains its original failure; the remote response does not make the whole workflow successful.

Failed or stopped workflows cannot continue their original task; **Run again** creates a new business execution. Application interruptions retain their separate recovery path. See [Runs, debugging, and traces](/quality/runs-and-traces/).

## Exit and restart

Cancellation messages and remote task records are stored locally. If Workrun exits before a cancellation request completes, the remote task may continue running. Reopening Workrun does not resume this cancellation, poll for its outcome, or send another cancellation request.

Application exit alone does not trigger `CancelTask`. Interrupted runs retain their existing recovery path, separately from best-effort cancellation after failure or Stop. Current cancellation handling does not scan historical failed tasks on startup.

## A2A protocol versus Workrun policy

A2A defines task queries and cancellation. `GetTask` retrieves status and artifacts; `CancelTask` attempts cancellation and can return `TaskNotCancelableError` or `TaskNotFoundError`. See the official [Get Task](https://a2a-protocol.org/v1.0.1/specification/#313-get-task) and [Cancel Task](https://a2a-protocol.org/v1.0.1/specification/#315-cancel-task) definitions.

The protocol defines cancellation as idempotent, but message submission is only optionally idempotent. Workrun’s current one-cancellation-attempt policy is a local implementation choice, not an A2A restriction. See [A2A idempotency](https://a2a-protocol.org/v1.0.1/specification/#331-idempotency).

A2A has no standard parent-workflow-failed notification or business-compensation operation. Canceling a running task does not promise to retract a completed publication or delete resources already created. Workrun does not automatically generate undo instructions for completed Remote Agent tasks. Local Process Apps and Tool Apps can instead supply their own cleanup entry; see [App failure compensation](/guides/app-compensation/).
