"""Helpers for Tool Apps invoked by a Workrun Agent."""

from __future__ import annotations

import inspect
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from typing import ParamSpec, TypeVar, cast, overload
from weakref import WeakKeyDictionary

from ._protocol import JsonObject
from .ui import _get_client

P = ParamSpec("P")
T = TypeVar("T")


@dataclass(frozen=True)
class ToolMetadata:
    """Descriptive metadata kept with a Tool App function."""

    name: str
    description: str


_METADATA: WeakKeyDictionary[Callable[..., object], ToolMetadata] = WeakKeyDictionary()


def result(data: JsonObject) -> None:
    """Return one JSON object to the invoking Agent; do nothing when standalone."""
    if not isinstance(data, dict):
        raise TypeError("tool.result data must be a JSON object")
    if not os.environ.get("WORKRUN_IPC_ENDPOINT"):
        return
    _get_client().emit({"type": "tool.result", "data": data})


class ToolDecorator:
    """Callable Tool App decorator with the legacy ``result`` escape hatch."""

    @overload
    def __call__(self, function: Callable[P, T], /) -> Callable[P, T]: ...

    @overload
    def __call__(
        self,
        function: None = None,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> Callable[[Callable[P, T]], Callable[P, T]]: ...

    def __call__(
        self,
        function: Callable[..., object] | None = None,
        *,
        name: str | None = None,
        description: str | None = None,
    ) -> (
        Callable[..., object] | Callable[[Callable[..., object]], Callable[..., object]]
    ):
        """Register and run a Tool App function with arguments supplied by Workrun.

        The decorator reads the Agent's JSON object from standard input, invokes
        the decorated function with matching keyword arguments, and returns its
        object result to the Agent. ``name`` and ``description`` are retained as
        metadata for future tool catalog/MCP export support; the App catalog
        remains the current source of the Agent-visible tool definition.
        """

        def decorate(target: Callable[..., object]) -> Callable[..., object]:
            metadata = ToolMetadata(
                name=name or target.__name__,
                description=description or inspect.getdoc(target) or "",
            )
            _METADATA[target] = metadata
            arguments = _read_arguments()
            try:
                bound = inspect.signature(target).bind(**arguments)
            except TypeError as error:
                raise TypeError(
                    f"invalid arguments for Tool App `{metadata.name}`: {error}"
                ) from error
            bound.apply_defaults()
            returned = target(*bound.args, **bound.kwargs)
            if not isinstance(returned, dict):
                raise TypeError(f"Tool App `{metadata.name}` must return a JSON object")
            result(cast(JsonObject, returned))
            return target

        if function is not None:
            return decorate(function)
        return decorate

    def result(self, data: JsonObject) -> None:
        """Return one JSON object without using the decorator entrypoint."""
        result(data)

    def metadata(self, function: Callable[..., object]) -> ToolMetadata | None:
        """Return metadata registered for a decorated Tool App function."""
        return _METADATA.get(function)


tool = ToolDecorator()


def _read_arguments() -> JsonObject:
    raw_input = sys.stdin.read()
    if not raw_input.strip():
        return {}
    try:
        decoded = cast(object, json.loads(raw_input))
    except json.JSONDecodeError as error:
        raise ValueError("Tool App input must be a JSON object") from error
    if not isinstance(decoded, dict):
        raise TypeError("Tool App input must be a JSON object")
    arguments = cast(dict[object, object], decoded)
    if not all(isinstance(key, str) for key in arguments):
        raise TypeError("Tool App input keys must be strings")
    return cast(JsonObject, arguments)
