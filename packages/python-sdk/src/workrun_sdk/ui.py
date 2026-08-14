"""Schema-driven user interactions rendered by the Workrun desktop UI."""

from __future__ import annotations

import atexit
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from threading import Lock
from typing import Literal

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


@dataclass(frozen=True)
class Field:
    """A user-facing field used by :func:`collect`."""

    schema: JsonObject
    ui_schema: JsonObject | None = None
    required: bool = False


def _ui_schema(
    *,
    widget: str | None = None,
    options: Mapping[str, JsonValue] | None = None,
) -> JsonObject | None:
    ui_schema: JsonObject = {}
    if widget is not None:
        ui_schema["ui:widget"] = widget
    if options is not None:
        ui_schema["ui:options"] = dict(options)
    return ui_schema or None


def text(
    label: str,
    *,
    description: str | None = None,
    required: bool = False,
    placeholder: str | None = None,
    multiline: bool = False,
    ui_options: Mapping[str, JsonValue] | None = None,
) -> Field:
    """Create a text field for :func:`collect`."""
    schema: JsonObject = {"type": "string", "title": label}
    if description is not None:
        schema["description"] = description
    ui_schema: JsonObject = (
        _ui_schema(
            widget="textarea" if multiline else None,
            options=ui_options,
        )
        or {}
    )
    if placeholder is not None:
        ui_schema["ui:placeholder"] = placeholder
    return Field(schema=schema, ui_schema=ui_schema or None, required=required)


def number(
    label: str,
    *,
    description: str | None = None,
    required: bool = False,
    minimum: float | None = None,
    maximum: float | None = None,
    integer: bool = False,
    placeholder: str | None = None,
    ui_options: Mapping[str, JsonValue] | None = None,
) -> Field:
    """Create a numeric field for :func:`collect`."""
    schema: JsonObject = {"type": "integer" if integer else "number", "title": label}
    if description is not None:
        schema["description"] = description
    if minimum is not None:
        schema["minimum"] = minimum
    if maximum is not None:
        schema["maximum"] = maximum
    ui_schema = _ui_schema(options=ui_options) or {}
    if placeholder is not None:
        ui_schema["ui:placeholder"] = placeholder
    return Field(schema=schema, ui_schema=ui_schema or None, required=required)


def choice(
    label: str,
    options: Mapping[str, str],
    *,
    description: str | None = None,
    required: bool = False,
    widget: Literal["radio", "select"] = "select",
    ui_options: Mapping[str, JsonValue] | None = None,
) -> Field:
    """Create a single-choice field whose mapping is ``value: displayed label``."""
    enum_values: list[JsonValue] = [value for value in options]
    enum_labels: list[JsonValue] = [display_label for display_label in options.values()]
    schema: JsonObject = {
        "type": "string",
        "title": label,
        "enum": enum_values,
    }
    if description is not None:
        schema["description"] = description
    ui_schema = _ui_schema(widget=widget, options=ui_options) or {}
    ui_schema["ui:enumNames"] = enum_labels
    return Field(schema=schema, ui_schema=ui_schema, required=required)


def boolean(
    label: str,
    *,
    description: str | None = None,
    required: bool = False,
    ui_options: Mapping[str, JsonValue] | None = None,
) -> Field:
    """Create a true/false field for :func:`collect`."""
    schema: JsonObject = {"type": "boolean", "title": label}
    if description is not None:
        schema["description"] = description
    return Field(
        schema=schema, ui_schema=_ui_schema(options=ui_options), required=required
    )


def form(
    *,
    schema: JsonObject,
    ui_schema: JsonObject | None = None,
    title: str | None = None,
    description: str | None = None,
    submit_label: str | None = None,
    cancel_label: str | None = None,
) -> JsonValue:
    """Display a JSON Schema form and return submitted data, or ``None`` on cancel."""
    return _get_client().request_interaction(
        schema=schema,
        ui_schema=ui_schema,
        title=title,
        description=description,
        submit_label=submit_label,
        cancel_label=cancel_label,
    )


def collect(
    fields: Mapping[str, Field],
    *,
    layout: Sequence[Sequence[str]] | None = None,
    title: str = "Input required",
    description: str | None = None,
    submit_label: str | None = None,
    cancel_label: str | None = None,
) -> JsonValue:
    """Collect named user inputs without manually constructing JSON Schema.

    Returns a dictionary of submitted values, or ``None`` if the user cancels.
    ``layout`` groups field names into visual rows; fields in the same row share
    its available width equally. Fields not included in the layout are appended
    as individual rows.

    Use :func:`form` directly for JSON Schema features not represented by
    the field helpers.
    """
    properties: JsonObject = {}
    ui_schema: JsonObject = {}
    required: list[str] = []
    for name, field in fields.items():
        properties[name] = field.schema
        if field.ui_schema is not None:
            ui_schema[name] = field.ui_schema
        if field.required:
            required.append(name)

    schema: JsonObject = {"type": "object", "properties": properties}
    if required:
        required_names: list[JsonValue] = [name for name in required]
        schema["required"] = required_names

    if layout is not None:
        layout_rows: list[JsonValue] = []
        laid_out: set[str] = set()
        for row in layout:
            row_fields = list(row)
            if not row_fields:
                raise ValueError("layout rows must contain at least one field")
            unknown_fields = set(row_fields).difference(fields)
            if unknown_fields:
                names = ", ".join(sorted(unknown_fields))
                raise ValueError(f"layout contains unknown field names: {names}")
            duplicate_fields = laid_out.intersection(row_fields)
            if duplicate_fields:
                names = ", ".join(sorted(duplicate_fields))
                raise ValueError(f"layout contains fields more than once: {names}")
            laid_out.update(row_fields)
            layout_rows.append(_layout_row(row_fields))

        for name in fields:
            if name not in laid_out:
                layout_rows.append(_layout_row([name]))

        ui_schema["ui:field"] = "LayoutGridField"
        ui_schema["ui:layoutGrid"] = {"ui:row": {"children": layout_rows}}

    return form(
        schema=schema,
        ui_schema=ui_schema or None,
        title=title,
        description=description,
        submit_label=submit_label,
        cancel_label=cancel_label,
    )


def _layout_row(field_names: Sequence[str]) -> JsonObject:
    """Convert one SDK layout row to RJSF's LayoutGridField convention."""
    columns = len(field_names)
    children: list[JsonValue] = [
        {"ui:col": {"span": 1, "children": [name]}} for name in field_names
    ]
    return {"ui:row": {"columns": columns, "children": children}}


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
        schema={"type": "object"},
        submit_label=confirm_label,
    )
    return result is not None
