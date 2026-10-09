# Personal App sharing, version 1

App sharing accepts standard `.zip` (stored or deflated) and uncompressed `.tar`
archives. Both formats use the same layout, with no enclosing wrapper directory:

```text
manifest.json
app.json
app/
  .gitignore
  pyproject.toml
  uv.lock
  main.py
  ...
```

## Manifest

```json
{
  "format": "workrun-app",
  "formatVersion": 1,
  "exportedAt": "2026-10-09T08:00:00Z",
  "workrunVersion": "0.1.0-rc.1",
  "sourceDirectory": "app"
}
```

`formatVersion` describes the package protocol, independently of the exporting
client's `workrunVersion`. `sourceDirectory` names one root directory; import also
accepts an App UUID as that directory name. Paths use forward slashes. Unknown
manifest fields are tolerated, but unsupported formats or protocol versions fail.

## App settings

`app.json` contains these portable App-detail settings:

```json
{
  "name": "Example App",
  "description": "A shareable Python App",
  "version": "1.0.0",
  "entry": "main.py",
  "kind": "workflow",
  "toolExecutionPolicy": "ask_every_time",
  "toolRiskLevel": "low",
  "toolPermissions": [],
  "inputs": {},
  "outputs": {}
}
```

Optional `compensation` has the existing App compensation settings, including
its relative `entry`. The main entry, compensation entry when configured, and
`pyproject.toml` must be present in the source directory. `uv.lock` and
`.python-version` are included when selected by source rules.

Export omits local IDs, timestamps, project roots, installation state and Team
release identity. Import ignores these fields if supplied, creates a fresh ID and
timestamps, and stores source under the active personal workspace's managed App
root. Import always creates a copy; it does not overwrite or merge an existing App.

## Source selection

Team publishing and personal export share one source collector. It respects
root and nested `.gitignore` files, including negation, without applying parent,
global Git ignores, `.ignore` or `.git/info/exclude` from the exporting machine.
Default exclusions always apply: `.git`, `.venv`, `__pycache__`, `logs`,
`.DS_Store`, `.env` and `.env.*` except `.env.example`. Selected symlinks fail
export. Users can exclude additional files in the preview; required files cannot
be excluded. If the source file list changes after preview, reopen the preview.

This file selection cannot identify secrets embedded in source or schema defaults;
review the files and saved settings before sharing.

## Import and activation

Preview validates the full archive in a temporary directory and returns settings,
source filenames, source size and an archive SHA-256. Import revalidates the archive
and checks this digest before creating the App. The source is staged on the managed
App filesystem, renamed into place, then committed to the catalog. Failed catalog
writes remove the newly activated source.

Only regular files and directories are accepted. Absolute paths, traversal,
Windows drive/alternate-stream paths, backslashes, links, special files, duplicate
entries and unexpected files outside the declared source directory fail. Limits:
512 MiB archive size, 512 MiB expanded size, 20,000 entries and 2 MiB per metadata
JSON file.

Import does not execute App code or install dependencies. The user can separately
install dependencies (using the project's `.python-version`, defaulting to 3.12)
and retry failures. Existing App execution also prepares dependencies as usual.
