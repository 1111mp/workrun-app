---
title: Configure model profiles
description: Store a provider, model, and encrypted credentials for stable reuse in workflow nodes.
---

A model profile is the configuration unit Agents and CodeAct Agents use to call a model. Keeping keys and model selection in a profile rather than copying them into every node makes credential rotation, model replacement, and diagnosis much clearer.

## Create a profile

1. Open **Settings → Model Profiles**.
2. Select **New**.
3. Enter a name based on its purpose, such as `prod-review`, `local-ollama`, or `eval-cheap`.
4. Choose a provider.
5. Enter the model ID and required credentials. Compatible APIs also need a Base URL.
6. Save, then validate the connection with a minimal workflow run.

## Use it in an Agent

Select an Agent node and open **Model & instructions → Model configuration** in the right inspector, then choose the profile. A model profile defines only *which model to call*. Role, task objective, output format, and tool boundaries belong in node instructions.

## Configuration guidance

- Use separate profiles for local, development, evaluation, and production work.
- Never put a key in a node instruction, workflow input, or Python code.
- After changing a model, temperature, or provider, run the same evaluation suite before publishing.
- Temperature and Top P are node-level generation controls. Leave them empty for model defaults unless you specifically need stability or diversity.

> **Media placeholder · screenshot `model-profiles/01-profile-list.png`**  
> Show the Settings profile list with local, evaluation, and production naming examples. All real provider credentials must be redacted.
