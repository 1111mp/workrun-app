---
title: Deploy Server, LiteLLM, and Langfuse
description: Deploy the team service and connect an optional model gateway or trace backend independently.
---

Workrun Server, LiteLLM, and Langfuse are configured independently. You can deploy just Server, connect an existing LiteLLM gateway, or export desktop traces to an existing OTLP collector. No combined stack, shared Docker network, or automatic Team/Key provisioning is required.

| Component                            | When needed                                                                 | Compose example                   |
| ------------------------------------ | --------------------------------------------------------------------------- | --------------------------------- |
| Workrun Server + MongoDB             | Team authentication and shared releases                                     | `apps/server/docker-compose.yaml` |
| LiteLLM + PostgreSQL                 | Optional Server-backed model access; reuse an existing gateway if available | `infra/litellm/compose.yaml`      |
| Langfuse + its storage and Collector | Optional desktop trace inspection; another OTLP backend also works          | `infra/langfuse/compose.yaml`     |

Workflows and schedules still execute on desktop devices. See [Architecture](/concepts/architecture/).

## Choose your path

- **Personal use:** none of these services are required. Configure a local Provider using [Model access](/getting-started/model-profiles/).
- **Joining an existing team:** obtain the Server URL from your administrator and sign in from the desktop. No deployment is needed.
- **Hosting a team:** start with Server. Team models and centralized traces are optional next steps.

Run the commands from the repository root in macOS/Linux Bash or Windows WSL. Check that `docker info` and `docker compose version` work and that you have the source checkout. The separate Langfuse initialization example also needs Python 3. Copy an environment template only on first setup; edit an existing `.env` instead of overwriting active credentials.

## Workrun Server

With Docker Engine and Compose running, execute from the repository root:

```sh
cp apps/server/.env.example apps/server/.env
# Edit MongoDB credentials, BETTER_AUTH_SECRET, and public URLs.
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml up -d --build
```

Set `SERVER_BASE_URL` and `BETTER_AUTH_URL` to the same public origin, such as `https://workrun.example.com`. Generate a unique authentication secret with `openssl rand -hex 32`. The example includes local MongoDB and persistent storage; MongoDB is not exposed on a host port. Keep its password URI-safe or correctly URL-encode it in the connection string.

For a first local test, change only these values and leave the other template defaults. For remote use, change both URLs to the public origin:

```dotenv
SERVER_BASE_URL=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<random-value-from-openssl-rand>
MONGO_INITDB_ROOT_USERNAME=workrun
MONGO_INITDB_ROOT_PASSWORD=<a-different-random-hex-password>
```

Compose supplies the Server container's MongoDB URI; the template's `MONGODB_URI` is for running Server directly on the host. Do not send `http://localhost:3000` to members on other computers: it refers to their own machine.

The first image build can take several minutes. Check status, then test authentication after Server has started:

```sh
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml ps
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml logs --tail=100 server
curl --fail http://127.0.0.1:3000/api/v1/auth/ok
```

The authentication endpoint should return `{"ok":true}`. Retry a refused connection after initialization finishes; for a restarting container, inspect its logs.

Leave all four optional LiteLLM connection/identity variables unset when team models are not needed. Server can then provide authentication and shared releases without LiteLLM or Langfuse. Team users can still explicitly select locally configured Provider connections.

Use the public Server URL in the desktop's **Settings → Workspace**. Email/password sign-in is enabled; GitHub OAuth is optional. Workrun accounts are independent of LiteLLM and Langfuse administrator accounts.

## Optional LiteLLM

Skip deployment if you already operate a gateway. Otherwise the standalone example can be started with:

```sh
cp infra/litellm/.env.example infra/litellm/.env
# Edit credentials, Provider model/key, and reviewed image tag.
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml up -d
```

