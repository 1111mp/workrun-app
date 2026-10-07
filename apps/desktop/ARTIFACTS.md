# Workflow artifacts: first implementation

## Available

- Workflow task and chat inputs accept `file` and `files`.
- Native file selection imports an immutable snapshot into the active personal
  or team workspace under `artifacts/<UUID>/`.
- State carries `$type`, `id`, `version`, `name`, `mimeType`, and `size` only.
  Data, metadata, and SHA-256 verification live on disk. No binary payload is
  added to graph State or durable run events.
- Start validates declared file fields and resource snapshots. Source file
  changes do not affect replay. Missing or corrupted snapshots fail explicitly.
- Process and Tool Apps can read input references and snapshot generated files
  using `workrun_sdk.artifacts`. Session credentials scope resource requests.
  Reads return private temporary copies with the filename/extension preserved,
  never the stored snapshot. Process execution validates declared input/output
  schemas and verifies output snapshots before accepting its result.
- Local Agents select attachment paths from their visible flat State input.
  Images are passed as ADK inline parts; PDF requires Gemini. Unsupported
  adapter/type combinations fail instead of silently becoming text.
- Binary model outputs are registered under the Agent's `artifacts` State key.
- CodeAct automatically maps references in its visible input to private read-only
  copies under `/artifacts`, with reference/path pairs in `/artifacts/manifest.json`.
  Regular files written under `/outputs` are snapshotted into its node `artifacts`
  field after successful execution. Input/output each allow 100 files and 512 MiB
  total; output nesting is limited to 31 directories. Reserved mounts cannot be
  overridden. Files outside `/outputs` are not automatically collected.
- CodeAct tool-confirmation pauses persist output snapshots in private Workrun
  checkpoint metadata and restore them into a new sandbox when resumed. These
  runtime snapshots are not exposed as downstream State until node completion.
  Monty supports a Python subset and no third-party libraries; use Process tools
  for native PDF/image/video processing.
- Human Review displays resource references from its selected content/context
  and optional `attachmentPaths`. Durable pending actions retain references;
  older requests are supported by discovering resources in content/context.
  Images/videos preview in a nested modal, PDFs open in the system viewer, and
  all files can be downloaded without editing or replacing the attachment.
- Resource references pass through routing and subworkflow JSON interfaces.
  Existing State reader permissions apply to these references.
- Output State displays native save actions and in-app previews for images and
  videos using yet-another-react-lightbox in full-screen overlay mode (Video and Zoom plugins).
  PDF previews open a verified disposable `.pdf` copy in the system's
  default PDF application; viewer edits do not alter the run snapshot. Copies
  are kept under the workspace runtime directory; each open receives a new copy.
  In-app preview and model attachment limits are 20 MiB; external PDF opening
  uses the storage limit of 512 MiB. Media playback depends on WebView support.
- Chat's file fields are also available for subsequent messages. References in
  the latest visible global State can be reused or replaced.

## Deliberate scope

This implementation uses immutable IDs (each at version 1), not mutable named
artifact histories. Metadata is committed beside the file instead of in SQLite.
It does not yet expose ADK ToolContext artifact operations, synchronize files
between machines, or embed files into published workflow releases.

Resource bytes are not automatically redacted by the text guardrails. Explicit
sensitive State fields still hide the whole reference from local Agent inputs.

## Remaining phases

- Integrate resource services into the ADK Graph parent invocation context.
- Add video frame/audio extraction and PDF extraction/OCR Process templates.
- Add reference-aware retention, storage management, and failed-import cleanup.
  Snapshots currently remain on disk when run history is deleted, preserving
  replay and shared references. Abandoned selections also remain stored.
- Add release-scoped fixed resources and optional remote blob storage.

## Validation

The [A2A v1.0.1 resource guide](A2A_ARTIFACTS.md) includes a single-node acceptance
workflow and local HTTP fixture for inline file transport, durable returned
resources, downstream access, and protocol limits.

The [Human Review attachment guide](HUMAN_REVIEW_ARTIFACTS.md) describes the
Process-to-review workflow, read permissions, previews, and restart acceptance.
Tests cover scoped attachment selection, hidden/inaccessible fields, nested
paths and deduplication, actual graph pause/approval, durable references after
source removal, and old/new pending-action payload discovery.

The [CodeAct resource guide](CODEACT_ARTIFACTS.md) describes a single-node text
processing workflow, its manifest contract, and downstream State permissions.
Native Monty tests cover actual file reads/writes, read-only input enforcement,
blocked host paths, collisions, durable collection, output limits and symlinks,
and restored serialized continuations. A streamed CodeAct integration test uses
an in-process model fixture and verifies generated references in access-controlled
State after the temporary sandbox has been removed.

The ready-to-use [PDF Process example](../../packages/python-sdk/examples/pdf-process/README.md)
extracts page-numbered text and generates a PDF resource. Its native integration
test runs real Python subprocesses through PythonRuntime and IPC, removes the
original input file, and verifies durable output files and authorized downstream
State/SDK access. The SDK tests also cover scanned and encrypted PDFs.

Automated coverage includes immutable snapshots, corruption and traversal
rejection, authorized Process resource identities, provider/type checks,
redacted or inaccessible Agent inputs, nested UI reference discovery, and SDK
response/error dispatch. Real provider calls and native dialog/media rendering
require a running desktop build and have not been exercised automatically.
