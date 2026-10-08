import hashlib
import json
from pathlib import Path

from business import case_directory
from workrun_sdk import compensation

if __name__ == "__main__":
    ctx = compensation.context()
    # The SDK accepts any JSON result; this App requires a document object.
    original_result = ctx.original_result
    if not isinstance(original_result, dict):
        raise ValueError("Original result must be an object")
    document = original_result.get("document")
    if not isinstance(document, dict):
        raise ValueError("Original result requires a document object")
    doc: dict[str, str] = {}
    for field in ("caseId", "path", "token", "sha256"):
        value = document.get(field)
        if not isinstance(value, str) or not value:
            raise ValueError(f"Original document requires a non-empty {field}")
        doc[field] = value
    root = case_directory(doc["caseId"])
    if ctx.original_input["caseId"] != doc["caseId"]:
        raise ValueError("Original input and receipt disagree")
    path = Path(doc["path"])
    expected = root / "files" / f"{doc['token']}.txt"
    if path != expected or path.resolve().parent != (root / "files").resolve():
        raise ValueError("Refusing to clean a file outside the original demo directory")
    # This flag fails BEFORE unlink, for an operator-verifiable no-effect case.
    if (root / "fail-compensation.flag").exists():
        raise RuntimeError("Injected failure BEFORE file deletion")
    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() != doc["sha256"]:
        raise ValueError("File contents changed; manual reconciliation required")
    path.unlink(missing_ok=True)
    receipt = {
        "removed": True,
        "path": str(path),
        "compensationId": ctx.compensation_id,
    }
    with (root / "compensations.jsonl").open("a") as log:
        log.write(json.dumps(receipt) + "\n")
    print("COMPENSATED " + json.dumps(receipt), flush=True)
    # A normal exit completes cleanup; compensation.result(receipt) is optional.
