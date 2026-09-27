---
title: Workflows and state
description: Keep flows readable, controlled, and resumable with explicit state and node boundaries.
---

A workflow consists of nodes and connections on a canvas. Common nodes include `Start`, `End`, `Agent`, `Process`, `If/Else`, `Switch`, `Human Review`, `Ask User Question`, `Subworkflow`, and `Terminate`.

## Explicit state, not implicit context

Each node has an isolated state namespace. Only explicitly published fields can be read by later nodes, and nodes must be granted read access. This reduces the unpredictability of a step silently changing all context.

Inputs, outputs, and node results can be described with JSON Schema. Introducing schemas early helps find problems in branches, graph structure, and data shape before a run.

## Pause and resume

Human review and questions write the run state to a local SQLite checkpoint. When a reviewer submits a result, Workrun continues from the pause point instead of executing completed nodes again. Failed background runs can also retry from a checkpoint.

> **Security boundary:** inputs or outputs marked sensitive are stored encrypted and use redacted views by default in models, tools, and the interface. Do not process data in an untrusted App that you would not grant that App permission to access.
