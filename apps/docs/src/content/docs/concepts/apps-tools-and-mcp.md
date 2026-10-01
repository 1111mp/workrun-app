---
title: Apps, tools, and MCP
description: Use Process Apps, Tool Apps, MCP, Skills, and runtime forms to give Agents and code clear responsibilities.
---

Workrun separates deterministic code, Agent-selected tools, human input, and existing integrations. This page follows one recordable support ticket: a Process App normalizes it, an Agent looks up its order, and a representative confirms the resolution.

## Choose where a capability belongs

| Capability       | Started by                        | Best for                                          | In this case              |
| ---------------- | --------------------------------- | ------------------------------------------------- | ------------------------- |
| Process App      | A workflow Process node           | Fixed, repeatable code                            | Normalize ticket text     |
| Tool App         | An Agent when needed              | A context-dependent query, calculation, or action | Look up an order          |
| MCP server       | An Agent calling discovered tools | Capability owned by an existing service           | Search help-center policy |
| Skill            | An Agent when needed              | Rules, tone, and constraints                      | Check the order first     |
| JSON Schema form | A running Python App              | Human input or confirmation                       | Confirm a resolution      |

Use a Process App for fixed work; an Agent plus a Tool when context decides whether to act; MCP for an existing integration; and a form when execution needs judgment. A Skill supplies guidance, not executable code.

## One recordable end-to-end flow

```text
Customer input → Process App normalizes message → Agent calls lookup_order
             → Agent recommends refund → App collect() form → confirm()
             → { status: "approved", resolution: "refund" }
```

This flow uses one local Tool App. MCP is a replacement at the same Agent-tool boundary when the order or help-center system already exposes MCP.

## Configure the example

An App receives workflow state, while a Tool App receives Agent-call arguments. Verify both through a workflow rather than manually supplying stdin to a standalone process. Configure the example in this order.

### 1. Create the three Apps

In **Apps → New**, create **Normalize support ticket** and select **App** as its type (not Tool App). On its detail page, add the following fields in the data contract. The field name is the Key. Save the App metadata, then use **Open project directory** to replace the starter entrypoint. The first run creates the Python environment and installs dependencies.

| Direction | Label              | Key                  | Type   | Required |
| --------- | ------------------ | -------------------- | ------ | -------- |
| Input     | Ticket ID          | `ticket_id`          | string | Yes      |
| Input     | Customer message   | `customer_message`   | string | Yes      |
| Output    | Ticket ID          | `ticket_id`          | string | Yes      |
| Output    | Normalized message | `normalized_message` | string | Yes      |
| Output    | Message length     | `message_length`     | number | Yes      |

Replace its entrypoint with the following complete script. It normalizes once so every downstream node reads the same message:

```python
import json
import sys

from workrun_sdk import process


def main() -> None:
    state = json.loads(sys.stdin.read() or "{}")
    ticket_id = str(state.get("ticket_id", "")).strip()
    message = " ".join(str(state.get("customer_message", "")).split())
    process.result(
        {
            "ticket_id": ticket_id,
            "normalized_message": message,
            "message_length": len(message),
        }
    )


if __name__ == "__main__":
    main()
```

Create an App named `lookup_order` as a **Tool App**. Its App name is what appears in the Agent's tool list; there is no separate tool-name field. Describe it as an order-status and refund-eligibility lookup by support ticket. Configure its contract as follows:

| Direction | Label              | Key                  | Type    | Required |
| --------- | ------------------ | -------------------- | ------- | -------- |
| Input     | Ticket ID          | `ticket_id`          | string  | Yes      |
| Output    | Order status       | `status`             | string  | Yes      |
| Output    | Estimated delivery | `estimated_delivery` | string  | Yes      |
| Output    | Refund eligible    | `can_refund`         | boolean | Yes      |

For a stable demo, use the following entrypoint. It accepts a ticket ID and returns the status of its associated order:

```python
from workrun_sdk.tool import tool


@tool(
    name="lookup_order",
    description="Look up the order attached to a support ticket before recommending a refund or replacement.",
)
def lookup_order(ticket_id: str) -> dict[str, object]:
    return {
        "status": "delayed",
        "estimated_delivery": "2025-03-12",
        "can_refund": True,
    }
```

