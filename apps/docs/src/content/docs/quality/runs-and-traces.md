---
title: Runs, debugging, and traces
description: "Use the run panel and traces to answer: What happened in this automation run?"
---

The run panel streams node status, model messages, tool inputs and outputs, script logs, and traces. When something fails, locate the exact node and event first, then decide whether the prompt, code, schema, tool permission, or model profile needs changing. Every run retains its execution plan, final state, and key events.

## Read the run panel

| Area | Question it answers |
| --- | --- |
| Node timeline | Which node is blocked? Did it fail, wait for input, or finish? |
| Model messages | What did the Agent receive, which tools did it call, and how did it answer? |
| Tool inputs and outputs | Did parameters map correctly? Did the tool return the expected shape? |
| stdout / stderr | Did a Python App fail because of its environment, dependencies, or business logic? |
| Final state | Which fields were actually written back to the workflow? Are sensitive fields redacted? |
| Run diagnostics | Are model tokens, model calls, and tool calls within the expected range? |

## Suggested diagnostic order

1. Confirm input and upstream state are what you expect.
2. Inspect the Agent’s model messages, tool-call parameters, and structured output.
3. Inspect a Process App’s stdout, stderr, and returned result.
4. Retry a paused or failed run from its checkpoint.
5. For cross-system diagnosis, export traces to a configured OTLP/gRPC collector.

Run history retains the execution plan, final state, and key events. Do not inspect only the final answer: observability is what makes automation maintainable over time.

> **Media placeholder · screenshot `runs/01-run-workspace.png`**  
> Show the run workspace with the node timeline and expanded Agent events, calling out model messages, tool calls, and final state.

## Export traces

For diagnosis alongside an existing team observability system, configure an OTLP/gRPC collector. First validate its address and network policy in an isolated environment, then confirm that traces do not contain sensitive content that should not leave the device. Telemetry supports diagnosis; it does not replace inspecting individual run results in the run panel.