Generate separate random values for the master key, salt, and database password; keep the `sk-` prefix on the master key and salt. The default API address is `http://127.0.0.1:4000`. The image tag in the example is mutable; pin a reviewed release or digest for production. `config.yaml` contains an example alias `example-model`, not a required Workrun model name. See the [standalone README](https://github.com/1111mp/workrun-app/tree/main/infra/litellm) and [LiteLLM deployment documentation](https://docs.litellm.ai/docs/proxy/docker_quick_start).

Use LiteLLM's administration UI or API to:

1. Create a Team allowing the configured model alias (`example-model` in the example), and save its **Team ID**.
2. Create a Virtual Key belonging to that Team with access to the alias, and save the returned **Key**. Do not copy the master key.
3. Set budgets/rate limits as needed. Model aliases must agree across the YAML configuration, Team permissions, and Key permissions.

Then uncomment and fill in these four settings in `apps/server/.env`:

```dotenv
LITELLM_BASE_URL=https://gateway.example.com/v1
LITELLM_TEAM_KEY=<team-virtual-key>
LITELLM_TEAM_ID=<that-key-team-id>
LITELLM_DEPLOYMENT_ID=workrun-production
```

After editing `.env`, use `up` to recreate the container. A plain `restart` does not reload environment variables:

```sh
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml up -d server
```

All four are required only when enabling this integration. Do not use the master key for inference. Keep the deployment ID stable and unique when sharing a gateway. The desktop receives the model catalog and uses its Workrun session; it never receives LiteLLM credentials. See [Model access](/getting-started/model-profiles/) and [LiteLLM Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys).

The URL must be reachable **from Server**. Inside a container, `localhost` refers to that container. The standalone example binds to host loopback by default; connect services through your chosen private network or protected gateway endpoint. Deployments do not assume a shared Docker network or the hostname `litellm`.

### Optional: both examples on one Docker host

Without a gateway domain, you can manually attach the created Server container to the LiteLLM example's network. Only for this connection method, set `LITELLM_BASE_URL=http://litellm:4000/v1`, run `up -d server` as above, then run:

```sh
docker network connect workrun-litellm_default "$(docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml ps -q server)"
```

This optional local example does not change any Compose dependency. Reconnect after recreating Server; for long-lived deployments, use your own network configuration or protected gateway endpoint.

## Optional Langfuse or another OTLP backend

For an existing OTLP/gRPC collector, enter its address in desktop **Settings → Logs** and restart. No Server or LiteLLM changes are needed.

To self-host Langfuse, follow the credential initialization instructions in [`infra/langfuse/README.md`](https://github.com/1111mp/workrun-app/tree/main/infra/langfuse), then start its independent stack:

```sh
docker compose --env-file infra/langfuse/.env -f infra/langfuse/compose.yaml up -d
```

Default local endpoints are Langfuse UI `http://localhost:3033` and Collector OTLP/gRPC `http://127.0.0.1:4317`. The Collector authenticates to the Langfuse project; the desktop connects to the Collector, not the UI URL. This does not enable Langfuse AI Gateway or a LiteLLM Langfuse callback.

Input/output content capture is off by default. Metadata may include account identity and session/run/node/call IDs. See [Runs and traces](/quality/runs-and-traces/). Remote desktops need a reachable, protected collector endpoint; the supplied local collector does not authenticate inbound clients. Other OTLP backends can be used instead of Langfuse.

The initial Langfuse email is `LANGFUSE_INIT_USER_EMAIL` (default `admin@workrun.local`), with `LANGFUSE_INIT_USER_PASSWORD` from `infra/langfuse/.env`. This is not your Workrun password. Allow database initialization to finish before opening the UI; initialization is not a password-reset mechanism for existing accounts.

## Production access and verification

Terminate Workrun TLS at your reverse proxy. For `/api/v1/llm/`, disable response buffering and set read timeouts at least as long as `LITELLM_TIMEOUT_MS` (default 300 seconds). Allow the upload sizes your team needs; some archive requests accept up to 200 MB. Keep database and administration ports on intended private interfaces. Each component's public URLs and bindings are configured separately.

Verify only the components you enabled:

- **Server:** sign in from a second desktop, publish a test asset, and confirm another account can use the release.
- **LiteLLM:** choose a Server model and make a small inference request. Catalog discovery alone does not verify Provider credentials; inference may incur Provider charges.
- **Trace export:** restart the desktop after setting the collector endpoint and verify a non-sensitive conversation/workflow in the selected backend.

Use the corresponding Compose file for `ps`, `logs`, `stop`, or `down`. `down` preserves named volumes; `down -v` deletes them. Back up each deployed component's storage and secrets independently: MongoDB including GridFS resources, LiteLLM PostgreSQL and salt, and Langfuse's stores and encryption key. Desktop databases, Apps, and artifacts require separate device backups. Never share resolved `docker compose config` output containing secrets.

## Troubleshooting

| Symptom                                   | Check first                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Server keeps restarting                   | Configuration errors in `logs server`, empty auth secret, MongoDB credentials; configure all four LiteLLM settings or none |
| Works locally but not on another computer | Public Server URL, ports/reverse proxy; `localhost` always refers to the current device                                    |
| Signed in but no Server models            | Whether LiteLLM is enabled, container-to-gateway connectivity, and the Team Key's alias permissions                        |
| Models listed but inference fails         | Provider key/model availability, Team/Key budget, rate limits, and protocol support; no automatic direct fallback          |
| `.env` change has no effect               | Recreate with `up -d server`, not just `restart`; reconnect manually attached networks after recreation                    |
| No traces in Langfuse                     | Desktop restarted, OTLP/gRPC collector address rather than UI URL, and collector reachable from that desktop               |
| Traces have no content                    | Content capture is off by default; enable it separately in desktop Logs settings and restart                               |

Share redacted errors and component versions when requesting help, not `.env`, resolved configuration, or keys.
