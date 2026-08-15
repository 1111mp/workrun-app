"""Wire-format helpers for the Workrun local IPC protocol."""

from __future__ import annotations

import json
import socket
from typing import BinaryIO, TypeAlias, cast

MAX_MESSAGE_SIZE = 1_048_576
JsonValue: TypeAlias = (
    None | bool | int | float | str | list["JsonValue"] | dict[str, "JsonValue"]
)
JsonObject: TypeAlias = dict[str, JsonValue]


class ProtocolError(RuntimeError):
    """Raised when a peer sends an invalid or unsupported IPC message."""


IpcConnection: TypeAlias = socket.socket | BinaryIO


def send_message(connection: IpcConnection, message: JsonObject) -> None:
    """Write one UTF-8 JSON message with a four-byte big-endian length prefix."""
    try:
        payload = json.dumps(
            message,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise ProtocolError("IPC message must be JSON serializable") from error

    if len(payload) > MAX_MESSAGE_SIZE:
        raise ProtocolError(f"IPC message exceeds {MAX_MESSAGE_SIZE} bytes")

    _send_all(connection, len(payload).to_bytes(4, byteorder="big") + payload)


def receive_message(connection: IpcConnection) -> JsonObject:
    """Read exactly one length-prefixed JSON object from a local IPC socket."""
    header = _receive_exactly(connection, 4)
    size = int.from_bytes(header, byteorder="big")
    if size > MAX_MESSAGE_SIZE:
        raise ProtocolError(f"IPC message exceeds {MAX_MESSAGE_SIZE} bytes")

    try:
        decoded = cast(
            object,
            json.loads(_receive_exactly(connection, size).decode("utf-8")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProtocolError("IPC peer sent invalid JSON") from error

    if not isinstance(decoded, dict):
        raise ProtocolError("IPC message must be a JSON object")
    message = cast(dict[object, object], decoded)
    if not all(isinstance(key, str) for key in message):
        raise ProtocolError("IPC message object keys must be strings")
    return cast(JsonObject, message)


def _receive_exactly(connection: IpcConnection, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = (
            connection.recv(remaining)
            if isinstance(connection, socket.socket)
            else connection.read(remaining)
        )
        if not chunk:
            raise ProtocolError("IPC connection closed before the message was complete")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _send_all(connection: IpcConnection, payload: bytes) -> None:
    if isinstance(connection, socket.socket):
        connection.sendall(payload)
        return

    offset = 0
    while offset < len(payload):
        written = connection.write(payload[offset:])
        if written == 0:
            raise ProtocolError("IPC connection closed before the message was sent")
        offset += written
    connection.flush()
