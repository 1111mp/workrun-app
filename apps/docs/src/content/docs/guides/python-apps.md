---
title: Use Python Apps
description: Understand App and Tool App types; run an App independently or connect it as a Process node and Agent tool.
---

A Python App is a complete, editable local `uv` project for predictable data processing, calculations, file operations, and internal-service integrations. It is not a prompt in another form: its code, dependencies, and data contract can be tested, reviewed, and versioned independently.

Workrun has two types. Choose based not on the language, but on **who decides when the code runs**.

| Type | Triggered by | Can run independently? | How it joins a workflow | Best for |
| --- | --- | --- | --- | --- |
| **App / Process Node** | A person from the App page, or a workflow in canvas order | Yes | Select it as a **Process** node’s **App connection** | Fixed-position collection, cleanup, calculation, files, or system work |
| **Tool App** | An Agent, based on its name, description, and schema | Its meaningful invocation receives Agent arguments | Select it in an Agent’s **Tools**; it cannot be a Process node | A lookup, calculation, or action whose need depends on the task |

> An App is not a sandbox. It has the file, network, and system permissions of the current user environment. Run only code you trust, and minimize sensitive data and side effects.

## 1. Run an App independently: collect health information

Start with an independent run; it makes the App model easiest to see. This “Health information collection” App needs no workflow input. When a person selects **Run** from **Apps**, the code asks Workrun to show a form for email, height, and weight, then prints the result in the run output.

Go to **Apps → New**, choose **App** (not Tool App), and name it “Health information collection.” Choose a project location and let Workrun create the `uv` project. Under **Data contract**, add these output fields. On cancellation only `status` is returned, so the other three outputs must be **optional**.

| Direction | Label | Key | Type | Required |
| --- | --- | --- | --- | --- |
| Output | Collection status | `status` | string | Yes |
| Output | Email | `email` | string | No |
| Output | Height (cm) | `height_cm` | number | No |
| Output | Weight (kg) | `weight_kg` | number | No |

Replace the entry-point code with:

```python
import json

from workrun_sdk import collect, number, process, text


def main() -> None:
    profile = collect(
        title="Enter health information",
        description="This information is used only for this collection.",
        layout=[["height_cm", "weight_kg"]],
        fields={
            "email": text("Email", required=True, placeholder="name@example.com"),
            "height_cm": number("Height (cm)", required=True, minimum=50, maximum=300),
            "weight_kg": number("Weight (kg)", required=True, minimum=1, maximum=500),
        },
    )

    # A cancellation still has a defined result, so a workflow caller can continue safely.
    result = {"status": "cancelled"} if profile is None else {
        "status": "submitted",
        **profile,
    }
    print(json.dumps(result))
    process.result(result)


if __name__ == "__main__":
    main()
```

<video controls preload="metadata" playsinline aria-label="Run the health information collection App independently">
  <source src="/media/python-apps/01-standalone-health-information.mp4" type="video/mp4" />
  Your browser does not support MP4 video. Download the video from the documentation media directory.
</video>

Select **Run** from the App page. The form appears; after submission, run output prints JSON with `status`, `email`, `height_cm`, and `weight_kg`. `collect()` returns a dictionary, or `None` when the person cancels, which is why the example returns only `{"status": "cancelled"}` in that case.

The video shows the complete independent flow: run “Health information collection” from Apps, submit the form, and inspect the result.

This demonstrates an independent App: a local tool or human-collection step can be useful without an Agent or workflow. Use `form()` for nested data, arrays, or a complete JSON Schema; use `confirm()` when only an approve/reject decision is required.

## UI SDK: runtime interactions built with JSON Schema

