---
title: 5-minute quickstart
description: Create and run your first Start → Agent → End workflow.
---

The goal of this tutorial is a minimal, runnable loop: give the Agent a piece of customer feedback, have it return a category, priority, and recommendation, then verify what actually happened in the run panel.

## What you will build

```text
Start (feedback) → Agent (classification) → End
```

The final state contains `category`, `priority`, and `recommendation`. Later guides add a Python App, conditional routing, and human review to this starting point.

## Before you start

- Workrun desktop is running.
- You have a model provider key, for example OpenAI, Gemini, Anthropic, DeepSeek, Groq, Ollama, or a compatible API.
- You have a small real task, such as “classify this customer feedback and recommend a follow-up.”

## 1. Create a model profile

Open **Settings → Model Profiles** and choose **New**. Fill in the following fields:

| Field | Suggested value | Why |
| --- | --- | --- |
| Name | `default-chat` | A name for workflow authors; it is not sent to the model. |
| Provider | A service whose key you own | For example OpenAI, Gemini, Anthropic, DeepSeek, Groq, Ollama, or a compatible API. |
| Model | A general-purpose text model | Start with a stable, cost-controlled model. Treat an upgrade as a separate evaluated change. |
| API key / connection | Your credentials | Stored locally in encrypted form after saving; not persisted by the frontend. |

After saving, use the profile test or a real run to confirm that credentials work. For a self-hosted compatible API, also confirm that the Base URL, model ID, and server configuration agree.

> **Media placeholder · screenshot `quickstart/01-model-profile.png`**  
> Show the new model profile form with provider, model, and a redacted key field. Do not show a real key.

## 2. Create a workflow

Go to **Workflows** and create one called “Customer feedback classification.” Drag these nodes from the palette and connect them:

```text
Start → Agent → End
```

Select the **Agent** node and complete this configuration in the right inspector:

1. In **Basic information**, name it `Feedback classification Agent` and add a short responsibility.
2. In **Model & instructions**, select `default-chat`.
3. Paste the following into **Instructions**.
4. Open **Structured output schema (advanced)**, set the root type to object, and add the three fields.
5. Connect `Start → Agent → End`, then save the workflow.

```text
You are a customer-feedback analysis assistant.

Use the input field feedback to determine the issue category and urgency, and provide one follow-up recommendation that support can act on directly.

Do not invent orders, customer identities, or product capabilities. If information is missing, explain what is needed in recommendation.
```

Recommended output schema:

```json
{
  "type": "object",
  "properties": {
    "category": { "type": "string", "description": "billing, bug, feature, or other" },
    "priority": { "type": "string", "enum": ["low", "medium", "high"] },
    "recommendation": { "type": "string" }
  },
  "required": ["category", "priority", "recommendation"]
}
```

> **Media placeholder · video `quickstart/02-create-workflow.mp4` (30–45 seconds)**  
> Create a workflow, add and connect Start/Agent/End, select a model, and paste the instruction in the Agent inspector. Record a 1440px-wide window if possible.

## 3. Run and inspect the result

Select the **Start** node and add a string input called `feedback`. Before running, enter:

```text
After the upgrade, exported CSV files will not open. Finance needs to reconcile accounts this afternoon. Please help urgently.
```

Select **Run**. The run panel shows the status of Start, Agent, and End in sequence. Expand the Agent event and inspect the three final fields. A reasonable result is close to `category: bug`, `priority: high`, without inventing a specific resolution time.

If the run fails, first check the model profile, whether the Agent selected that profile, whether the schema root is an object, and whether the Start input name matches the `feedback` reference in your instructions.

> **Media placeholder · screenshot `quickstart/03-run-result.png`**  
> Show the node timeline and expanded structured final output. Emphasize that success means checking structured state and events, not only chat text.

Next, read [Build your first workflow](/guides/build-a-workflow/) to add Python, conditional branches, and human review.
