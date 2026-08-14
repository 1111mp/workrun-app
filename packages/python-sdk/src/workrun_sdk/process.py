"""Workflow Process Node helpers."""

from __future__ import annotations

import os

from ._protocol import JsonObject
from .ui import _get_client


def result(data: JsonObject) -> None:
    """Return one JSON object to a workflow host; do nothing for standalone runs."""
    if not isinstance(data, dict):
        raise TypeError("process.result data must be a JSON object")
    if not os.environ.get("WORKRUN_IPC_ENDPOINT"):
        return
    _get_client().emit({"type": "process.result", "data": data})
