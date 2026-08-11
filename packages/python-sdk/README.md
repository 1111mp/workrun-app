## Workrun Python SDK

This package provides the Python-facing API for scripts launched by Workrun.
The current transport is a local Unix domain socket on macOS/Linux. Windows
named-pipe support requires matching desktop-host support and is not available
yet.

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
from workrun_sdk import confirm, form

if confirm("Publish this workflow?", title="Publish"):
    values = form(
        title="Deployment settings",
        schema={
            "type": "object",
            "properties": {"region": {"type": "string", "enum": ["cn", "us"]}},
            "required": ["region"],
        },
    )
```

Workrun injects `WORKRUN_IPC_ENDPOINT`, `WORKRUN_IPC_TOKEN`, and
`WORKRUN_RUN_ID` into scripts it launches. The current implementation supports
Unix domain sockets; Windows named-pipe support will be added with the desktop
host implementation.
