---
title: How Workrun works
description: See how Workrun organizes AI reasoning, code, and tools into automation you can ship.
---

Workrun is not about asking a model one more question. It is about turning a useful AI collaboration into a capability that can run again.

```text
User input + workflow state
        ↓
Agent reasoning / Python code / external tools / human judgment
        ↓
Structured results, run records, evaluation results, and published versions
```

Workflows arrange steps and state transitions. Apps contain deterministic code and integrations. Agents handle tasks that require reasoning. MCP and Tool Apps give Agents the ability to act.

### How this differs from a one-off chat

- A workflow can contain conditions, branches, subworkflows, termination, and human review.
- A run records node state, tool calls, logs, and traces.
- After a failure or pause, it can resume from a checkpoint instead of rerunning everything.
- Evaluation suites and quality gates let teams verify a change before they publish it.
