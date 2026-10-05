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
  Reads return private temporary copies, never the stored snapshot.
- Local Agents select attachment paths from their visible flat State input.
  Images are passed as ADK inline parts; PDF requires Gemini. Unsupported
  adapter/type combinations fail instead of silently becoming text.
- Binary model outputs are registered under the Agent's `artifacts` State key.
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
- Add CodeAct resource mounts and generated-file collection.
- Add attachment presentation within human review actions.
- Add A2A/remote Agent transport with authorized resource delivery.
- Add video frame/audio extraction and PDF extraction/OCR Process templates.
- Add reference-aware retention, storage management, and failed-import cleanup.
  Snapshots currently remain on disk when run history is deleted, preserving
  replay and shared references. Abandoned selections also remain stored.
- Add release-scoped fixed resources and optional remote blob storage.

## Validation

Automated coverage includes immutable snapshots, corruption and traversal
rejection, authorized Process resource identities, provider/type checks,
redacted or inaccessible Agent inputs, nested UI reference discovery, and SDK
response/error dispatch. Real provider calls and native dialog/media rendering
require a running desktop build and have not been exercised automatically.
