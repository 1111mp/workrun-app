# Optional LiteLLM deployment

Standalone LiteLLM + PostgreSQL example. It has no dependency on Workrun Server
or Langfuse. Skip this directory if you already have a LiteLLM deployment.

From the repository root:

```sh
cp infra/litellm/.env.example infra/litellm/.env
# Edit .env: unique master key, salt, database password, Provider model/key, image.
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml up -d
```

Use `openssl rand -hex 32` for each random secret; keep the `sk-` prefix on the
master key and salt. Preserve the salt and database credentials with backups.
The example's `main-stable` image tag is mutable; pin a reviewed version/digest
for production. `config.yaml` contains an example alias, `example-model`; replace
or extend it for your Providers. This is not a required Workrun alias.

The default gateway address is `http://127.0.0.1:4000`; PostgreSQL has no host
port. Change the binding or use a reverse proxy/private network when another
service needs access. A container cannot reach a host-loopback listener via its
own `localhost`. No shared network or service hostname is assumed by Workrun.

To connect Workrun, create a Team and a Virtual Key in LiteLLM, then configure
the four optional `LITELLM_*` connection/identity variables in
`apps/server/.env`. Use a gateway URL reachable **from the Server container**.
Never use the master key for Workrun inference. Model permissions, budgets,
and key lifecycle remain managed in LiteLLM.

```sh
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml ps
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml logs --tail=100
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml down
```

`down` retains the database volume; `down -v` deletes it. Workrun authentication,
local workflow execution, and OTLP trace export are configured independently.
See the [deployment guide](../../apps/docs/src/content/docs/team/deployment.md)
for optional same-host network instructions,
and [LiteLLM documentation](https://docs.litellm.ai/docs/proxy/docker_quick_start).
