---
title: Configure model access
description: Add provider credentials in Settings and choose a built-in model in an Agent.
---

Workrun includes a model catalog. Agent and CodeAct Agent nodes select from it, so you do not create model profiles or repeat model IDs in every workflow.

## Add provider credentials

1. Open **Settings → Models**.
2. Enter an API key on the row for the provider you want to use.
3. Settings save automatically.
4. Create or edit an Agent, then choose a built-in model for that provider under **Model configuration**.

Ollama uses an endpoint instead of an API key. The local default endpoint is normally sufficient; enter the applicable address for a remote deployment.

## Usage guidance

- One provider key can be used by that provider's built-in models.
- Never put keys in node instructions, workflow inputs, or Python code.
- Configure an Agent's name, role, instruction, tools, and generation parameters in the node inspector.
- After switching models, rerun the workflow with the same inputs to confirm the result.

![Model configuration in the Agent inspector, showing the built-in catalog grouped by provider.](/media/model-profiles/01-model-settings.png)
