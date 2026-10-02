"""Workflow Process Node helpers."""

from __future__ import annotations

import os
from collections.abc import Mapping

from ._protocol import JsonObject, JsonValue
from .ui import _get_client


def result(data: Mapping[str, JsonValue]) -> None:
    """Return one JSON object to a workflow host; do nothing for standalone runs."""
    if not isinstance(data, Mapping):
        raise TypeError("process.result data must be a JSON object")
    if not os.environ.get("WORKRUN_IPC_ENDPOINT"):
        return
    payload: JsonObject = {"type": "process.result", "data": dict(data)}
    _get_client().emit(payload)
