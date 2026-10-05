"""Exercise the SDK against a real Windows duplex named pipe."""

import os
import subprocess
import sys
import threading
from uuid import uuid4

import pytest

from workrun_sdk._protocol import receive_message, send_message


def run_pipe_scenario(script, handler):
    import _winapi
    import msvcrt

    endpoint = rf"\\.\pipe\workrun-test-{uuid4()}"
    handle = _winapi.CreateNamedPipe(endpoint, 3, 0, 1, 65536, 65536, 0, 0)
    errors = []

    def serve():
        try:
            _winapi.ConnectNamedPipe(handle)
            with os.fdopen(msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR), "r+b", buffering=0) as pipe:
                hello = receive_message(pipe)
                assert hello["type"] == "hello"
                handler(pipe)
        except Exception as error:
            errors.append(error)

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    try:
        completed = subprocess.run([sys.executable, "-c", script, endpoint], timeout=10, capture_output=True)
        assert completed.returncode == 0, completed.stderr.decode(errors="replace")
    finally:
        server.join(timeout=2)
    assert not server.is_alive()
    assert not errors, errors


@pytest.mark.skipif(os.name != "nt", reason="Windows named pipes only")
def test_windows_pipe_can_send_while_response_reader_is_waiting() -> None:
    import _winapi
    import msvcrt

    endpoint = rf"\\.\pipe\workrun-test-{uuid4()}"
    handle = _winapi.CreateNamedPipe(endpoint, 3, 0, 1, 65536, 65536, 0, 0)
    received = []

    def serve() -> None:
        _winapi.ConnectNamedPipe(handle)
        with os.fdopen(msvcrt.open_osfhandle(handle, os.O_BINARY | os.O_RDWR), "r+b", buffering=0) as pipe:
            received.append(receive_message(pipe))
            for _ in range(3):
                request = receive_message(pipe)
                received.append(request)
                response_type = "process.result.accepted" if request["type"] == "process.result" else "ui.response"
                send_message(pipe, {"id": request["id"], "type": response_type, "data": {"ok": True}})

    server = threading.Thread(target=serve, daemon=True)
    server.start()
    script = """
import sys, time
from workrun_sdk._client import WorkrunClient
with WorkrunClient(sys.argv[1], 'token', 'run') as client:
    for _ in range(2):
        time.sleep(0.05)
        assert client.request_interaction(schema={'type': 'object'}) == {'ok': True}
    time.sleep(0.05)
    client.emit({'type': 'process.result', 'data': {'status': 'submitted'}})
"""
    completed = subprocess.run([sys.executable, "-c", script, endpoint], timeout=5, capture_output=True)
    assert completed.returncode == 0, completed.stderr.decode(errors="replace")
    server.join(timeout=1)
    assert not server.is_alive()
    assert [message["type"] for message in received] == ["hello", "ui.request", "ui.request", "process.result"]


@pytest.mark.skipif(os.name != "nt", reason="Windows named pipes only")
def test_windows_pipe_dispatches_concurrent_out_of_order_responses():
    def handle(pipe):
        requests = [receive_message(pipe) for _ in range(24)]
        assert len({request["id"] for request in requests}) == 24
        for request in reversed(requests):
            send_message(pipe, {"id": request["id"], "type": "ui.response", "data": request["title"]})

    run_pipe_scenario("""
import sys
from concurrent.futures import ThreadPoolExecutor
from workrun_sdk._client import WorkrunClient
with WorkrunClient(sys.argv[1], 'token', 'run') as client:
    def request(index):
        return client.request_interaction(schema={'type': 'object'}, title=str(index))
    with ThreadPoolExecutor(max_workers=24) as executor:
        assert list(executor.map(request, range(24))) == [str(i) for i in range(24)]
""", handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows named pipes only")
def test_windows_pipe_disconnect_fails_all_pending_requests():
    def handle(pipe):
        for _ in range(8):
            receive_message(pipe)
        # Closing the host pipe must wake every SDK Future.

    run_pipe_scenario("""
import sys
from concurrent.futures import ThreadPoolExecutor
from workrun_sdk._client import WorkrunClient, WorkrunConnectionError
with WorkrunClient(sys.argv[1], 'token', 'run') as client:
    def request(index):
        try:
            client.request_interaction(schema={'type': 'object'}, title=str(index))
        except WorkrunConnectionError:
            return 'disconnected'
        raise AssertionError('request unexpectedly succeeded')
    with ThreadPoolExecutor(max_workers=8) as executor:
        assert list(executor.map(request, range(8))) == ['disconnected'] * 8
""", handle)


@pytest.mark.skipif(os.name != "nt", reason="Windows named pipes only")
def test_windows_pipe_explicit_close_wakes_pending_reader_and_request():
    def handle(pipe):
        receive_message(pipe)
        # Wait for the client's close without returning a response.
        from workrun_sdk._protocol import ProtocolError
        try:
            receive_message(pipe)
        except (OSError, ProtocolError):
            pass

    run_pipe_scenario("""
import sys, time
from concurrent.futures import ThreadPoolExecutor
from workrun_sdk._client import WorkrunClient, WorkrunConnectionError
client = WorkrunClient(sys.argv[1], 'token', 'run')
with ThreadPoolExecutor(max_workers=1) as executor:
    future = executor.submit(client.request_interaction, schema={'type': 'object'})
    time.sleep(0.2)
    client.close()
    try:
        future.result(timeout=2)
    except WorkrunConnectionError:
        pass
    else:
        raise AssertionError('request unexpectedly succeeded')
client._reader_thread.join(timeout=2)
assert not client._reader_thread.is_alive()
""", handle)
