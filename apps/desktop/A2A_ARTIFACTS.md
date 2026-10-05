# Remote Agent resources (A2A v1.0.1)

Workrun's Remote Agent uses the [A2A v1.0.1 JSON-RPC binding](https://a2a-protocol.org/v1.0.1/specification/).
It does not implement v0.3 discovery, messages, or file parts. The protocol's
wire version is **1.0** (`A2A-Version: 1.0` and interface `protocolVersion: "1.0"`);
this is intentional, even though the specification release is v1.0.1.

## Single-node acceptance workflow

1. Start the local file-transport fixture from the repository root:
   `python3 apps/desktop/examples/a2a-v1/server.py --port 8088`.
   It copies received bytes and returns a receipt; it does not interpret a PDF,
   image, or video and does not call an LLM.
2. Create a workflow with `Start → Remote Agent → End`.
3. Add an input `document` of type **File**, required. Add an optional text input
   `instruction`, for example “Return a copy of this file”.
4. Configure Remote Agent:
   - Service URL: `http://127.0.0.1:8088`.
   - Attachment State paths: `document` (one path per line).
   - Request timeout: `120` seconds.
   - Other identity fields may be left at their defaults.
5. Run with a small PDF, image, or video (all selected files together ≤20 MiB).
6. The remote node's `response` and `messages` contain a receipt with filenames,
   MIME types and byte counts. Its `artifacts` contains durable references to
   `copy-<original filename>` files. Open/download them from the run result.
   Compare downloaded bytes with the originals; the fixture copies them exactly.
   Run events and State must contain references, never base64 or local file paths.

For multiple files, create a **Files** input `documents` and select `documents`.
Nested paths such as `payload.files.0` are also supported. Selecting overlapping
paths sends each local resource once. Leaving paths empty sends State text only,
without file bytes; textual State describes file name/type/size without local IDs.

## Downstream Process or Human Review

For `Remote Agent → Human Review`, allow the review node to read the remote
node's private State. Set the review attachment paths to `artifacts` and its
content key to `response`. For Process nodes, grant the same read permission
and consume `artifacts` through the existing resource SDK. Files are immutable
workspace snapshots, so the original selected file and remote server can be
removed after completion without breaking the completed run's resources.

Remote outputs are `response`, `messages`, `artifacts`, and `remoteTaskId`.
They remain private unless node State permissions or configured global keys
publish them. The same sensitive-field rules apply as for other nodes.
Attachments are selected from the remote node's visible State only; raw-reader
permissions do not bypass Agent redaction. Missing/inaccessible/non-file paths
fail before service discovery.

## Protocol boundary and limits

- Discover `/.well-known/agent-card.json` at the configured service origin.
  Select an advertised `JSONRPC` interface with version `1.0`. Its endpoint must
  have the same origin; redirects are disabled. Optional tenant routing is sent
  on every operation.
- Use `SendStreamingMessage` when streaming is advertised, otherwise
  `SendMessage`. Files are standard Part `raw` base64 bytes with `filename` and
  `mediaType`; no `kind` or nested v0.3 `file` payloads.
- Accept direct Messages, Task snapshots, status updates and artifact updates.
  `append` appends Parts; it does not concatenate unrelated binary files.
  Replacement snapshots overwrite an artifact by `artifactId`. SSE event IDs
  suppress replayed events. Text and data Parts become response text; raw Parts
  become local files only after successful completion and validation.
- Nonterminal tasks are queried with `GetTask`, without resending input.
  Failed, rejected, canceled, input-required and auth-required states fail the
  node explicitly. Remote human interaction and persistent remote-task resume
  are not implemented in this phase.
- Timeout covers discovery, transfer and processing (default 120, range 1–600
  seconds). Dropping/timing out a call stops local I/O and attempts `CancelTask`
  for a known task, with a separate 3-second limit. Remote cancellation is best
  effort, not a guarantee that a remote server stops its work.
- Input and output each allow 10 files / 20 MiB combined decoded bytes. Individual
  JSON/SSE and accumulated output are bounded to 32 MiB; SSE wire traffic to
  64 MiB. Names cannot contain directory separators. Known binary signatures
  must match the declared media type (generic octet-stream is detected locally).
- URL Parts are rejected explicitly. Remote blob fetch/upload, required extensions, gRPC and HTTP+JSON bindings are
  not supported. Authentication is described below.

