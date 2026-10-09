---
title: Runs, debugging, and traces
description: 'Build an evidence trail from every run: locate the failed node, inspect inputs and side effects, then recover or fix automation safely.'
---

A run is not only “successful” or “failed.” Workrun keeps the workflow snapshot, state changes, node events, model and tool activity, Python logs, and runtime diagnostics in the run workspace. Use that record to answer one concrete question: **where did this run stop, with which inputs, after which result, and what should change next?**

Do not reverse-engineer a cause from the final answer. Build the evidence trail first, then change a prompt, code, schema, permission, or model configuration.

## After a failure, narrow the scope in five steps

1. Open this run from run history and confirm its workflow version, run input, and start time. Do not mix it with another workflow revision or chat turn.
2. In the node timeline, find the last node that is not complete. It is the investigation starting point, not necessarily the root cause.
3. Inspect the events around that node. Confirm that upstream nodes actually published the state it needs and that it has permission to read it.
4. Inspect evidence for the node type: model messages and tool activity for an Agent; stdout, stderr, and structured result for a Process App; field values and the selected exit for a condition.
5. Confirm external side effects before resuming or retrying. After fixing configuration or code, run the same input again and add reproducible issues to an evaluation suite.

This sequence separates “what happened” from “what to change”: establish facts first, then choose the change.

![Run history inside one workflow: the health overview shows run count, success rate, P95 duration, and model tokens; each run can open its output.](/media/runs/01-workflow-run-history.png)

Within one workflow, run history shows both health over a time range and the status, duration, and tokens for every execution. Select the run to investigate here, then choose **View output** to enter its run workspace.

## Read the run status before taking action

| Status                      | What it means                                                       | Next step                                                                                                              |
| --------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `queued` / `running`        | The run is queued or still executing.                               | Wait for more events. If no events arrive for an unusual time, inspect timeouts on the active model or tool.           |
| `waiting_for_input`         | Human review, a question response, or tool confirmation is pending. | Complete the action in the run panel; do not treat it as a failed run.                                                 |
| `completed`                 | This execution has ended.                                           | Check final state and diagnostics. If the result is wrong, trace upstream from the node that produced the wrong value. |
| `failed`                    | A node or runtime step could not complete.                          | Read the error and cleanup/cancellation evidence, then Run again to create a new task.                                 |
| `cancelled` / `interrupted` | A person cancelled it, or the app stopped during execution.         | Do not assume it had no effect. Check the last event and external system before starting another run.                  |

> Waiting for input is a resumable pause. Failed or stopped tasks must Run again; only application-interrupted tasks can recover their original checkpoint.

![Global run history: saved workflow and App runs can be filtered by target type, task or chat mode, and statuses such as queued, running, needs attention, and failed.](/media/runs/02-all-run-history.png)

Global **Run history** combines local workflow and App executions. When a run’s source is unclear, or when you need to find interrupted and failed App runs, filter by name, target type, mode, and status before opening its output.

## The run workspace: what each piece of evidence answers

| Evidence                             | Ask first                                                                                   | Common conclusion                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Node timeline and events             | Which node stopped? In what order did completion, waiting, and failure occur?               | The issue belongs to an Agent, App, tool, condition, or human action.                    |
| Run input and upstream state         | Are input keys, types, and values correct? Did an upstream node publish the required field? | A required value is missing, a key differs, or the downstream node lacks read access.    |
| Model messages and structured output | What did the Agent actually see? Does its output meet the contract?                         | Prompt, model configuration, structured schema, or state boundary needs adjustment.      |
| Tool activity                        | Were parameters, approval, limits, and returned shape correct?                              | Tool description, state binding, permission, or the service needs repair.                |
| Process App stdout / stderr          | Where did Python fail? Did it return the expected JSON?                                     | Dependency, environment, business logic, or App data contract is wrong.                  |
| Final state                          | Which fields actually reached workflow output and downstream nodes?                         | A value was not published, was overwritten, or sensitive-data visibility needs redesign. |
| Runtime diagnostics                  | Which node, model, or tool used time, tokens, or calls?                                     | Limit tool calls, shorten context, select another model, or investigate a bottleneck.    |

The record preserves the target snapshot, final state, and event sequence for this run. Anchor your investigation to that evidence before changing the current draft; otherwise it is hard to know whether a change solved the same problem.

![Final state in workflow run output: global state shows published keys, while node state retains each node’s private output so you can verify which values reached downstream steps.](/media/runs/03-workflow-final-state.png)

Inspect global state first to confirm that workflow outputs and downstream dependencies exist. Then expand node state to trace a value to its producer. The messages and ticket ID shown are demonstration data; treat sensitive fields according to state access and redaction rules in real runs.

## Diagnose by node type

### Agent: inspect input before the decision

