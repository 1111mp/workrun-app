# Personal Workflow sharing, version 1

Workflow sharing uses the same standard ZIP/TAR archive reader, writer and source
selection as App sharing. ZIP accepts stored or deflated entries; TAR is
uncompressed. The package has no enclosing wrapper directory:

```text
manifest.json
workflow.json
apps/
  <package-app-uuid>/
    app.json
    app/
      pyproject.toml
      main.py
      ...
workflows/
  <package-workflow-uuid>/
    workflow.json
```

`workflow.json` contains the main saved Workflow document (`nodes`, `edges`,
`settings`), including its editor layout. Child Workflow files have the same
shape. App settings use the portable allowlist described in `APP_SHARING.md`;
App source uses the common team-publishing collector, including nested
`.gitignore` rules and mandatory exclusions.

## Manifest and dependencies

The manifest has `format: "workrun-workflow"`, `formatVersion: 1`, `exportedAt`,
`workrunVersion`, `entryWorkflowId`, `workflows`, `apps` and `requirements`.
Workflow/App entries have package-local `id` and `name` fields. They select the
fixed paths above; they cannot supply arbitrary archive paths. Export IDs denote
the source objects, but import allocates fresh local IDs for every object.

Export collects a closed, deduplicated graph by identity, including:

- Process nodes, with consistent `processNodeId` and local `appRef` references.
- Agent/CodeAct Tool Apps, tool-state bindings, tool-compensation map keys and
  compensation actions targeting a Tool App or process App.
- Recursively referenced child Workflows and all their App dependencies.

Missing local dependencies and Team App references fail export. Subworkflow cycles
fail validation; packages allow at most 200 Workflows and 32 dependency levels.
Import rejects undeclared references, unrelated Workflows, unused App payloads,
unknown requirement kinds and unused requirements. Generic archive protections
and the 512 MiB / 20,000-entry limits apply; each metadata JSON is limited to 2 MiB.

## External configuration

Requirements have `id`, `kind`, `label` and optional public `suggestedValue`,
`origin` and `credentialKind` fields. Supported kinds are model, MCP tool, Skill,
credential, mount, environment and URL. Referencing fields and compensation-map
keys carry `workrun-import:<requirement-id>` placeholders.

Models retain only a public model-ID suggestion. Skills retain only a name
suggestion; Skill source is not bundled in version 1. Credential IDs, host paths
and environment values are removed. URLs containing credentials, query strings
or fragments become requirements too. MCP server configuration and credentials
are never bundled. Secrets embedded manually in prompts, schemas or App source
cannot be identified automatically and need review before sharing.

Import offers matching public models and unrestricted installed Skills as defaults.
Restricted Skills must be explicitly selected and compatible with the imported
tool IDs; export-time App IDs in a Skill's `allowed-tools` cannot authorize fresh
imported Apps. MCP tools bind to available local MCP tools. Remote credentials must
match the requirement's service origin and authentication kind. Other settings
can be supplied during import or left pending.

## Import, later configuration and execution

Preview validates the complete archive and returns its SHA-256. Import verifies
the digest again, assigns every new ID, and remaps all definition references
without replacing strings in instructions or schemas. Unresolved placeholders
are namespaced per imported copy. Pending requirement metadata lives in node data
so it survives saved Workflow documents and is available from the editor's
"Configure imported dependencies" action.

Later configuration updates the parent and child definitions together, including
tool-state bindings and compensation-map keys. A snapshot fingerprint rejects
stale previews. Existing Workflow/App IDs and original creation times are kept.
Resolved requirement records are removed. Manual node edits are recognized by
checking whether the actual reference still contains its placeholder.

Before an imported Workflow runs, its reachable child definitions are checked for
pending placeholders and Skill/tool compatibility. Pending configuration blocks
execution before any graph node runs. This check does not replace the normal
runtime validation of models, tools and other services.

App source is prepared in temporary directories on the managed App filesystem
and activated by rename. Both catalog update permits are held while atomic file
replacements persist the App and Workflow catalogs. On a Workflow-catalog write
failure, the App catalog is restored and newly activated source is removed. If
restoring the App catalog itself fails, source is retained and the error reports
that recovery is needed. These are two catalog files, not a database transaction;
the import does not promise crash atomicity across a system interruption.

Import does not execute code, install dependencies, copy history or enable
schedules. App dependency installation is a separate action and resumes after
successfully prepared Apps when retrying a failure.
