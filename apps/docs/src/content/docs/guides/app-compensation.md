---
title: App failure compensation
description: Add a separate cleanup entry for Process Apps and Agent Tool Apps to clean up successful calls when a workflow fails.
---

An App may create a file, upload content, or write to an external system before a later workflow step fails. Configure a compensation entry to automatically clean up **successful calls when the workflow finally fails**. You write the cleanup logic: delete this call’s file, retract its publication, or cancel its reservation.

**After fixing the problem, choose Run again to create a new run.** The new run executes the business work again. The original retains its failure and compensation records; cleaned-up resources must not be reused as valid results.

## When compensation runs

| Situation                                                   | Behavior                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Workflow finally fails; App call succeeded and has an entry | Automatic compensation, without execution-time approval                             |
| App call failed or its result is unknown                    | Skip it; failed calls own their cleanup, unknown results need external verification |
| No compensation entry configured                            | Skip it; not every App needs cleanup                                                |
| Workflow completes normally                                 | No compensation                                                                     |
| User stops execution                                        | No automatic compensation; stopping does not undo side effects                      |
| Standalone execution from Apps                              | Outside this workflow-failure cleanup mechanism                                     |

A business result such as `approved: false` or a rejection branch does not trigger cleanup if the workflow finishes normally. Evaluation runs are excluded too; compensation does not replace evaluation isolation. Read-only lookups usually need no cleanup. Irreversible actions, such as sending email, require a business remedy rather than a promise of reversal.

## Minimal example: create a file, delete it after failure

Put these two files in the same App project. `main.py` creates a temporary file and returns its path. `compensate.py` reads that path from the original result and deletes the file created by this call.

```python
# main.py
from tempfile import NamedTemporaryFile
from workrun_sdk import process

with NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as file:
    file.write("Hello, Workrun!")

process.result({"file_path": file.name})
```

```python
# compensate.py
from pathlib import Path
from workrun_sdk import compensation

ctx = compensation.context()
Path(ctx.original_result["file_path"]).unlink(missing_ok=True)
compensation.result({"removed": True})
```

Declare a required string output named `file_path` in the App’s data contract and configure `compensate.py` as its compensation entry. When this App succeeds in a workflow and a later step causes the workflow to fail, Workrun runs the cleanup entry automatically. `missing_ok=True` treats an already absent file as successful cleanup.

The full tutorial below adds cleanup for failed normal calls and a path-scope check during compensation.

## 1. Create a Process App that can be cleaned up

Follow [Use Python Apps](/guides/python-apps/) to create a project and configure the SDK. Create an ordinary App with `main.py` as its normal entry. Add a required string output named `file_path` to its data contract. Each call creates its own temporary file:

```python
# main.py — Process App
from pathlib import Path
from tempfile import gettempdir
from uuid import uuid4
from workrun_sdk import process


def create_file() -> dict[str, str]:
    # Keep generated files outside the App source directory.
    folder = Path(gettempdir()) / "workrun-cleanup-demo"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{uuid4().hex}.txt"
    try:
        path.write_text("Created by this workflow run", encoding="utf-8")
        return {"file_path": str(path)}
    except Exception:
        path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    process.result(create_file())
```

Run it once from Apps and verify the returned path exists. Standalone execution does not automatically remove this file; delete it manually after testing.

## 2. Add a compensation entry in the same project

Create `compensate.py`, sharing `pyproject.toml` and `uv.lock` with the normal entry:

```python
# compensate.py — shared by Process App and Tool App
from pathlib import Path
from tempfile import gettempdir
from workrun_sdk import compensation


def main() -> None:
    ctx = compensation.context()
    path = Path(ctx.original_result["file_path"]).resolve()
    folder = (Path(gettempdir()) / "workrun-cleanup-demo").resolve()
    # Restrict cleanup to files created by this example.
    if path.parent != folder or path.suffix != ".txt":
        raise ValueError("Unexpected cleanup path")
    path.unlink(missing_ok=True)
    compensation.result({"removed_file": str(path)})


if __name__ == "__main__":
    main()
```

In the App details, enable the compensation entry, set it to `compensate.py`, and save the App. **Creating the file alone does not enable cleanup: save the entry configuration too.** The path is relative to the App project and must differ from the normal entry. No second App or user-entered idempotency contract is required.

A successful exit means completion; a nonzero exit means unfinished cleanup. `compensation.result({...})` is optional extra result recording.

The example uses `missing_ok=True`: an already absent file is also a successful cleanup. Idempotent behavior helps with recovery and manual remediation.

## 3. Connect and test the workflow

