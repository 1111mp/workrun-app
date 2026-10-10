"""Duplex named-pipe I/O using Windows completion events."""

from __future__ import annotations

import io
from importlib import import_module
from threading import Lock
from typing import Literal, overload


class WindowsPipe(io.RawIOBase):
    """Keep a pending read from blocking writes on the same pipe handle."""

    def __init__(self, endpoint: str) -> None:
        # Load lazily: _winapi is only available on Windows, while this module
        # is also imported by cross-platform SDK tests and type checkers.
        _winapi = import_module("_winapi")

        super().__init__()
        self._lock = Lock()
        self._closing = False
        self._operations = set()
        self._handle = None
        self._handle = _winapi.CreateFile(
            endpoint,
            _winapi.GENERIC_READ | _winapi.GENERIC_WRITE,
            0,
            0,
            _winapi.OPEN_EXISTING,
            _winapi.FILE_FLAG_OVERLAPPED,
            0,
        )

    @overload
    def _perform(self, value: int, *, reading: Literal[True]) -> bytes: ...

    @overload
    def _perform(self, value: bytes, *, reading: Literal[False]) -> int: ...

    def _perform(self, value: int | bytes, *, reading: bool) -> bytes | int:
        _winapi = import_module("_winapi")

        with self._lock:
            if self._closing:
                raise OSError("Workrun IPC connection was closed")
            operation, _ = (
                _winapi.ReadFile(self._handle, value, overlapped=True)
                if reading
                else _winapi.WriteFile(self._handle, value, overlapped=True)
            )
            self._operations.add(operation)
        try:
            # The kernel signals completion; no PeekNamedPipe or timed checks.
            count, error = operation.GetOverlappedResult(True)
            if error:
                raise OSError(error, "Workrun named-pipe I/O failed")
            return bytes(operation.getbuffer()) if reading else count
        finally:
            with self._lock:
                self._operations.discard(operation)

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            raise ValueError("Named-pipe reads require a size")
        return self._perform(size, reading=True)

    def write(self, data) -> int:
        return self._perform(bytes(data), reading=False)

    def close(self) -> None:
        _winapi = import_module("_winapi")

        with self._lock:
            if self._closing:
                return
            self._closing = True
            operations = tuple(self._operations)
            for operation in operations:
                operation.cancel()
        # Retain the handle and OVERLAPPED buffers until cancellation completes.
        for operation in operations:
            try:
                operation.GetOverlappedResult(True)
            except OSError:
                pass
        if self._handle is not None:
            _winapi.CloseHandle(self._handle)
        super().close()
