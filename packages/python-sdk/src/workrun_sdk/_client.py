"""Synchronous client for a Workrun host-provided local IPC endpoint."""

from __future__ import annotations

import os
import socket
from concurrent.futures import Future
from threading import Lock, Thread
from typing import final
from uuid import uuid4

from ._protocol import (
    JsonObject,
    JsonValue,
    ProtocolError,
    receive_message,
    send_message,
)

ENDPOINT_ENV = "WORKRUN_IPC_ENDPOINT"
TOKEN_ENV = "WORKRUN_IPC_TOKEN"
RUN_ID_ENV = "WORKRUN_RUN_ID"


class WorkrunConnectionError(RuntimeError):
    """Raised when the SDK cannot establish a connection to Workrun."""


class InteractionCancelled(RuntimeError):
    """Raised when a pending UI interaction is cancelled by the host or user."""


@final
class WorkrunClient:
    """One serial connection to the desktop host for a single script run."""

    def __init__(self, endpoint: str, token: str, run_id: str) -> None:
        self._endpoint = endpoint
        self._token = token
        self._run_id = run_id
        self._connection: socket.socket | None = None
        self._connection_lock = Lock()
        self._send_lock = Lock()
        self._pending_lock = Lock()
        self._pending: dict[str, Future[JsonValue]] = {}
        self._reader_thread: Thread | None = None

    @classmethod
    def from_environment(cls) -> WorkrunClient:
        endpoint = os.environ.get(ENDPOINT_ENV)
        token = os.environ.get(TOKEN_ENV)
        run_id = os.environ.get(RUN_ID_ENV)
        if not endpoint or not token or not run_id:
            raise WorkrunConnectionError(
                "Workrun IPC credentials are incomplete; run this script from the Workrun desktop app"
            )
        return cls(endpoint, token, run_id)

    def connect(self) -> None:
        with self._connection_lock:
            if self._connection is not None:
                return
            if os.name == "nt":
                raise WorkrunConnectionError(
                    "Windows named-pipe transport is not available in this SDK version"
                )

            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                connection.connect(self._endpoint)
                send_message(
                    connection,
                    {
                        "id": str(uuid4()),
                        "type": "hello",
                        "token": self._token,
                        "runId": self._run_id,
                    },
                )
            except (OSError, ProtocolError) as error:
                connection.close()
                raise WorkrunConnectionError(
                    f"failed to connect to Workrun IPC endpoint: {self._endpoint}"
                ) from error

            self._connection = connection
            self._reader_thread = Thread(
                target=self._read_messages,
                args=(connection,),
                name="workrun-ipc-reader",
                daemon=True,
            )
            self._reader_thread.start()

    def close(self) -> None:
        with self._connection_lock:
            connection, self._connection = self._connection, None
        if connection is not None:
            connection.close()
        self._fail_pending(WorkrunConnectionError("Workrun IPC connection was closed"))

    def __enter__(self) -> WorkrunClient:
        self.connect()
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def request_interaction(
        self,
        *,
        schema: JsonObject,
        ui_schema: JsonObject | None = None,
        title: str | None = None,
        description: str | None = None,
    ) -> JsonValue:
        """Request a schema-driven form and wait for its result or cancellation."""
        self.connect()
        request_id = str(uuid4())
        future: Future[JsonValue] = Future()
        with self._pending_lock:
            self._pending[request_id] = future

        try:
            self._send(
                {
                    "id": request_id,
                    "type": "ui.request",
                    "schema": schema,
                    "uiSchema": ui_schema or {},
                    "title": title,
                    "description": description,
                }
            )
        except (OSError, ProtocolError) as error:
            with self._pending_lock:
                _ = self._pending.pop(request_id, None)
            raise WorkrunConnectionError(
                "failed to send interaction request"
            ) from error

        return future.result()

    def _send(self, message: JsonObject) -> None:
        with self._send_lock:
            with self._connection_lock:
                connection = self._connection
            if connection is None:
                raise WorkrunConnectionError(
                    "Workrun IPC connection was not established"
                )
            send_message(connection, message)

    def _read_messages(self, connection: socket.socket) -> None:
        """The sole socket reader; dispatches every response by request ID."""
        while True:
            try:
                message = receive_message(connection)
            except (OSError, ProtocolError):
                self._connection_lost(connection)
                return
            request_id = message.get("id")
            if not isinstance(request_id, str):
                self._connection_lost(
                    connection, ProtocolError("IPC response is missing a string id")
                )
                return

            with self._pending_lock:
                future = self._pending.pop(request_id, None)
            if future is None:
                continue

            message_type = message.get("type")
            if message_type == "ui.response":
                future.set_result(message.get("data"))
            elif message_type == "ui.cancel":
                future.set_exception(
                    InteractionCancelled(
                        message.get("reason") or "interaction was cancelled"
                    )
                )
            else:
                future.set_exception(
                    ProtocolError(
                        f"unexpected interaction response type: {message_type!r}"
                    )
                )

    def _connection_lost(
        self,
        connection: socket.socket,
        error: Exception | None = None,
    ) -> None:
        """Clear only the failed connection, preserving a later reconnect."""
        with self._connection_lock:
            if self._connection is not connection:
                return
            self._connection = None
        connection.close()
        self._fail_pending(error or WorkrunConnectionError("Workrun IPC connection was lost"))

    def _fail_pending(self, error: Exception) -> None:
        with self._pending_lock:
            pending, self._pending = self._pending, {}
        for future in pending.values():
            if not future.done():
                future.set_exception(error)
