---
title: Apps, tools, and MCP
description: "Choose the right execution model: Process App, Tool App, MCP server, or Skill."
---

Workrun brings code projects and the Agent tool ecosystem into the same workflow. Each has a different job.

| Capability | Called by | Best for |
| --- | --- | --- |
| Process App | A workflow node | Data processing, integrations, and deterministic business rules |
| Tool App | An Agent | Queries, calculations, or actions with JSON Schema parameters |
| MCP server | An Agent | Existing local or remote tool ecosystems |
| Skill | An Agent | Progressively loaded task guidance and a constrained tool set |

Every Python App is an editable local `uv` project with its own `pyproject.toml`, lockfile, virtual environment, and entry script. A Process App returns its result with `workrun_sdk.process.result(...)`.

MCP servers support local `stdio` and remote Streamable HTTP. Remote services can use no authentication, a Bearer token, or OAuth; credentials are encrypted and stored only on the local machine.

> Local Apps are not sandboxes. Run only code you trust and review it according to the permissions it actually has.
