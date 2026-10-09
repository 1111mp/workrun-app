"""Keep generated files outside App source so they do not alter its fingerprint."""

import hashlib
import json
import re
import uuid
from pathlib import Path

BASE = Path("/tmp/workrun-saga-demo")


def case_directory(case_id):
    if not isinstance(case_id, str) or not re.fullmatch(
        r"[A-Za-z0-9_-]{1,64}", case_id
    ):
        raise ValueError(
            "caseId must contain 1-64 letters, digits, underscores or hyphens"
        )
    return BASE / case_id


def generate(case_id):
    root = case_directory(case_id)
    files = root / "files"
    files.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    content = f"Generated for {case_id}; token={token}\n".encode()
    path = files / f"{token}.txt"
    path.write_bytes(content)
    result = {
        "document": {
            "caseId": case_id,
            "token": token,
            "path": str(path),
            "sha256": hashlib.sha256(content).hexdigest(),
        }
    }
    # Diagnostic evidence deliberately survives business compensation.
    with (root / "executions.jsonl").open("a") as log:
        log.write(json.dumps(result) + "\n")
    print("BUSINESS_EXECUTED " + json.dumps(result), flush=True)
    return result
