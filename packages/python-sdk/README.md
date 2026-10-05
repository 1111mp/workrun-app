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

Desktop Rust library tests on Windows MSVC require Common Controls v6 in the
test executable. After preparing this SDK's test environment, run from the
repository root:

```bash
cargo test --manifest-path apps/desktop/Cargo.toml -p workrun --lib --features windows-test-manifest
```

Keep `windows-test-manifest` disabled for normal Desktop builds. macOS and Linux
do not need this feature; their build scripts do not emit Windows manifest flags.
`--all-features` also enables the test manifest on Windows MSVC; use default
features when building the application for distribution.

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

### Concurrent requests

The SDK shares one IPC client across `collect()`, `form()`, `confirm()`, and
result helpers in a Python process. Multiple threads can call these helpers
concurrently: writes are serialized to preserve message boundaries, and one
reader matches responses to request IDs, including responses arriving out of
order. Each call blocks only its calling thread until its response arrives.

Separate App runs have separate session IDs and tokens. Desktop queues their
forms in arrival order and displays one form at a time. Ending an App session
removes its queued forms; losing the connection fails pending SDK requests.
One session accepts one active connection, so child processes should not create
independent SDK clients with credentials inherited from their parent.

The Desktop scheduler currently allows two top-level Apps to execute at once,
within a total limit of four top-level App/Workflow runs. Further runs remain
queued. Workflow-internal Apps execute as part of their workflow rather than
consuming another top-level App slot.

IPC frames are limited to 1 MiB each. User interaction calls have no automatic
timeout. Pending forms are held in the current renderer and are not restored
after a full renderer reload. Cancelling an App during dependency preparation
currently waits for that preparation operation to return before completing.

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

### Workflow files

Configure a Workflow input as **File** or **Multiple files**. Files travel as
JSON references, never as paths or base64 data in State. For a Process or Tool
App, declare the corresponding field as an object (or an array of objects).

```python
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from workrun_sdk import artifacts, process

inputs = json.load(sys.stdin)
source = artifacts.path(inputs["document"])
with TemporaryDirectory() as directory:
    report = Path(directory) / "report.pdf"
    report.write_bytes(source.read_bytes())  # Replace with your PDF processing.
    process.result({"report": artifacts.save(report)})
```

`artifacts.path(reference)` returns a private file copy valid for the current
process session. `artifacts.read(reference)` returns its bytes. Reads require a
reference received in the process input or created by that process.
`artifacts.save(path)` snapshots a generated file and returns a reference that
can be passed to downstream nodes. These operations require a Workrun host;
resource failures raise `WorkrunConnectionError`.

Snapshots are immutable and local to the active workspace. Each save creates a
new ID at version 1. The original file can change or disappear without changing
a run's resource. Individual files are limited to 512 MiB.

In a local Agent's **Model attachment paths**, enter one path per line using the
Agent's flat visible input, e.g. `document` or `report`. Grant the Agent read
access to the producing Process node when consuming its output. Attachments
must be explicitly selected; text alone containing a reference does not send
the binary content to the model. Use a vision-capable model for images. PDF
input currently requires the Gemini adapter. Model attachments total at most
20 MiB. Video files can be passed to Process nodes; direct video model analysis
is not implemented yet.
