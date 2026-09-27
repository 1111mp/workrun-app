---
title: Versioned publishing
description: Publish reproducible workflows and Apps to a team workspace.
---

After connecting to the team service and signing in, team members can browse and run published workflows. Workrun uses semantic versions for Workflows and Apps at publish time.

## Before publishing

1. In **Settings → Workspace**, connect to the team service and sign in.
2. Confirm that local Apps referenced by the workflow are installed, and publish a version of every App that needs sharing first.
3. Run required evaluation suites and inspect the quality gate, cost, duration, and failed cases.
4. Select **Publish** in the workflow editor, then confirm the semantic version and release note.
5. Have another member browse or run the published version to verify the team service exposes the intended asset.

A published workflow pins the versions of its Team Apps. At runtime, Workrun installs an isolated copy rather than reading a development version that was modified later. Historical runs, evaluation results, and production behavior can therefore be reproduced.

Before publishing, complete three checks:

- Run critical evaluation suites and confirm the quality-gate result.
- Verify that referenced Apps, models, and tool permissions are what you intend.
- Write down what changed in this version and how to migrate any incompatible change.

> **Media placeholder · screenshot `publishing/01-release-dialog.png`**  
> Show the workflow publish dialog with version, evaluation/quality-gate state, and referenced Apps. Do not show private team URLs or member data.
