---
title: Team publishing and deployment preparation
description: Understand personal and team workspaces, publish reproducible Workflows and Apps, and prepare to self-host the team service.
---

Workrun has two separate workspace modes. **Personal mode** is for building and running on your own computer; **team mode** uses Workrun Server to share, review, and use published versions. Choosing team mode does not deploy workflows to the server: workflows still run in each member's desktop app. The team service manages identity, shared assets, and published versions.

## Choose a workspace mode

| | Personal mode | Team mode |
| --- | --- | --- |
| Best for | Exploration, local development, and independent runs | Collaborative workflows that need sharing, review, and reproducibility |
| Data and assets | Stored in the current device's personal workspace | Workflow and App drafts, releases, and metadata are stored in the team service |
| Sign-in and server | No sign-in or team service required | Requires a team-service connection and sign-in |
| Execution | The desktop app runs local Workflows and Apps | The desktop app runs selected releases and prepares their pinned Team Apps |
| Publishing | Save a draft and continue editing | Publish semantic versions for members to browse, run, and schedule |

![Choose Personal mode or Team mode when you first launch Workrun.](/media/workspace/01-select-workspace-mode.png)

### Make your first selection

After choosing **Personal mode**, fill out your profile and start using Workrun locally. You do not need to deploy or connect a Workrun Server.

![Personal mode: complete your profile to start working locally.](/media/workspace/02-personal-profile-setup.png)

After choosing **Team mode**, enter the Workrun Server address supplied by your team and sign in. Use the team's public HTTPS address—not a container-internal address or `localhost` on another member's computer.

![Team mode: enter the Workrun Server address to continue.](/media/workspace/03-team-server-setup.png)

After connecting to the service, sign in with your team account to access shared Workflows, Apps, and published releases.

![Team mode: sign in to the team workspace after connecting to Workrun Server.](/media/workspace/05-team-sign-in.png)

The modes are not two views of the same assets. A local Workflow or App in personal mode is not automatically shared when you switch to team mode. Create or migrate collaborative assets in team mode, then publish them as versions. You can review or switch modes later in **Settings → Workspace**; save any current draft before switching.

![Settings → Workspace: switch between Personal mode and Team mode.](/media/workspace/04-switch-workspace-mode.png)

> Team mode requires an accessible Workrun Server. It is the collaboration control plane, not a remote executor that replaces a member's computer for Python Apps, model calls, or workflow runs.

## How team publishing works

After connecting to the team service and signing in, team members can browse and run published workflows. Workrun uses semantic versions for Workflows and Apps at publish time.

A published Workflow pins the versions of its Team Apps. Before a run, the desktop app prepares an isolated App copy instead of reading a development version that was changed later. Historical runs, evaluations, and production behavior can therefore be tied to—and reproduced from—the version actually used.

## Before publishing

1. In **Settings → Workspace**, connect to the team service and sign in.
2. Confirm that local Apps referenced by the workflow are installed, and publish a version of every App that needs sharing first.
3. Run required evaluation suites and inspect the quality gate, cost, duration, and failed cases.
4. Select **Publish** in the workflow editor, then confirm the semantic version and release note.
5. Have another member browse or run the published version to verify the team service exposes the intended asset.

Before publishing, complete three checks:

- Run critical evaluation suites and confirm the quality-gate result.
- Verify that referenced Apps, models, and tool permissions are what you intend.
- Write down what changed in this version and how to migrate any incompatible change.

## Use a release after publishing

- Team members run a **published release** from the team workspace; later draft edits do not silently change that run.
- Team-mode schedules must select a published release and pin that version.
- Publish a new version to fix a problem or update a dependency. Do not alter an old version to repair history.
- If a run reports a missing or mismatched Team App release, restore that release before retrying instead of substituting the current development copy.

## Self-hosted team service: deployment preparation

Team mode relies on Workrun Server for its service capabilities. Its backend source lives in `apps/server` and manages team authentication, shared Workflow and App drafts and releases, and their related resources; it depends on MongoDB and Better Auth. Before enabling team mode, deploy Workrun Server to an address members can reach and connect to that address in the desktop app's **Settings → Workspace**.

Plan the deployment boundary as follows:

```text
Workrun desktop apps ── HTTPS ──> reverse proxy / Workrun Server ──> MongoDB (persistent storage)
                                             └──> OAuth providers (optional)
```

### Prepare before launch

1. Provide a stable HTTPS address, such as `https://workrun.example.com`; members connect to it in **Settings → Workspace**.
2. Prepare a MongoDB connection string and persistent storage. Recreating containers must not lose team users, drafts, releases, or file resources.
3. Generate and securely retain `BETTER_AUTH_SECRET`; never use an example value in production. Keep it unchanged during migration or scaling to preserve existing sessions.
4. Set both `SERVER_BASE_URL` and `BETTER_AUTH_URL` to the public HTTPS address, not a container address or `localhost`. If GitHub or Google sign-in is enabled, register the same callback base with the provider.
5. Keep `MONGODB_URI`, OAuth client secrets, and authentication secrets in secret management or an uncommitted environment file—not in images, deployment configuration, or the repository.
6. Terminate TLS at the reverse proxy and expose only required service ports. Keep MongoDB on a private network rather than exposing it to the internet.

The current source of truth for configuration is [`apps/server/.env.example`](https://github.com/1111mp/workrun-app/blob/main/apps/server/.env.example) and `apps/server/src/env.validation.ts`. Configure the runtime environment from those definitions when deploying.

### Launch acceptance checklist

- Sign in through the public team URL and verify the session from a second member's device.
- Create and publish a test App and Workflow; confirm a second member can browse and run the intended release.
- Verify that App resources download and that pinned dependencies of a published Workflow can be prepared.
- Restart the Server container and verify that users, published releases, and resources persist.
- Rehearse restoration of MongoDB data and file resources before storing real team assets.
