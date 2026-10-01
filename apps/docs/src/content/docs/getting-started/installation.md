---
title: Installation and prerequisites
description: Download Workrun from GitHub Releases or prepare a local development environment.
---

Most people only need to install the desktop app. Run from source only when developing Workrun, contributing code, or modifying the desktop app.

## Download Workrun

Download the latest release from [Workrun GitHub Releases](https://github.com/1111mp/workrun-app/releases/latest).

1. Under **Assets** on the latest release, choose the installer for your operating system and CPU architecture.
2. Complete your operating system's installation flow.
3. Launch Workrun.

The release page lists the installers and notes that are actually available for the current version. Always download installers from that page, not from third-party sites.

## First launch

On first launch, follow the onboarding flow to choose a personal or team workspace. Then:

1. Open **Settings → Models**.
2. Enter an API key for one provider you want to use.
3. Settings save automatically.
4. Follow the [5-minute quickstart](/getting-started/quickstart/) to create your first workflow.

Do not create a model profile or enter a model ID manually. Workrun provides a built-in model catalog; select a model for the provider you configured in the Agent node. For Ollama, enter a local or remote Ollama endpoint instead of an API key.

## Run from source (developers only)

To develop or modify Workrun, prepare:

- Node.js 24 or newer;
- pnpm 12;
- the Rust toolchain and Tauri build dependencies for your platform;
- network access: `uv` downloads Python and dependencies while developing Python Apps.

After cloning the repository, run this from its root:

```bash
pnpm install
pnpm app:dev
```

## Common development commands

```bash
# Start only the desktop frontend
pnpm ui:dev

# Static checks and tests
pnpm typecheck
pnpm oxlint
pnpm test
```

Local development of the team service also requires MongoDB and authentication environment variables. See the current definitions in `apps/server/src/env.validation.ts`.
