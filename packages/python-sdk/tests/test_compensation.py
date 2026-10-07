import io
import json

import pytest
from workrun_sdk import compensation


def test_context_loads_original_records_and_stable_compensation_identity(monkeypatch):
    payload = {
        "originalOperationId": "upload-1",
        "compensationId": "undo-1",
        "originalInput": {"filename": "report.pdf"},
        "originalResult": {"fileId": "file-1"},
        "resources": [],
    }
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    ctx = compensation.context()
    assert ctx.original_operation_id == "upload-1"
    assert ctx.compensation_id == "undo-1"
    assert ctx.original_result == {"fileId": "file-1"}
    assert ctx.original_input == {"filename": "report.pdf"}
    assert ctx.resources == ()


@pytest.mark.parametrize("payload", [{}, [], {"originalOperationId": "upload-1"}])
def test_context_rejects_business_input(monkeypatch, payload):
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(payload)))
    with pytest.raises(ValueError, match="Compensation context"):
        compensation.context()


def test_compensation_receipt_uses_existing_acknowledged_process_channel(monkeypatch):
    messages = []

    class Client:
        def emit(self, message):
            messages.append(message)

    monkeypatch.setenv("WORKRUN_IPC_ENDPOINT", "socket")
    monkeypatch.setattr("workrun_sdk.process._get_client", lambda: Client())
    compensation.result({"removed": True})
    assert messages == [{"type": "process.result", "data": {"removed": True}}]


def test_sibling_entry_cleans_original_result_without_rerunning_business(tmp_path):
    import subprocess
    import sys

    (tmp_path / "main.py").write_text(
        "import json\nfrom pathlib import Path\n"
        "Path('business-count').write_text('1')\n"
        "Path('generated.txt').write_text('output')\n"
        "print(json.dumps({'path':str(Path('generated.txt').resolve())}))\n"
    )
    (tmp_path / "compensate.py").write_text(
        "from pathlib import Path\nfrom workrun_sdk import compensation\n"
        "ctx=compensation.context()\n"
        "Path(ctx.original_result['path']).unlink(missing_ok=True)\n"
        "compensation.result({'removed':True})\n"
    )
    business = subprocess.run(
        [sys.executable, "main.py"], cwd=tmp_path, text=True,
        capture_output=True, check=True,
    )
    payload = json.dumps({
        "originalOperationId": "generate-1", "compensationId": "undo-1",
        "originalInput": {}, "originalResult": json.loads(business.stdout),
        "resources": [],
    })
    for _ in range(2):
        subprocess.run(
            [sys.executable, "compensate.py"], cwd=tmp_path, input=payload,
            text=True, capture_output=True, check=True,
        )
    assert not (tmp_path / "generated.txt").exists()
    assert (tmp_path / "business-count").read_text() == "1"
