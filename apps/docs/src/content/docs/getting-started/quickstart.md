---
title: 5-minute quickstart
description: Add an API key, then create and run your first Start → Agent → End workflow.
---

In this tutorial, you will create a minimal workflow that accepts customer feedback and has an Agent suggest a next step. You only need to configure one provider API key: Workrun already provides the model catalog and workflow run modes.

```text
Start → Agent → End
```

## 1. Add an API key in Settings

Open **Settings → Models** and enter an API key on the row for the provider you want to use. Settings save automatically.

Do not create a model profile, enter a model ID manually, or create a run mode for this tutorial. Workrun includes the available models; you will select one for the Agent that belongs to the provider you configured. For Ollama, enter the local or remote Ollama endpoint instead of an API key.

![Settings → Models: add an API key for a provider; the key is redacted.](/media/quickstart/01-api-key.png)

## 2. Create the workflow and Agent

Go to **Workflows** and create a workflow named “Customer feedback assistant.” A new workflow already includes a **Start** node. It is the fixed entry point: it is not editable and needs no configuration.

Add an **Agent** and an **End** from the node palette, then connect them:

```text
Start → Agent → End
```

Select the Agent. In the inspector:

1. Give it a name, such as “Feedback assistant.”
2. Add the description: `Analyze customer feedback and recommend a next step.`
3. Under model configuration, select a built-in model from the provider whose key you configured.
4. Paste this instruction:

```text
You are a customer-feedback assistant.

Read the feedback input supplied for this run. Briefly state:
1. the issue the customer encountered;
2. its urgency; and
3. the recommended next step.

If information is missing, say what is needed; do not invent facts.
```

<video controls preload="metadata" playsinline aria-label="Create the customer feedback assistant workflow">
  <source src="/media/quickstart/02-create-workflow.mp4" type="video/mp4" />
  Your browser does not support MP4 video playback. Download the video from the documentation media folder instead.
</video>

The recording creates the workflow (including the default Start), adds and connects Agent and End, then selects a built-in model and enters the Agent instruction.

## 3. Define the entry input in More settings

Workflow entry inputs are not configured on the Start node. Select **More settings** in the editor toolbar, then add this field under **Run inputs**:

| Field | Value |
| --- | --- |
| Label | `Customer feedback` |
| Key | `feedback` |
| Type | `Multiline text` |
| Required | On |
| Help text | `Enter the customer feedback to analyze.` |

Save the workflow. The key is supplied to the workflow on each run and can be referenced by the Agent instruction. Its actual value belongs only to that run; it is not saved into the workflow definition.

## 4. Run and inspect the result

Select **Run** and enter:

```text
After the upgrade, exported CSV files will not open. Finance needs to reconcile accounts this afternoon. Please help urgently.
```

Submit the input. The run panel shows Start, Agent, and End status plus the Agent response. A useful result should identify a high-priority export/file issue and suggest a concrete follow-up.

If the run fails, check that the provider API key is saved under **Settings → Models** and that the Agent selected a model from that provider.

![Run result: Start, Agent, and End status with the Agent response.](/media/quickstart/03-run-result.png)

Next, read [Build your first workflow](/guides/build-a-workflow/) to add Python, conditional routing, and human review.
