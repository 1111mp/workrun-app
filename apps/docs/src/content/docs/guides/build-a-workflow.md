---
title: Build your first workflow
description: Build and verify a Process → Agent → branch flow, from customer feedback to human approval.
---

This tutorial extends the Agent from the [quickstart](/getting-started/quickstart/) with deterministic data preparation, structured output, conditional routing, and human review. You will build an explainable customer-feedback routing flow: low-priority feedback ends automatically; high-priority feedback waits for a person to decide.

```text
Start → Normalize feedback (Process) → Classify and recommend (Agent) → Priority is high?
                                                                    ├─ Yes → Human Review ─┬─ Approved → End
                                                                    │                     └─ Rejected → End
                                                                    └─ No ─────────────────→ End
```

Before you begin, configure an API key for at least one Provider under **Settings → Models**. If you have not created a workflow or a `feedback` input yet, complete the [quickstart](/getting-started/quickstart/) first.

## 1. Write the state contract first

Do not make downstream nodes infer an answer from free text. First agree on what every step reads and produces. These keys appear in the App schema, Agent output, branch conditions, and review UI.

| Producer                       | Reads                        | Writes and publishes to global state                                                         | Consumers                   |
| ------------------------------ | ---------------------------- | -------------------------------------------------------------------------------------------- | --------------------------- |
| Run input                      | —                            | `feedback` (Label: Customer feedback)                                                        | Process                     |
| Normalize feedback (Process)   | `feedback`                   | `normalized_feedback` (Label: Normalized feedback)                                           | Agent, Human Review         |
| Classify and recommend (Agent) | `normalized_feedback`        | `category` (Feedback category), `priority` (Priority), `recommendation` (Recommended action) | If/Else, Human Review       |
| Human Review                   | `recommendation` and context | Review decision                                                                              | Approved or rejected output |

Run inputs are already global state. Output from a node stays in that node’s private namespace unless you list it under **Publish to global state → Published output keys**. Published keys can be used by branches, later nodes, and workflow output. This example uses global keys, so it does not need **Allowed readers**; use that setting only when intentionally sharing a node’s private namespace.

## 2. Create the normalization Process App

Go to **Apps → New** and create an **App / Process Node** named, for example, “Normalize feedback.” Declare this data contract:

| Direction | Label               | Key                   | Type   | Required |
| --------- | ------------------- | --------------------- | ------ | -------- |
| Input     | Customer feedback   | `feedback`            | string | Yes      |
| Output    | Normalized feedback | `normalized_feedback` | string | Yes      |

Replace the entry-point code with this minimal implementation. It collapses excess whitespace so later nodes always receive the same clean text:

```python
import json
import sys

from workrun_sdk import process


def main() -> None:
    state = json.loads(sys.stdin.read() or "{}")
    feedback = " ".join(str(state.get("feedback", "")).split())
    process.result({"normalized_feedback": feedback})


if __name__ == "__main__":
    main()
```

Save it, then run it once from the App page and confirm the result contains `normalized_feedback`. For project setup, dependencies, and debugging, see [Use Python Apps](/guides/python-apps/).

## 3. Build and configure the canvas

Create a **Task** workflow; the canvas already contains Start and End. Add **Process**, **Agent**, **If/Else**, and **Human Review** in order, and connect them as shown above. Select Process and choose “Normalize feedback” under **App connection**.

Under **Publish to global state → Published output keys** on Process, enter:

```text
normalized_feedback
```

Select the Agent, choose a model from a configured Provider, and paste this schema into **Structured output schema (Advanced)**. It turns the classification into stable fields rather than a prose-only reply:

```json
{
  "type": "object",
  "properties": {
    "category": { "type": "string", "description": "Feedback category" },
    "priority": {
      "type": "string",
      "description": "Priority",
      "enum": ["low", "medium", "high"]
    },
    "recommendation": { "type": "string", "description": "Recommended action" }
  },
  "required": ["category", "priority", "recommendation"]
}
```

Use clear, testable instructions such as:

```text
You are a customer-feedback routing assistant. Read normalized_feedback and return category, priority, and recommendation.

Set priority to high for account security, fraud, data exposure, payment anomalies, or when a customer cannot use a core function.
When information is insufficient, say what is missing. Do not invent facts.
```

