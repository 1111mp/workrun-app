import importlib
import io

import pytest
from workrun_sdk import process, tool
from workrun_sdk import tool as tool_decorator
from workrun_sdk.tool import ToolMetadata

tool_module = importlib.import_module("workrun_sdk.tool")


def test_result_is_a_no_op_when_an_app_runs_standalone(monkeypatch) -> None:
    monkeypatch.delenv("WORKRUN_IPC_ENDPOINT", raising=False)

    process.result({"processed": True})


def test_result_uses_the_shared_ui_client(monkeypatch) -> None:
    class Client:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        def emit(self, message: dict[str, object]) -> None:
            self.messages.append(message)

    client = Client()
    monkeypatch.setenv("WORKRUN_IPC_ENDPOINT", "ipc.sock")
    monkeypatch.setattr(process, "_get_client", lambda: client)

    process.result({"processed": True})

    assert client.messages == [{"type": "process.result", "data": {"processed": True}}]


def test_tool_result_uses_the_shared_ui_client(monkeypatch) -> None:
    class Client:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        def emit(self, message: dict[str, object]) -> None:
            self.messages.append(message)

    client = Client()
    monkeypatch.setenv("WORKRUN_IPC_ENDPOINT", "ipc.sock")
    monkeypatch.setattr(tool_module, "_get_client", lambda: client)

    tool.result({"processed": True})

    assert client.messages == [{"type": "tool.result", "data": {"processed": True}}]


def test_tool_decorator_invokes_function_with_json_input(monkeypatch) -> None:
    class Client:
        def __init__(self) -> None:
            self.messages: list[dict[str, object]] = []

        def emit(self, message: dict[str, object]) -> None:
            self.messages.append(message)

    client = Client()
    monkeypatch.setenv("WORKRUN_IPC_ENDPOINT", "ipc.sock")
    monkeypatch.setattr("sys.stdin", io.StringIO('{"email":"ada@example.com"}'))
    monkeypatch.setattr(tool_module, "_get_client", lambda: client)

    @tool_decorator(name="lookup_customer", description="Query a customer by email.")
    def lookup_customer(email: str) -> dict[str, object]:
        return {"customer": {"email": email, "plan": "pro"}}

    assert tool.metadata(lookup_customer) == ToolMetadata(
        name="lookup_customer", description="Query a customer by email."
    )
    assert client.messages == [
        {
            "type": "tool.result",
            "data": {"customer": {"email": "ada@example.com", "plan": "pro"}},
        }
    ]


def test_tool_decorator_rejects_arguments_that_do_not_match_function(
    monkeypatch,
) -> None:
    monkeypatch.setattr("sys.stdin", io.StringIO('{"unexpected":true}'))

    with pytest.raises(
        TypeError, match="invalid arguments for Tool App `lookup_customer`"
    ):

        @tool
        def lookup_customer(email: str) -> dict[str, object]:
            return {"email": email}
