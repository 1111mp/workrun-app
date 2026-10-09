import hashlib
import json
import re
import sys
from pathlib import Path

from workrun_sdk import process

if __name__ == "__main__":
    state = json.load(sys.stdin)
    case_id = state["caseId"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", case_id):
        raise ValueError("Invalid caseId")
    root = Path("/tmp/workrun-saga-demo") / case_id
    doc = state["document"]
    path = Path(doc["path"])
    if doc["caseId"] != case_id or path.parent != root / "files":
        raise ValueError("Unexpected document")
    if hashlib.sha256(path.read_bytes()).hexdigest() != doc["sha256"]:
        raise ValueError("Document is missing or changed")
    # Read-only: no business resource is created or changed by this App.
    if not (root / "allow-audit.flag").exists():
        raise RuntimeError("DEMO_AUDIT_REJECTED: create allow-audit.flag then run a new task")
    print("AUDIT_APPROVED", flush=True)
    process.result({"audit": {"approved": True}})