The Python UI SDK does not require you to write a React interface. An App sends JSON Schema, optional UI Schema, and copy to the desktop app over local IPC. The desktop app renders the form with [react-jsonschema-form (RJSF)](https://github.com/rjsf-team/react-jsonschema-form) and an AJV 8 validator. In short: **Schema defines data and validation, UI Schema controls widgets and layout, and Python receives submitted JSON.**

`collect()` is a convenience layer for common fields: it builds an object schema and turns `layout` into RJSF `LayoutGridField` configuration. Use `form()` directly for nested objects, arrays, conditional structures, or precise UI Schema control. A cancelled form returns `None`; after receiving a result, the same App run can request another interaction.

| API | Purpose | Returns | Use it when |
| --- | --- | --- | --- |
| `form()` | Sends a complete JSON Schema and optional UI Schema | Submitted JSON value, or `None` on cancel | Nested objects, arrays, `oneOf`, or direct RJSF configuration |
| `collect()` | Collects named fields with field helpers | JSON object, or `None` on cancel | Ordinary forms; the health-information example on this page uses it |
| `confirm()` | Shows a confirmation/cancellation dialog | `True` or `False` | One clear decision, such as sending, deleting, or overwriting |
| `text()` | Builds a string field | `Field` for `collect()` | Single/multiline text, descriptions, and placeholders |
| `number()` | Builds a number or integer field | `Field` for `collect()` | Bounds, integers, steps, and numeric placeholders |
| `choice()` | Builds a single-choice field | `Field` for `collect()` | Selects or radio buttons; keys are saved values and values are display labels |
| `boolean()` | Builds a Boolean field | `Field` for `collect()` | Checkboxes or switch-like confirmation |
| `path()` | Builds a file or directory field | `Field` for `collect()` | The desktop app’s native file or directory picker |
| `shutdown()` | Closes the shared IPC client | Nothing | Normally unnecessary; the SDK cleans up automatically on process exit |

### Use `form()` for full Schema and UI Schema

This example requires email and height, then lets a person choose an activity goal. `ui_schema` changes the email control’s placeholder and renders the goal as radios. JSON Schema and the RJSF-supported UI Schema are serializable data; do not put Python callbacks or React components in them.

```python
from workrun_sdk import form


health_profile = form(
    title="Add health information",
    description="Required fields and numeric bounds are validated before submission.",
    schema={
        "type": "object",
        "properties": {
            "email": {"type": "string", "title": "Email", "format": "email"},
            "height_cm": {"type": "integer", "title": "Height (cm)", "minimum": 50, "maximum": 300},
            "goal": {
                "type": "string",
                "title": "Activity goal",
                "oneOf": [
                    {"const": "maintain", "title": "Maintain health"},
                    {"const": "reduce", "title": "Manage weight"},
                ],
            },
        },
        "required": ["email", "height_cm", "goal"],
    },
    ui_schema={
        "email": {"ui:placeholder": "name@example.com"},
        "goal": {"ui:widget": "radio"},
    },
    submit_label="Save",
    cancel_label="Not now",
)
```

`form()` returns a JSON-compatible value, so handle cancellation and ensure the top-level value is an object before passing it to `process.result()`. Prefer `collect()` for flat named fields; it avoids writing the schema above by hand.

### Use `collect()` and field helpers

The first example on this page already uses `text()` and `number()`. This fragment covers the other common helpers. Dictionary keys passed to `choice()` are stable values your code reads; dictionary values are labels people see. `ui_options` passes through to RJSF’s `ui:options`.

```python
from workrun_sdk import boolean, choice, collect, path, text


settings = collect(
    title="Export settings",
    layout=[["format", "include_headers"], ["destination"]],
    fields={
        "format": choice(
            "Export format",
            {"csv": "CSV", "json": "JSON"},
            required=True,
            widget="radio",
        ),
        "include_headers": boolean("Include headers"),
        "destination": path("Save directory", directory=True, required=True, button_label="Choose directory"),
        "note": text("Note", multiline=True, placeholder="Optional"),
    },
)
```

Fields in the same `layout` row get equal width; any omitted field is appended in its own row. `settings` is `None` after cancellation, so do not index it directly. Forms should collect only a value a person truly must decide or supply at runtime. Read known inputs, fixed configuration, and workflow state directly instead of pausing needlessly.

### Use `confirm()` to put a person in charge of side effects

`confirm()` returns a Boolean for a simple, explicit risk decision. Call it before a real write, deletion, or send rather than letting an Agent or code complete the side effect without confirmation.

```python
from workrun_sdk import confirm


if confirm("Send this week's summary to 42 subscribers?", title="Confirm sending", confirm_label="Send"):
    send_weekly_digest()
```

## 2. The same App can also be a Process node

The second use of an **App** is inside a workflow. Select “Health information collection” in a **Process** node. When execution reaches that node, the same form appears and its submission becomes the node’s structured output. On that node, enter the keys needed by later steps under **Publish to global state → Published output keys**:

```text
status, email, height_cm, weight_kg
```

Later Agents, conditions, or Process nodes can then read the values. Email is sensitive: publish it and authorize it only where necessary. If a later step only calculates a metric from height and weight, do not publish `email`.

A Process App can also read workflow state. For example, to prefill or display a known email, add this input to the App’s data contract:

| Direction | Label | Key | Type | Required |
| --- | --- | --- | --- | --- |
| Input | Known email | `email` | string | No |

Workflow inputs are global state. Ordinary Process output is private until added to **Published output keys**. For a full Process, Agent, and branch example, see [Build your first workflow](/guides/build-a-workflow/).

## 3. Tool App: let an Agent call a capability when needed

Use a **Tool App** when the Agent should decide whether a lookup or action is needed. For example, create a Tool App named `lookup_order`. Start tool names with verbs; the description should say both when it may be used and its boundary: “Look up an order’s status and refund eligibility; use only when that information must be confirmed.”

Declare a small, explicit contract:

| Direction | Label | Key | Type | Required |
| --- | --- | --- | --- | --- |
| Input | Order ID | `ticket_id` | string | Yes |
| Output | Order status | `status` | string | Yes |
| Output | Estimated delivery date | `estimated_delivery` | string | Yes |
| Output | Refund eligible | `can_refund` | boolean | Yes |

Use this demonstration implementation to test the connection. When connecting a real order system, replace only the lookup inside the function and preserve the same input and output contract:

```python
from workrun_sdk.tool import tool


@tool(
    name="lookup_order",
    description="Look up an order before recommending a refund or replacement.",
)
def lookup_order(ticket_id: str) -> dict[str, object]:
    # A fixed result keeps this tutorial independent from a real order system.
    return {
        "status": "delayed",
        "estimated_delivery": "2025-03-12",
        "can_refund": True,
    }
```

Select an Agent on the workflow canvas and choose `lookup_order` in **Tools**. A Tool App cannot be placed as a Process node; the Agent decides whether to call it using the description, input schema, and instructions. Set its call limit to `1` and tool timeout to `10` seconds. Human confirmation can be off for this read-only lookup; it must be on for writes, deletes, sends, or any other side effect.

![Agent tool configuration with lookup_order selected, plus call limit, timeout, and human-confirmation settings.](/media/python-apps/02-agent-tool-configuration.png)

When a Tool App parameter key matches a workflow-state key, Workrun can restore the argument from authorized state. For example, no state binding is needed when run input is also named `ticket_id`. Use **State binding (Advanced)** only when parameter and state keys differ, and map every parameter to the right state key.

State the tool-use rule in the Agent instructions:

```text
When a customer asks about order status, a refund, or a replacement, call lookup_order first with ticket_id.
After calling it, use status, estimated_delivery, and can_refund to recommend an action. Do not issue a refund or replacement yourself.
```

## 4. Verify and troubleshoot

First run an App from the App page and confirm its form, stdout/stderr, and output JSON. Then connect it to a workflow and verify state publication. Verify a Tool App from a workflow that contains its Agent.

| Symptom | Check first |
| --- | --- |
| The form does not appear | Confirm Workrun starts the code from the App page or workflow, and the entry point calls `collect()`, `form()`, or `confirm()`. |
| The workflow fails after form cancellation | Fields absent on cancellation must be optional in the output contract; confirm the code returns `status`. |
| A later node cannot see a Process value | On the **node that produces it**, check it is listed in **Published output keys**. |
| The Agent does not call the tool | Confirm the Tool App is selected; its description and Agent instructions state the condition; and input contains `ticket_id`. |
| Tool arguments are empty or invalid | Check the Tool App input schema uses `ticket_id`; if names differ, configure state binding. |

Run history retains App stdout/stderr, tool inputs and outputs, and node events. Locate the failing node first, then decide whether to change code, schema, permissions, instructions, or model configuration.

For the complete runtime-form API, see [Apps, tools, and MCP](/concepts/apps-tools-and-mcp/#runtime-json-schema-forms-let-code-wait-for-a-person). To reuse an existing tool service, see [Connect an MCP Server](/guides/connect-an-mcp-server/).
