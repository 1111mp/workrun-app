---
title: Use Python Apps
description: Use a complete Python project as a Process node or Agent tool.
---

Choose a Python App rather than placing all logic in a prompt for data cleanup, complex calculations, internal service integrations, file operations, and business rules that must be reproduced reliably. Every App is an independent local `uv` project with its own `pyproject.toml`, lockfile, and virtual environment.

## Create and configure an App

1. Go to **Apps** and select **New**.
2. Choose whether it is an **App / Process Node** in a workflow or a **Tool App** called by an Agent.
3. Choose the project location and let Workrun create or connect a `uv` project.
4. Install dependencies, implement the entry point, and declare input/output schemas in the editor.
5. Run it once on the App page and confirm stdout, stderr, and the result.
6. Return to the workflow: choose the Process App in a Process node, or select the Tool App in the Agent’s **Tools**.

> **Media placeholder · video `python-apps/01-create-and-run.mp4` (60–90 seconds)**  
> Create a Process App, inspect project files, write a minimal entry point, install a dependency, then run it and inspect stdout/stderr.

## Process Apps

A Process App runs as a workflow node. It can read the workflow’s full state and return a structured result.

```python
from workrun_sdk import process

# Return only fields later nodes need, preserving clear state boundaries.
process.result({"normalized_feedback": "...", "is_high_risk": False})
```

After adding the App to a workflow, choose it in the Process node’s **App connection**. The node receives an authorized JSON view of State through standard input. Return only values needed later, then publish the corresponding output keys on the node.

## Tool Apps

A Tool App is called by an Agent when needed. Give it a clear JSON Schema so the Agent knows when it can call it, what to pass, and which result it gets.

When user input or confirmation is required, the Python SDK also provides APIs such as `form()`, `collect()`, and `confirm()` via token-protected local IPC requests to the desktop interface.

### Tool App runtime boundary

After selecting a Tool App in an Agent’s **Tools**, configure its **call limit** and **tool timeout**. Side-effecting tools (writing, deleting, sending) should require human confirmation. A Tool App must return a JSON object; it is not a sandbox, so run only code you trust.