Check that the Agent uses a configured model and sees the required input, that its instructions state tool-use conditions and output boundaries, and that structured output conforms to its schema and publishes fields needed downstream. If results vary, run the same input several times before changing the prompt, model, or acceptance rule.

Do not stop because a natural-language response looks plausible. Conditions and downstream nodes should use stable structured fields, not inferred values in a response.

### Tool Apps, MCP, and remote tools: inspect the call boundary

First confirm the tool is enabled in that Agent’s tool list and its name, description, and Agent instructions explain when to use it. Then verify that arguments come from intended authorized state keys, confirmation/limits/timeouts allow the call, and the returned value matches its declared schema—not only that a service returned HTTP success. For a Tool App, inspect its stdout and stderr too.

For a tool that sends, writes, or deletes, confirm in the external system whether the action already happened before retrying.

### Process Apps: keep logs and returned data separate

Process App stdout and stderr are debugging evidence; `process.result({...})` is the structured result passed to the workflow. Check code execution, dependencies and environment, the returned App contract, and whether keys needed downstream are published on the node.

When an App works independently but fails in a workflow, check workflow-state input, read access, and published output keys before changing Python code. See [Use Python Apps](/guides/python-apps/).

### Conditions, state, and human nodes: inspect visible data, not guessed routing

A condition should read an explicitly published stable field. When routing is wrong, inspect the producing output, publication setting, condition key, and the exit actually selected. Human review and questions pause at a checkpoint; once resolved, the run continues without rerunning completed nodes.

For state boundaries, redaction, and checkpoints, see [Workflows and state](/concepts/workflows-and-state/).

## Remote Agents: distinguish local Stop from remote completion

After workflow failure or user Stop, Workrun sends one best-effort `CancelTask` request for unfinished remote calls with a known task ID, without runtime confirmation. Node messages show the request and returned status without replacing the original error. Known terminal tasks are skipped; submissions without a task ID remain unknown and are not automatically resubmitted.

A failed or timed-out cancellation is shown as unconfirmed. There is no preliminary query, automatic polling, cancellation retry, or startup continuation of cancellation. Failed or stopped tasks must Run again. Application-exit interruptions retain their existing recovery path. Remote cancellation does not promise business undo. See [Remote Agents and A2A task handling](/guides/remote-agents/).

## After App compensation, fix the problem and run again

When a workflow fails, successful App calls with a compensation entry are cleaned up automatically, including successful Tool App calls inside an Agent. Check compensation status in the corresponding node messages and verify unfinished or unknown resources. Once cleanup starts, checkpoint continuation cannot reuse cleaned-up results. Fix the problem and choose Run again to create a new task for a fresh business execution; the original retains failure and cleanup evidence.

Stop and normal completion do not trigger automatic cleanup. See [App failure compensation](/guides/app-compensation/) for configuration and exception handling.

## Confirm side effects before recovering from a checkpoint

Only application-interrupted tasks can recover from a checkpoint. Failed or stopped tasks use **Run again**, which creates a new business execution; it does not resume their checkpoint.

For an application-interrupted task, Workrun checks the checkpoint and operation journal before recovering in the original task. Saved results can be reused; unknown outcomes require reconciliation and cannot be blindly submitted again. Unsupported recovery contracts block continuation.

After a workflow failure, inspect the failed node and the automatic App cleanup or remote cancellation messages. Verify external resource state before choosing **Run again**: a new task repeats business execution and does not undo effects left by the previous task.

## Use runtime diagnostics to find slow and expensive work

![Runtime diagnostics in run output: workflow nodes, model calls, and tool calls are listed with status, token use, and duration.](/media/runs/04-runtime-diagnostics.png)

Diagnostics list workflow-node events, model calls, and tool calls for the same node separately. For example, compare an Agent’s model usage with the duration of the `lookup_order` tool to determine whether the bottleneck is the model, tool, or Process App.

**Runtime diagnostics** summarize workflow nodes, tool calls, and model calls with duration and status. When the Provider returns usage, they also show input, output, and total tokens plus estimated cost. Use them to determine whether a model call became slow, a tool is timing out, calls are excessive, or token growth comes from context, output, or reasoning.

Return to events and inputs for a one-off anomaly. For a repeated pattern, use an evaluation suite or version comparison. See [Evaluations and quality gates](/quality/evaluations/) for batch regression checks and publishing gates.

## Connect traces to your observability system

The run workspace remains the first source of evidence for one execution. To investigate Workrun together with other team services, enter an OTLP/gRPC collector endpoint in **Settings → Logs**. Saving a new endpoint requires an app restart before it takes effect.

Before configuring export, confirm that the collector and network policy allow only intended recipients, traces do not contain sensitive content or credentials that must not leave the device, and a non-sensitive run in an isolated environment verifies connection, fields, and retention first.

OTLP is a diagnostic export. It does not replace local run records, state boundaries, or inspecting individual results.