On that Agent, enter the following **Published output keys**:

```text
category, priority, recommendation
```

## 4. Route on a stable field and configure review

Select **If/Else** and set a condition for each output:

| Output | Condition            |
| ------ | -------------------- |
| Yes    | `priority == "high"` |
| No     | `priority != "high"` |

A condition compares one state field at a time. Do not use `||` or `&&`, and do not match words in the natural-language `recommendation`. The schema limits `priority` to known values, so these two conditions cover every valid result.

Connect “yes” to **Human Review** and “no” to End. In Human Review’s **Review request**:

1. Enter a direct title and explanation, such as “Confirm the high-priority feedback recommendation.”
2. Set the **content key** to `recommendation`.
3. Set **context keys** to `category, priority, normalized_feedback`.
4. Turn on **Allow editing** when the reviewer should be able to revise the recommendation.
5. For this tutorial, connect both approved and rejected outputs to End.

This means that human review is complete and the run ends regardless of the decision; the decision remains in run history. Only route rejection to another node when it needs follow-up, such as requesting more information, rewriting the recommendation, or notifying someone. Route approval to the node that performs the real side effect. For pause, editing, and checkpoint recovery details, see [Human approval and recovery](/guides/human-in-the-loop/).

## 5. Run three examples and inspect every layer

Save the workflow, select **Run**, and inspect node status and global state in the run panel for each example.

| Input                                                                  | What you should see                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `There is a typo in the page copy.`                                    | Process publishes `normalized_feedback`; the Agent returns `low` or `medium`; the flow takes “no” to End.                                   |
| `There is an unfamiliar payment on my account. Freeze it immediately.` | The Agent returns `high`; the flow pauses at Human Review; approve or reject to resume from the checkpoint without rerunning earlier nodes. |
| `It does not work. Please fix it.`                                     | The Agent identifies missing information while still returning complete `category`, `priority`, and `recommendation` fields.                |

![Low-priority feedback: If/Else takes the “no” output and reaches End.](/media/build-a-workflow/01-low-priority-to-end.png)

![High-priority feedback: the flow pauses at Human Review and waits for approval or rejection.](/media/build-a-workflow/02-high-priority-human-review.png)

![Insufficient-information feedback: the Agent still returns structured category, priority, and recommendation fields.](/media/build-a-workflow/03-insufficient-information.png)

If a run differs, inspect in this order: the App’s stdout/stderr and `normalized_feedback`; the Agent’s model and schema; whether both producing nodes published their required keys; then the If/Else conditions and outgoing edges. Keep these three inputs as your first [evaluation cases](/quality/evaluations/).

## Share or delete a saved Workflow

In personal mode, save your changes, then open the **More (⋯)** menu in the Workflow detail page and choose **Export**. Select ZIP or TAR and review the package. It bundles the main definition, referenced Process Apps, Agent and CodeAct Tool Apps, and recursively referenced child Workflows. Repeated dependencies are included once. Missing dependencies and child-Workflow cycles prevent export.

Choose **Import** from the Workflow list to open a package. Review the dependencies, choose a name, and bind the external configuration available on your device. Import creates fresh IDs for the Workflow, child Workflows, and Apps, and updates their references; it does not overwrite existing objects.

Models, MCP tools, Skills, remote credentials, mounted host paths, environment values, and private URLs may require local configuration. Skill source and MCP server configuration are not bundled. Credentials, host paths, and environment values are removed from the exported definition. Review prompts and App source yourself for embedded private data.

You can leave configuration pending and reopen **Configure imported dependencies** in the editor later. Pending items survive closing the editor and block execution until resolved. Use the separate dependency-installation action for bundled Apps before running. Run history, chat sessions, and schedules are not imported.

To delete a Workflow, use **More (⋯) → Delete** in its detail page and confirm. Personal mode removes the local definition. In Team mode, only the author sees this action, and deletion removes the Workflow from the team catalog, including its published version. Associated Apps, child Workflows, and historical run records are retained. Deletion is not offered on list cards.