1. Add a Process node and select this App.
2. Follow it with a dedicated failure-test Process App whose `main.py` contains only `raise RuntimeError("Intentional cleanup test")`. Do not configure compensation for that test App.
3. Run the workflow. Verify the first node returns `file_path` successfully and the next fails.
4. Open the first node’s messages. Watch compensation change from running to succeeded, and verify the file was deleted.
5. Fix or replace the failing node and choose Run again. The new run creates a new file; the original record remains available.

Use test resources. Returning text that says “failed” while execution completes normally does not trigger compensation.

## 4. Use it with an Agent Tool App

A Tool App enables the same `compensate.py` in its own App configuration. Do not add a separate deletion tool to the Agent. Workrun schedules compensation; the model does not choose the cleanup entry.

Create a Tool App with a required string output `file_path`. Keep `create_file()` from the example, remove the normal `process.result(...)` entry block, and use:

```python
# Replace the Process entry block in main.py with this Tool App entry.
from workrun_sdk.tool import tool


@tool(name="create_demo_file", description="Create one temporary demo file.")
def create_demo_file() -> dict[str, str]:
    return create_file()
```

Select the Tool App in an Agent’s tools and instruct the Agent to call `create_demo_file` once. Normal business-tool confirmation still follows its existing policy. Add the failure-test node from step 3 afterward, then check the **Agent node’s messages** and the deleted file.

Compensation is recorded per tool call, not once per Agent node:

- Two successful calls have separate input, result, and operation identities, and are compensated separately—even with identical arguments.
- If the tool succeeds but the Agent fails while preparing its answer, that successful call still qualifies when the workflow finally fails.
- A failed call is skipped without excluding other successful calls.

The Tool App cleanup script uses `compensation.context()` without an `@tool` decorator. Automatic cleanup does not ask for tool approval; normal business-call approvals keep their existing behavior.

## Compensation context: locate resources from original records

`compensation.context()` reads the original call records supplied by Workrun:

| Field                   | Purpose                                                                         |
| ----------------------- | ------------------------------------------------------------------------------- |
| `original_operation_id` | Stable identity of the original call                                            |
| `compensation_id`       | Stable cleanup identity, usable as a deduplication key with compatible services |
| `original_input`        | Actual original input                                                           |
| `original_result`       | Saved successful result, such as a path, upload ID, or reservation ID           |
| `resources`             | Resource information from the original execution record                         |

Clean only resources identified by these records. Do not read current workflow State or delete other tasks’ data by directory or time range. Return precise resource identifiers from the normal entry; Workrun does not automatically discover every partially written resource.

## Inspect and handle compensation results

Cleanup follows recorded dependencies in reverse: retract a publication before deleting its upload. One cleanup failure does not stop independent branches, but related predecessor cleanup waits to avoid removing resources still used by an unretracted successor.

Check the corresponding Process or Agent node’s messages:

| Status                                | Next step                                                                                     |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| Running                               | Wait for completion                                                                           |
| Succeeded                             | Your script handled the resources; the original workflow remains failed                       |
| Failed                                | Check the entry, permissions, dependencies, and cleanup code; verify whether resources remain |
| Blocked / result pending confirmation | Verify external state; do not assume nothing ran or blindly resubmit                          |

Check cleanup output in the owning Process or Agent node messages. Verify unfinished items and remediate them manually. A new business run does not clean old resources. Once old resources are handled, fix the problem and run again.

## Application exit and current limits

Cleanup intent, status, and results are stored locally. Processing pauses while the application is closed and resumes scheduling after restart; this does not provide background execution after exit. Saved successful cleanup results are reused.

If a process produces side effects but stops before the local result is saved, the outcome may be unknown. Workrun does not blindly resubmit; external services still need query or idempotent deduplication support. Failed normal calls may also produce partial effects: handle them inside the App with `try/except/finally` or a business transaction.

Retain the original App source and lockfile until the task is settled. Workrun checks the recorded fingerprint; changed code or lockfiles block old-task compensation. Immutable code bundles are not saved automatically. Keep generated files outside the project, as in this tutorial’s temporary directory. Entry configuration applies to subsequent execution, without retroactively cleaning legacy failed runs.

For further investigation, see [Runs, debugging, and traces](/quality/runs-and-traces/).

## How this differs from Remote Agents

App compensation runs your cleanup code for successful calls when a workflow fails; user Stop does not trigger automatic App compensation. Remote Agents send one best-effort standard A2A cancellation request after workflow failure or Stop for unfinished tasks with a known task ID. They do not poll, retry cancellation, or automatically undo completed business work. Both show progress in node messages. See [Remote Agents and A2A task handling](/guides/remote-agents/).