Create **Resolve support ticket** as another **App / Process Node**. Configure its contract as follows:

| Direction | Label             | Key              | Type   | Required |
| --------- | ----------------- | ---------------- | ------ | -------- |
| Input     | Ticket ID         | `ticket_id`      | string | Yes      |
| Input     | Recommendation    | `recommendation` | string | Yes      |
| Output    | Resolution status | `status`         | string | Yes      |
| Output    | Resolution        | `resolution`     | string | No       |

Mark `resolution` optional so cancellation can return `{ "status": "cancelled" }`. Use this complete entrypoint:

```python
from collections.abc import Mapping

from workrun_sdk import choice, collect, confirm, process


RESOLUTION_LABELS = {
    "reply": "Reply only",
    "reship": "Reship item",
    "refund": "Issue refund",
    "escalate": "Escalate to human support",
}


def main() -> None:
    settings = collect(
        title="Resolve support ticket",
        description="Choose a resolution before continuing.",
        fields={
            "resolution": choice(
                "Resolution",
                RESOLUTION_LABELS,
                required=True,
            ),
        },
    )
    # collect() returns generic JSON, so validate it before indexing or publishing it.
    if not isinstance(settings, Mapping):
        process.result({"status": "cancelled"})
        return

    resolution = settings.get("resolution")
    if not isinstance(resolution, str) or resolution not in RESOLUTION_LABELS:
        process.result({"status": "cancelled"})
        return

    # Persist the stable value (for example, "refund") but show its label to people.
    if confirm(f"Resolve the ticket as '{RESOLUTION_LABELS[resolution]}'?", title="Confirm resolution"):
        process.result({"status": "approved", "resolution": resolution})
    else:
        process.result({"status": "rejected", "resolution": resolution})


if __name__ == "__main__":
    main()
```

### 2. Build the canvas before configuring nodes

Create a **task** workflow. The canvas starts with Start and End. Add two App nodes and one Agent node, then connect the whole path:

```text
Start → Normalize support ticket (App) → Order resolution (Agent)
      → Resolve support ticket (App) → End
```

Keep Start and End connected; the three middle nodes alone are not a complete runnable path. Select each App node and choose the matching App in **App connection → App**. `lookup_order` is a Tool App, so it belongs in the Agent's tool list, not on the canvas.

Open **More settings → Run inputs**, add two inputs, and save the workflow:

| Label            | Key                | Type   | Example                                      |
| ---------------- | ------------------ | ------ | -------------------------------------------- |
| Ticket ID        | `ticket_id`        | string | `TK-2025-001`                                |
| Customer message | `customer_message` | string | `My order has not arrived—what should I do?` |

### 3. Publish node output to global State

Run inputs are already global State, so do not try to grant reads in a downstream node. **State access** controls who may read the selected node's _private_ output. This example publishes the shared values instead.

Select each executable node and enter these values under **Global State publication → Published output keys**:

| Node                     | Published output keys                |
| ------------------------ | ------------------------------------ |
| Normalize support ticket | `normalized_message, message_length` |
| Order resolution         | `recommendation`                     |
| Resolve support ticket   | `status, resolution`                 |

Do not republish `ticket_id`: it is already a global run input. If a later workflow needs private state, choose its consumer under **Allowed readers** on the node that produced the value.

### 4. Configure the Agent, tool, and structured output

Select **Order resolution** and choose a configured model profile. Under **Tools**, select `lookup_order`, set **Call limit** to `1`, and **Tool timeout** to `10` seconds. The tool argument and global State key are both `ticket_id`, so no advanced State binding is needed.

Paste this complete JSON Schema into **Structured output schema (advanced)**. This is an object-schema editor, not a per-field Label/Key form:

```json
{
  "type": "object",
  "properties": {
    "recommendation": {
      "type": "string",
      "description": "Recommended resolution for the support representative"
    }
  },
  "required": ["recommendation"]
}
```

Use this instruction:

```text
You are a customer-support triage assistant. For an undelivered-order issue, you must call lookup_order with the authorized ticket_id first.

When the tool returns status delayed and can_refund true, recommendation must be "Recommend refund".
Do not issue a refund, reship, or escalate. Only explain order status, estimated delivery, and the recommendation.
```

