"""Schema-driven user interactions rendered by the Workrun desktop UI."""

from __future__ import annotations

import atexit
from threading import Lock

from ._client import WorkrunClient
from ._protocol import JsonObject, JsonValue

_client_lock = Lock()
_client: WorkrunClient | None = None


def _get_client() -> WorkrunClient:
    global _client
    with _client_lock:
        if _client is None:
            _client = WorkrunClient.from_environment()
        return _client


def shutdown() -> None:
    """Close the shared IPC connection before the Python process exits."""
    global _client
    with _client_lock:
        client, _client = _client, None
    if client is not None:
        client.close()


_ = atexit.register(shutdown)


def form(
    *,
    schema: JsonObject,
    ui_schema: JsonObject | None = None,
    title: str | None = None,
    description: str | None = None,
) -> JsonValue:
    """Display a JSON Schema form in Workrun and return its submitted data."""
    return _get_client().request_interaction(
        schema=schema,
        ui_schema=ui_schema,
        title=title,
        description=description,
    )


def confirm(
    message: str,
    *,
    title: str = "Confirm",
    confirm_label: str = "Confirm",
) -> bool:
    """Ask the user for confirmation and return ``True`` only when accepted."""
    result = form(
        title=title,
        description=message,
        schema={
            "type": "object",
            "properties": {
                "confirmed": {
                    "type": "boolean",
                    "title": confirm_label,
                }
            },
            "required": ["confirmed"],
        },
    )
    return isinstance(result, dict) and result.get("confirmed") is True
