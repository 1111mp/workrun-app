"""Read authorized workflow resources and register generated files."""
from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from ._protocol import JsonObject, JsonValue
from .ui import _get_client


def path(reference: Mapping[str, JsonValue]) -> Path:
    """Materialize a private local copy of an input resource for this process."""
    response = _get_client().emit({"type": "artifact.read", "reference": dict(reference)})
    if not isinstance(response, dict) or not isinstance(response.get("path"), str):
        raise RuntimeError("Host returned an invalid resource path")
    return Path(response["path"])


def read(reference: Mapping[str, JsonValue]) -> bytes:
    """Read the bytes of a resource granted through this process's input."""
    return path(reference).read_bytes()


def save(file: str | Path) -> JsonObject:
    """Snapshot a generated file and return its durable reference for process.result."""
    response = _get_client().emit({"type": "artifact.save", "path": str(Path(file).resolve())})
    if not isinstance(response, dict) or response.get("$type") != "artifact":
        raise RuntimeError("Host returned an invalid resource reference")
    return response
