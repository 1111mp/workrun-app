from workrun_sdk import process


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
