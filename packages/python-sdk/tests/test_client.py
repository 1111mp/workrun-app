from __future__ import annotations

import socket
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import workrun_sdk._client as client_module
from workrun_sdk._client import (
    ENDPOINT_ENV,
    RUN_ID_ENV,
    TOKEN_ENV,
    InteractionCancelled,
    WorkrunClient,
    WorkrunConnectionError,
    _open_windows_named_pipe,  # pyright: ignore[reportPrivateUsage]
)
from workrun_sdk._protocol import (
    JsonObject,
    JsonValue,
    ProtocolError,
    receive_message,
    send_message,
)


def serve_once(
    path: Path, response: JsonObject
) -> tuple[threading.Thread, list[JsonObject]]:
    received: list[JsonObject] = []
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(path))
    listener.listen(1)

    def serve() -> None:
        try:
            connection = listener.accept()[0]
            with connection:
                received.append(receive_message(connection))
                request = receive_message(connection)
                received.append(request)
                send_message(connection, {"id": request["id"], **response})
        finally:
            listener.close()

    thread = threading.Thread(target=serve)
    thread.start()
    return thread, received


def test_request_interaction_returns_matching_response() -> None:
    with tempfile.TemporaryDirectory(prefix="wr-", dir="/tmp") as directory:
        endpoint = Path(directory) / "workrun.sock"
        thread, received = serve_once(
            endpoint, {"type": "ui.response", "data": {"name": "Ada"}}
        )

        with WorkrunClient(str(endpoint), "test-token", "run-1") as client:
            result = client.request_interaction(
                schema={"type": "object"},
                title="Name",
                submit_label="Save",
                cancel_label="Back",
            )

        thread.join(timeout=1)
        assert not thread.is_alive()
        assert result == {"name": "Ada"}
        assert received[0]["type"] == "hello"
        assert received[0]["token"] == "test-token"
        assert received[1]["type"] == "ui.request"
        assert received[1]["submitLabel"] == "Save"
        assert received[1]["cancelLabel"] == "Back"


def test_request_interaction_raises_when_cancelled() -> None:
    with tempfile.TemporaryDirectory(prefix="wr-", dir="/tmp") as directory:
        endpoint = Path(directory) / "workrun.sock"
        thread, _ = serve_once(endpoint, {"type": "ui.cancel", "reason": "run stopped"})

        with WorkrunClient(str(endpoint), "test-token", "run-1") as client:
            with pytest.raises(InteractionCancelled, match="run stopped"):
                _ = client.request_interaction(schema={"type": "object"})

        thread.join(timeout=1)
        assert not thread.is_alive()


def test_concurrent_requests_are_dispatched_by_id() -> None:
    endpoint = Path(tempfile.mkdtemp(prefix="wr-", dir="/tmp")) / "workrun.sock"
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.bind(str(endpoint))
    listener.listen(1)

    def serve() -> None:
        try:
            connection = listener.accept()[0]
            with connection:
                _ = receive_message(connection)  # hello
                first = receive_message(connection)
                second = receive_message(connection)
                # Intentionally return the second request first.
                send_message(
                    connection,
                    {"id": second["id"], "type": "ui.response", "data": "second"},
                )
                send_message(
                    connection,
                    {"id": first["id"], "type": "ui.response", "data": "first"},
                )
        finally:
            listener.close()

    server = threading.Thread(target=serve)
    server.start()
    try:

        def request(_: int) -> JsonValue:
            return client.request_interaction(schema={"type": "object"})

        with WorkrunClient(str(endpoint), "test-token", "run-1") as client:
            with ThreadPoolExecutor(max_workers=2) as executor:
                responses = list(executor.map(request, range(2)))
    finally:
        server.join(timeout=1)
        endpoint.unlink(missing_ok=True)
        endpoint.parent.rmdir()

    assert not server.is_alive()
    assert set(responses) == {"first", "second"}


def test_from_environment_requires_all_rust_ipc_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(ENDPOINT_ENV, "/tmp/workrun.sock")
    monkeypatch.setenv(TOKEN_ENV, "token")
    monkeypatch.delenv(RUN_ID_ENV, raising=False)

    with pytest.raises(WorkrunConnectionError, match="credentials are incomplete"):
        _ = WorkrunClient.from_environment()

    monkeypatch.setenv(RUN_ID_ENV, "run-1")
    client = WorkrunClient.from_environment()
    assert isinstance(client, WorkrunClient)


def test_open_windows_named_pipe_retries_when_all_instances_are_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class PipeBusyError(OSError):
        winerror: int = 231

    connection = object()
    attempts = 0
    sleeps: list[float] = []

    def open_pipe(*_: object, **kwargs: object) -> object:
        nonlocal attempts
        assert kwargs == {"buffering": 0}
        attempts += 1
        if attempts == 1:
            raise PipeBusyError()
        return connection

    monkeypatch.setattr(client_module, "open", open_pipe, raising=False)
    monkeypatch.setattr(client_module, "sleep", sleeps.append)

    assert _open_windows_named_pipe(r"\\.\pipe\workrun") is connection
    assert attempts == 2
    assert sleeps == [0.05]


def test_open_windows_named_pipe_stops_after_maximum_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class PipeBusyError(OSError):
        winerror: int = 231

    attempts = 0
    sleeps: list[float] = []

    def open_pipe(*_: object, **kwargs: object) -> object:
        nonlocal attempts
        assert kwargs == {"buffering": 0}
        attempts += 1
        raise PipeBusyError()

    monkeypatch.setattr(client_module, "open", open_pipe, raising=False)
    monkeypatch.setattr(client_module, "sleep", sleeps.append)

    with pytest.raises(PipeBusyError):
        _ = _open_windows_named_pipe(r"\\.\pipe\workrun")

    assert attempts == 5
    assert sleeps == [0.05, 0.5, 1.0, 2.0]


def test_send_message_rejects_non_finite_json_numbers() -> None:
    left, right = socket.socketpair()
    try:
        with pytest.raises(ProtocolError, match="JSON serializable"):
            send_message(left, {"value": float("nan")})
    finally:
        left.close()
        right.close()
