## Workrun Python SDK

This package provides the Python-facing API for scripts launched by Workrun.
It uses a local Unix domain socket on macOS/Linux and a Windows named pipe on
Windows.

The first API is a schema-driven interaction module, allowing Python code to
request a form from the Workrun UI and receive JSON-compatible form data.

```bash
uv sync
uv build
uv run pytest
```

The distribution name is `workrun-sdk`; its Python import package is
`workrun_sdk`.

```python
from workrun_sdk import choice, collect, confirm, form, number

if confirm("Publish this workflow?", title="Publish"):
    values = form(
        title="Deployment settings",
        schema={
            "type": "object",
            "properties": {"region": {"type": "string", "enum": ["cn", "us"]}},
            "required": ["region"],
        },
    )

profile = collect(
    title="Personal information",
    layout=[["gender"], ["height_cm", "weight_kg"]],
    fields={
        "gender": choice(
            "Gender",
            {"male": "Male", "female": "Female"},
            widget="radio",
            ui_options={"inline": True},
        ),
        "height_cm": number(
            "Height (cm)", minimum=50, maximum=300, placeholder="e.g. 165"
        ),
        "weight_kg": number(
            "Weight (kg)", minimum=1, maximum=500, placeholder="e.g. 60"
        ),
    },
)
```

`collect()` is a convenient API for common named inputs. It returns a dictionary
of submitted values, or `None` when cancelled. Use `layout` to group fields into
rows; fields within a row receive equal width. For advanced validation, nested
data, arrays, or custom RJSF UI options, use `form()` with JSON Schema.

Workrun injects `WORKRUN_IPC_ENDPOINT`, `WORKRUN_IPC_TOKEN`, and
`WORKRUN_RUN_ID` into scripts it launches.

### Tool Apps

For a Tool App, define one function with `@tool`. Workrun passes the Agent's
validated arguments as JSON on standard input, invokes the function with
keyword arguments, and sends its returned object back to the Agent.

```python
from workrun_sdk.tool import tool


@tool(
    name="lookup_customer",
    description="Query a customer by email.",
)
def lookup_customer(email: str) -> dict[str, object]:
    return {"customer": {"email": email, "plan": "pro"}}
```

The Tool App's input and output fields configured in Workrun remain the
runtime schemas. `name` and `description` are registered by the SDK so the same
definition can later be exported through an MCP-compatible catalog.
The function must return a JSON object. `tool.result({...})` remains available
for Tool Apps that need manual control of their entrypoint.

By default, every configured input or output field is required. To make a
field optional in an App's data contract, add the Workrun schema extension:

```json
{
  "locale": { "type": "string", "x-workrun-optional": true }
}
```
