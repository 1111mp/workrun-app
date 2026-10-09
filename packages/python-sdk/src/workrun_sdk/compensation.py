"""Context for a separate App compensation entrypoint.

The host sends frozen original records on stdin, just like normal App input.
This module never selects or invokes the business entrypoint.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass

from ._protocol import JsonObject, JsonValue
from .process import result


@dataclass(frozen=True)
class CompensationContext:
    original_operation_id: str
    compensation_id: str
    original_input: JsonObject
    original_result: JsonValue
    resources: tuple[JsonValue, ...]


def context() -> CompensationContext:
    """Read once in compensate.py; ordinary App input is rejected."""
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("Compensation context must be a JSON object")
    for field in ("originalOperationId", "compensationId"):
        if not isinstance(payload.get(field), str) or not payload[field]:
            raise ValueError(f"Compensation context requires {field}")
    if not isinstance(payload.get("originalInput"), dict):
        raise ValueError("Compensation context requires originalInput object")
    if "originalResult" not in payload or not isinstance(
        payload.get("resources"), list
    ):
        raise ValueError("Compensation context requires originalResult and resources")
    return CompensationContext(
        original_operation_id=payload["originalOperationId"],
        compensation_id=payload["compensationId"],
        original_input=payload["originalInput"],
        original_result=payload["originalResult"],
        resources=tuple(payload["resources"]),
    )


__all__ = ["CompensationContext", "context", "result"]
