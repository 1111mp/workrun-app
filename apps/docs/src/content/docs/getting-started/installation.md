---
title: Installation and prerequisites
description: Start the Workrun desktop development environment locally.
---

Workrun is a local-first desktop application. For a release build, follow the installer instructions for your platform. For source development, prepare the following environment.

## Prerequisites

- Node.js 24 or newer;
- pnpm 12;
- the Rust toolchain and the Tauri build dependencies for your platform;
- network access for `uv` to download Python and dependencies when developing Python Apps.

## Start the development environment

From the repository root, run:

```bash
pnpm install
pnpm app:dev
```

After the first launch, create a model profile, then create a workflow with the [quickstart](/getting-started/quickstart/).

## Useful commands

```bash
pnpm ui:dev
pnpm typecheck
pnpm oxlint
pnpm test
```

The team service also needs MongoDB and authentication environment variables. See `apps/server/src/env.validation.ts` for the current variable list.
