# Local Langfuse

Based on https://github.com/langfuse/langfuse/blob/main/docker-compose.yml.
Local deployment only. Langfuse receives traces; the existing Workrun model
request path is unchanged. Langfuse AI Gateway is not deployed.

- UI: http://localhost:3033
- Login: `admin@workrun.local`; password is `LANGFUSE_INIT_USER_PASSWORD` in `.env`.
- Project: Workrun Desktop (automatically initialized on first startup).
- OTLP/gRPC: `http://127.0.0.1:4317`
- OTLP/HTTP: `http://127.0.0.1:4318`

The generated `.env` contains local credentials, is ignored by Git, and has mode 0600. Keep it together with Docker volumes; losing encryption keys can make stored
secrets unreadable. All published ports bind to loopback.

For a fresh checkout, generate `.env` from the template once (Python 3 required).
This command refuses to overwrite an existing `.env` and does not print secrets.
Do not regenerate credentials for existing Docker volumes.

```sh
python3 - <<'PYSETUP'
import base64
import os
from pathlib import Path
import secrets

root = Path("infra/langfuse")
values = {}
for line in (root / ".env.example").read_text().splitlines():
    if line and not line.startswith("#"):
        key, value = line.split("=", 1)
        if value.startswith("REPLACE_WITH_RANDOM_"):
            value = secrets.token_hex(32)
        elif key == "LANGFUSE_INIT_PROJECT_PUBLIC_KEY":
            value = "pk-lf-" + secrets.token_hex(16)
        elif key == "LANGFUSE_INIT_PROJECT_SECRET_KEY":
            value = "sk-lf-" + secrets.token_hex(32)
        values[key] = value
credentials = values["LANGFUSE_INIT_PROJECT_PUBLIC_KEY"] + ":" + values["LANGFUSE_INIT_PROJECT_SECRET_KEY"]
values["LANGFUSE_AUTH"] = "Basic " + base64.b64encode(credentials.encode()).decode()
fd = os.open(root / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    output.write("\n".join(key + "=" + value for key, value in values.items()) + "\n")
PYSETUP
```

```sh
docker compose -f infra/langfuse/compose.yaml up -d
docker compose -f infra/langfuse/compose.yaml ps
docker compose -f infra/langfuse/compose.yaml logs --tail=100 otel-collector langfuse-web langfuse-worker
docker compose -f infra/langfuse/compose.yaml stop
```

`stop` preserves data. Do not use `down -v` unless you intend to erase local data.
The `.env` is generated for this machine and is not included in a fresh checkout.

## Existing Workrun exporter

Set the Workrun `otlp_endpoint` configuration value to
`http://127.0.0.1:4317` and restart the desktop app (telemetry initializes at startup).
The field is defined in `apps/desktop/src-tauri/src/config/workrun.rs`.

```
Workrun / adk-telemetry -- OTLP gRPC --> Collector :4317
Collector -- OTLP HTTP + project Basic Auth --> Langfuse /api/public/otel
```

The Collector supplies the project credentials and v4 ingestion header.
ADK metrics are accepted and discarded by the `nop` exporter because Langfuse
only ingests traces. Existing telemetry backends can be retained by adding a
second trace exporter to the Collector pipeline.

当前实现复用 ADK 原生模型/工具 span，并补对话、Workflow 和节点业务边界。
在设置 → 日志中开启“导出对话和工作流正文”，重启后记录输入输出。
默认关闭；配置键为 `otlp_capture_content`。

## Exporter source

- Project entry: `apps/desktop/src-tauri/src/core/telemetry.rs`, `init()` calls
  `adk_telemetry::build_otlp_layer`.
- Dependency: `adk-telemetry` 2.3.0, `src/init.rs`: `build_otlp_layer`,
  `otlp_pipeline::build_tracer`, and `.with_tonic()` select OTLP/gRPC.
- Startup entry: `apps/desktop/src-tauri/src/lib.rs`.

See https://langfuse.com/integrations/native/opentelemetry for endpoint/auth details.

## Verification

Deployed Langfuse 4.78.0. `/api/public/health` reports OK. Sent one synthetic
trace using the official `telemetrygen` tool over gRPC to the Collector; the
Langfuse v2 Observations API returned its two spans (`lets-go`, `okey-dokey-0`).
This verifies gRPC -> Collector -> HTTP -> Langfuse storage/query, independently
of Workrun application instrumentation.

### Application verification

`verification.json` 记录原生模型、原生工具及检查点暂停恢复的本地 API 验收结果。
这些隔离样本不执行用户业务工具；真实订单流程需要在新桌面端和 Server 上复测。

```sh
cargo test --manifest-path apps/desktop/Cargo.toml --lib export_native_adk_model --offline -- --ignored --nocapture
cargo test --manifest-path apps/desktop/Cargo.toml --lib export_native_tool_observation --offline -- --ignored --nocapture
cargo test --manifest-path apps/desktop/Cargo.toml --lib export_checkpoint_resume_using_production_context --offline -- --ignored --nocapture
```
