---
title: Remote Agents and A2A task handling
description: Connect a Remote Agent and understand automatic task queries, cancellation, unknown results, and restart behavior.
---

A Remote Agent node calls an external Agent through A2A. Workrun runs the workflow locally; the external service owns its remote task. A workflow can fail while that task is still running, or after it has already completed.

Workrun automatically checks unfinished remote tasks after workflow failure or user Stop. No execution-time confirmation is required. Progress appears in the corresponding node’s messages, while the original workflow error remains visible.

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

Workrun stops subsequent local scheduling and persists automatic handling for unfinished original remote calls, including calls in parallel branches. It queries the remote task first:

| Remote situation                                               | Automatic handling                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Submitted, working, awaiting input, or awaiting authentication | Attempt cancellation once; retain the returned status                            |
| Completed                                                      | Fetch and save the result; do not cancel                                         |
| Failed, canceled, or rejected                                  | Record the terminal state                                                        |
| Query fails or cancellation response is lost                   | Keep the result unconfirmed; query again later                                   |
| No task ID was received                                        | Keep submission unknown; do not automatically resubmit                           |
| Task is not found                                              | Show the unconfirmed outcome; absence is not proof that no side effects occurred |

A cancellation request is not proof of cancellation. If the service reports that the task is still working, Workrun continues querying. Failed or nonterminal checks are scheduled again at approximately 30-second intervals while the application is open. Other pending remote tasks can still be processed.

## Read the node messages

For example, one parallel branch fails while a Remote Agent is working:

```text
Remote task: Checking task status…
Remote task: Cancellation requested; awaiting confirmation
Remote task: Canceled
```

If the remote task finished before the query, the message instead shows **Completed; result saved**. The workflow still retains its original failure; remote completion does not make the whole workflow successful.

While termination is pending, same-task continuation is blocked to avoid racing recovery against cancellation. Once cancellation has been attempted, automatic forward recovery is suppressed. **Run again** creates a new business execution; check unknown outcomes before deliberately repeating work that may already have taken effect. See [Runs, debugging, and traces](/quality/runs-and-traces/).

## Exit and restart

Pending task handling and cancellation intent are stored locally. Exiting Workrun pauses local handling; reopening it resumes outstanding checks. This does not stop the remote service, which may continue its task while Workrun is closed, and it does not provide a local background process.

Application-exit interruption is treated separately from explicit Stop or workflow failure. Interrupted runs retain the existing recovery path rather than automatically receiving cancellation. Automatic failure/Stop handling applies to tasks created with this capability; upgrading does not retrospectively cancel old failed runs.

Workrun saves the cancellation-attempt marker before sending the request. If it exits between those actions, the remote task may continue running. After restart, the current implementation only queries and does not send another cancellation attempt.

## A2A protocol versus Workrun policy

A2A defines task queries and cancellation. `GetTask` retrieves status and artifacts; `CancelTask` attempts cancellation and can return `TaskNotCancelableError` or `TaskNotFoundError`. See the official [Get Task](https://a2a-protocol.org/v1.0.1/specification/#313-get-task) and [Cancel Task](https://a2a-protocol.org/v1.0.1/specification/#315-cancel-task) definitions.

The protocol defines cancellation as idempotent, but message submission is only optionally idempotent. Workrun’s current one-cancellation-attempt policy is a local implementation choice, not an A2A restriction. See [A2A idempotency](https://a2a-protocol.org/v1.0.1/specification/#331-idempotency).

A2A has no standard parent-workflow-failed notification or business-compensation operation. Canceling a running task does not promise to retract a completed publication or delete resources already created. Workrun does not automatically generate undo instructions for completed Remote Agent tasks. Local Process Apps and Tool Apps can instead supply their own cleanup entry; see [App failure compensation](/guides/app-compensation/).
