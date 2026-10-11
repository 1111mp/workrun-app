"""Verify duplex completion and cancellation without requiring a Windows host."""

import sys
from threading import Event, Thread
from types import SimpleNamespace

import pytest
from workrun_sdk._windows_pipe import WindowsPipe


def test_pending_pipe_read_allows_write_and_close_cancels_reader(monkeypatch):
    read_started = Event()
    cancelled = Event()
    written = []
    closed = []

    class Operation:
        def __init__(self, payload=None):
            self.payload = payload

        def GetOverlappedResult(self, wait: bool) -> tuple[int, int]:
            assert wait is True
            if self.payload is None:
                assert cancelled.wait(2)
                return 0, 995
            return len(self.payload), 0

        def cancel(self):
            cancelled.set()

    def read(handle, size, *, overlapped):
        assert (handle, size, overlapped) == (123, 4, True)
        read_started.set()
        return Operation(), 997

    def write(handle, payload, *, overlapped):
        assert (handle, overlapped) == (123, True)
        written.append(payload)
        return Operation(payload), 0

    def create(*args):
        assert args == ("endpoint", 3, 0, 0, 3, 4, 0)
        return 123

    api = SimpleNamespace(
        GENERIC_READ=1,
        GENERIC_WRITE=2,
        OPEN_EXISTING=3,
        FILE_FLAG_OVERLAPPED=4,
        CreateFile=create,
        ReadFile=read,
        WriteFile=write,
        CloseHandle=closed.append,
    )
    monkeypatch.setitem(sys.modules, "_winapi", api)
    pipe = WindowsPipe("endpoint")
    errors = []

    def receive():
        try:
            pipe.read(4)
        except OSError as error:
            errors.append(error)

    reader = Thread(target=receive)
    reader.start()
    assert read_started.wait(2)
    assert pipe.write(b"hello") == 5
    assert written == [b"hello"]
    pipe.close()
    reader.join(2)
    assert not reader.is_alive()
    assert len(errors) == 1
    assert closed == [123]
    assert pipe.closed
    pipe.close()
    assert closed == [123]
    with pytest.raises(OSError, match="closed"):
        pipe.write(b"late")


def test_pipe_returns_completed_bytes_and_surfaces_native_errors(monkeypatch):
    closed = []

    class Operation:
        def GetOverlappedResult(self, wait: bool) -> tuple[int, int]:
            assert wait
            return 3, 0

        def getbuffer(self):
            return memoryview(b"abc")

    api = SimpleNamespace(
        GENERIC_READ=1,
        GENERIC_WRITE=2,
        OPEN_EXISTING=3,
        FILE_FLAG_OVERLAPPED=4,
        CreateFile=lambda *args: 123,
        ReadFile=lambda *args, **kwargs: (Operation(), 0),
        CloseHandle=closed.append,
    )
    monkeypatch.setitem(sys.modules, "_winapi", api)
    pipe = WindowsPipe("endpoint")
    assert pipe.read(20) == b"abc"
    assert not pipe._operations

    class FailedOperation(Operation):
        def GetOverlappedResult(self, wait: bool) -> tuple[int, int]:
            return 0, 109

    api.ReadFile = lambda *args, **kwargs: (FailedOperation(), 997)
    with pytest.raises(OSError) as error:
        pipe.read(20)
    assert error.value.errno == 109
    assert not pipe._operations
    pipe.close()
    assert closed == [123]