## Automated verification

Native unit tests cover explicit selection, deduplication, redaction/access,
interface/version/origin validation, Task failure, artifact replacement/append,
invalid Part/base64/name/media type, and file count/size limits.

The opt-in native HTTP test uses a real loopback server. It verifies Agent Card
discovery, exact v1 request fields and headers, tenant routing, fragmented SSE,
replay IDs, non-streaming Task results, polling, timeout `CancelTask`, URL
rejection, actual Graph execution, durable PDF outputs and authorized downstream
State. The same test launches the shipped Python fixture and verifies PDF, image
and video byte round trips. Run:

```sh
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib \
  module::workflow::remote_agent::tests::v1_http_files_stream_poll_and_timeout_closed_loop \
  -- --ignored --exact --nocapture
```

Actual desktop previews/download dialogs and third-party servers still require
manual acceptance with a running desktop build.

## Authentication

The Remote Agent inspector has an **Authentication** section:

1. Set the service URL first. Select **Bearer Token** or **API Key**.
2. Select an existing credential, or click **New credential**, enter a name and
   the secret, and save. For Bearer authentication enter the token only, without
   the `Bearer ` prefix. For API Key set the header name, typically `X-API-Key`.
3. Click **Test connection**. This fetches the Agent Card and validates its
   advertised authentication and v1.0.1 JSONRPC interface without creating a
   task or sending workflow files. For a public Agent Card, this does not prove
   that a private task endpoint will accept the key; that endpoint is checked
   when the workflow runs.
4. **Edit credential** can rename a credential or replace/rotate its secret.
   Leaving the secret blank keeps the saved value. Deleting a credential leaves
   workflows referencing its ID unresolved until another local credential is
   selected.

Workflow JSON stores only `authentication.type`, `credentialId`, and (for
API Key) `headerName`. Credentials are installation-local. Importing a workflow
on another machine requires selecting that machine's credential.

Credential ciphertext is saved in `workrun.yaml` using the existing AES-GCM
helpers and installation encryption key. The credential list and save response
return name/type/origin/ID only; no secret or ciphertext is returned to the
webview. Credential inputs never enter State or the workflow patch. Known secret
values echoed in response text, file names, task IDs and node errors are masked;
binary resource contents retain their original bytes.

A credential is bound to the service origin (scheme, host and port). It cannot
be used after changing a workflow URL to another origin. Authenticated services
require HTTPS, except loopback HTTP for local fixtures. API Key headers cannot
override routing/transport/protocol headers. Redirects remain disabled and the
Agent Card interface must remain on the configured origin. All discovery,
SendMessage, SendStreamingMessage, GetTask and CancelTask requests use the same
sensitive credential header.

Agent Card `securityRequirements` uses v1.0.1's `schemes` map with StringList
scope objects. Requirement alternatives are OR; schemes within an alternative
are AND. This phase supports a single Bearer or header API Key credential;
OAuth flows, query/cookie API keys, mTLS and combined credentials remain
unsupported. A mismatch fails before input is posted. HTTP 401/403 report their
status without echoing the response body or secret.

### Authenticated fixture acceptance

Start the existing fixture with a dummy test token:

```sh
WORKRUN_A2A_TEST_SECRET=test-token python3 apps/desktop/examples/a2a-v1/server.py \
  --port 8088 --auth bearer
```

Set URL `http://127.0.0.1:8088`, create a Bearer credential with `test-token`, and
follow the single-node acceptance steps above. Then edit it to an incorrect
value: connection testing and workflow discovery should return 401. Restore the
correct value and repeat file transfer.

For API Key, start with `--auth apiKey --header X-API-Key`, select API Key
in the node, create a matching credential, and set `X-API-Key` as the header.
The fixture keeps the token in its environment; it does not print its value.

The native HTTP integration test now runs all transport modes with no auth,
Bearer and API Key, checks authentication on every request including polling
and cancellation, checks 401/403 and secret redaction, and launches the Python
fixture in all three modes. UI tests verify write-only save, reference-only
workflow patches, metadata edits without key replacement, deletion and connection
errors. Unit tests verify encrypted YAML round trips, safe public summaries,
origin/type/missing-reference checks, header injection and requirement semantics.