### 5. Run, verify, and troubleshoot

Run with the listed inputs. First, confirm that `normalized_message` and `message_length` appear in global State. Then confirm that the Agent calls `lookup_order` once and publishes `recommendation`. Finally, choose **Issue refund** and submit the first form; a second confirmation dialog appears. Confirm it to finish the node and write `status: "approved"` plus `resolution: "refund"` to global State.

| Symptom                                    | Check first                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| An App is missing from the App-node picker | It must be an **App**, created successfully, and available locally. Tool Apps do not appear there.                     |
| `lookup_order` is missing from the Agent   | It must be a **Tool App** with at least one input and output field, then be explicitly selected in that Agent's tools. |
| The tool argument is missing               | Both the Tool App input and the workflow input must use `ticket_id`. Same-name values need no State binding.           |
| A downstream value is absent               | The producer node must list the key in **Published output keys** and the workflow must be saved.                       |
| The Agent returns only text                | Verify the JSON Schema above and that `recommendation` is published by the Agent node.                                 |

<video controls preload="metadata" playsinline aria-label="Completed support-ticket workflow">
  <source src="/media/apps-tools-and-mcp/apps-tools-and-mcp-demo.mp4" type="video/mp4" />
</video>

The video shows the completed ticket workflow: ticket input, order lookup, Agent recommendation, human confirmation, and the final structured result. It uses demo data only.

## Apps and Schemas: maintainable deterministic capability

Every Python App is an editable local `uv` project with its own `pyproject.toml`, lockfile, virtual environment, and entry script. Workrun creates and runs it and displays stdout/stderr; code remains testable, reviewable, and versionable.

- A **Process App** reads authorized workflow-state JSON from standard input and returns updates with `process.result({...})`.
- A **Tool App** is selected by an Agent from its name, description, and JSON Schema. It receives validated arguments and must return a JSON object.

A schema is a calling contract, not just form configuration. Keep fields small: `lookup_order` accepts `ticket_id` to find its associated order, then returns `status`, `estimated_delivery`, and `can_refund`.

For example, **Normalize support ticket** can take string inputs `ticket_id` and `customer_message`, and return string outputs `ticket_id` and `normalized_message` plus numeric `message_length`.

## Tool Apps and MCP: verifiable Agent actions

Tool name, description, input schema, and output schema form the invocation contract. An Agent can generate only declared arguments, and Workrun validates them before a call. Use verb-led names, explain when a tool should and should not be used, and set confirmation, call limits, and timeouts for side-effecting actions.

For example, `lookup_order` can accept `ticket_id` to find its associated order and return `status`, `estimated_delivery`, and `can_refund`. Explicitly select each tool for each Agent; connecting an MCP server alone does not expose it everywhere.

## Runtime JSON Schema forms: code can wait for judgment

An App can request a form mid-run, then continue with JSON-compatible data after submission, rejection, or cancellation. This is runtime App-to-person interaction, not editor-time configuration.

| API         | Use it when                                              | Returns                                       |
| ----------- | -------------------------------------------------------- | --------------------------------------------- |
| `form()`    | Full JSON Schema, nested data, arrays, or custom RJSF UI | Submitted data, or `None` on cancellation     |
| `collect()` | Common named fields                                      | A field dictionary, or `None` on cancellation |
| `confirm()` | Acceptance or rejection only                             | `True` or `False`                             |

For example, a resolution form can offer reply, replacement, refund, or escalation and return `status` with `resolution` after confirmation. Use forms only for values that require human input or judgment; pass all known values directly to the App.

## Safety and next steps

Workrun gives launched Python processes token-protected local IPC; runtime forms use that channel. Provider and MCP credentials are encrypted locally, sensitive state has redacted views by default, and tool arguments plus run events pass through guardrails. This is not a sandbox: run trusted code only and apply least privilege, clear schemas, confirmation, limits, timeouts, and run history.

Read [Use Python Apps](/guides/python-apps/) for project creation and workflow connection, or [Connect an MCP server](/guides/connect-an-mcp-server/) to configure an existing tool service.
