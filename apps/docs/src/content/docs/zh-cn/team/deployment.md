---
title: 部署 Server、LiteLLM 与 Langfuse
description: 独立部署团队服务，按需连接模型网关或观测后端。
---

Workrun Server、LiteLLM 和 Langfuse 各自配置、独立部署。可以只部署 Server，也可以连接已有 LiteLLM 网关，或把桌面 Trace 发往已有 OTLP collector。不要求统一栈、共享 Docker 网络，也不会自动创建 Team 或 Key。

| 组件                         | 何时需要                                      | Compose 示例                      |
| ---------------------------- | --------------------------------------------- | --------------------------------- |
| Workrun Server + MongoDB     | 团队认证、共享发布版本                        | `apps/server/docker-compose.yaml` |
| LiteLLM + PostgreSQL         | 可选的 Server 模型访问；已有网关可直接复用    | `infra/litellm/compose.yaml`      |
| Langfuse 及其存储、Collector | 可选的桌面 Trace 查看；也可使用其他 OTLP 后端 | `infra/langfuse/compose.yaml`     |

工作流与定时任务仍在桌面设备执行，详见[架构与部署边界](/zh-cn/concepts/architecture/)。

## 先确定是否需要部署

- **个人使用：** 不需要这三项服务，直接按[配置模型访问](/zh-cn/getting-started/model-profiles/)设置本机 Provider。
- **加入已有团队：** 向管理员获取 Server URL，在桌面端登录即可，无需部署。
- **自建团队：** 先部署 Server；团队模型和集中 Trace 都是后续可选步骤。

下面的命令在仓库根目录执行，示例使用 macOS/Linux Bash 或 Windows WSL。先确认 `docker info`、`docker compose version` 可用，并准备好源码。Langfuse 的独立初始化示例还需要 Python 3。`cp ... .env` 仅用于首次配置，已有 `.env` 时直接编辑，避免覆盖正在使用的凭据。

## Workrun Server

启动 Docker Engine 和 Compose，在仓库根目录执行：

```sh
cp apps/server/.env.example apps/server/.env
# 编辑 MongoDB 凭据、BETTER_AUTH_SECRET 和公开 URL。
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml up -d --build
```

将 `SERVER_BASE_URL`、`BETTER_AUTH_URL` 设为相同公网 origin，例如 `https://workrun.example.com`。用 `openssl rand -hex 32` 生成独立认证 secret。示例包含本地 MongoDB 和持久化卷，不映射 MongoDB 宿主机端口。数据库密码应使用 URI 安全字符，或在连接串中正确编码。

本机测试时，首次只需要修改以下值，其余可保持模板默认；远程使用时将两个 URL 一起改成对外地址：

```dotenv
SERVER_BASE_URL=http://localhost:3000
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl-rand-生成的随机值>
MONGO_INITDB_ROOT_USERNAME=workrun
MONGO_INITDB_ROOT_PASSWORD=<另一份随机十六进制密码>
```

Compose 会为 Server 生成容器内 MongoDB URI，模板中的 `MONGODB_URI` 用于在宿主机直接运行 Server。不要将 `http://localhost:3000` 发给其他电脑上的成员：那会指向他们自己的电脑。

镜像首次构建可能需要几分钟。先查看状态；Server 启动完成后再检查认证接口：

```sh
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml ps
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml logs --tail=100 server
curl --fail http://127.0.0.1:3000/api/v1/auth/ok
```

认证接口应返回 `{"ok":true}`。若暂时拒绝连接，等待初始化完成后重试；若容器反复重启，按日志检查配置。

不需要团队模型时，四个可选 LiteLLM 连接/身份变量全部保持未设置。Server 即可独立提供认证和共享版本，不需要 LiteLLM 或 Langfuse。团队用户仍可显式选择本机配置的 Provider 直连。

桌面端在 **设置 → 工作区** 填写公开 Server URL。邮箱/密码登录已启用，GitHub OAuth 可选。Workrun 账号与 LiteLLM、Langfuse 管理员账号互不关联。

## 可选：LiteLLM

已有网关时无需再部署，否则可以启动独立示例：

```sh
cp infra/litellm/.env.example infra/litellm/.env
# 编辑凭据、Provider 模型/Key 和审核过的镜像 tag。
docker compose --env-file infra/litellm/.env -f infra/litellm/compose.yaml up -d
```

分别为 master key、salt 和数据库密码生成随机值，master key 与 salt 保留 `sk-` 前缀。默认 API 地址为 `http://127.0.0.1:4000`。示例镜像 tag 会变化，生产环境固定审核过的版本或 digest。`config.yaml` 中的 `example-model` 仅为示例 alias，不是 Workrun 要求的模型名称。参见[独立部署说明](https://github.com/1111mp/workrun-app/tree/main/infra/litellm)和 [LiteLLM 官方部署文档](https://docs.litellm.ai/docs/proxy/docker_quick_start)。

先在 LiteLLM 管理界面或 API 完成以下操作：

1. 创建 Team，允许访问配置中的模型 alias（示例为 `example-model`），保存其 **Team ID**。
2. 创建 Virtual Key，明确选择刚创建的 Team，允许访问该 alias，保存返回的 **Key**。不要复制 master key。
3. 按需设置 Team/Key 的预算和限流。模型 YAML、Team 权限、Key 权限中的 alias 应一致。

然后取消 `apps/server/.env` 中以下四项的注释并填写真实值：

```dotenv
LITELLM_BASE_URL=https://gateway.example.com/v1
LITELLM_TEAM_KEY=<team-virtual-key>
LITELLM_TEAM_ID=<该-key-所属-team-id>
LITELLM_DEPLOYMENT_ID=workrun-production
```

修改 `.env` 后使用 `up` 重新创建容器，单独 `restart` 不会加载新的环境变量：

```sh
docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml up -d server
```

仅启用该接入时才要求四项同时配置。推理不要使用 master key；部署 ID 保持稳定，共用网关时应唯一。桌面端获取模型目录并使用 Workrun 会话，不接收 LiteLLM 凭据。详见[配置模型访问](/zh-cn/getting-started/model-profiles/)和 [LiteLLM Virtual Keys](https://docs.litellm.ai/docs/proxy/virtual_keys)。

地址必须**从 Server 可达**。容器中的 `localhost` 指向该容器；独立示例默认监听宿主机 loopback。请通过自己选择的私有网络或受保护的网关端点连接，不假定共享 Docker 网络，也不写死 `litellm` 主机名。

### 可选：两套示例运行在同一 Docker 主机

如果没有网关域名，也可以手动把已创建的 Server 容器接入 LiteLLM 示例网络。只在选择这种连接方式时，将 `LITELLM_BASE_URL` 设为 `http://litellm:4000/v1`，执行上面的 `up -d server` 后再运行：

```sh
docker network connect workrun-litellm_default "$(docker compose --env-file apps/server/.env -f apps/server/docker-compose.yaml ps -q server)"
```

这是一种可选的本机连接示例，不修改任何 Compose 依赖。Server 容器重新创建后，需要重新连接网络；长期部署可用自己的网络配置或受保护的网关地址。

## 可选：Langfuse 或其他 OTLP 后端

已有 OTLP/gRPC collector 时，在桌面端 **设置 → 日志** 填写地址并重启即可，不需要修改 Server 或 LiteLLM。

需要自托管 Langfuse 时，按 [`infra/langfuse/README.md`](https://github.com/1111mp/workrun-app/tree/main/infra/langfuse) 初始化独立凭据，再启动它自己的栈：

```sh
docker compose --env-file infra/langfuse/.env -f infra/langfuse/compose.yaml up -d
```

默认本地 Langfuse UI 为 `http://localhost:3033`，Collector OTLP/gRPC 为 `http://127.0.0.1:4317`。Collector 使用项目凭据连接 Langfuse；桌面端填写 Collector 地址，不是 UI URL。这不会启用 Langfuse AI Gateway 或 LiteLLM Langfuse callback。

输入输出正文默认不导出，metadata 可能包含账号身份及 session/run/node/call ID，详见[运行与追踪](/zh-cn/quality/runs-and-traces/)。远程桌面需使用可达且受保护的 collector；配套本地 collector 不验证入站客户端身份。也可以直接使用其他 OTLP 后端，不部署 Langfuse。

Langfuse 的初始登录邮箱为 `LANGFUSE_INIT_USER_EMAIL`（默认 `admin@workrun.local`），密码为 `infra/langfuse/.env` 中的 `LANGFUSE_INIT_USER_PASSWORD`，不是 Workrun 登录密码。首次启动需要完成数据库初始化，再打开 UI。该初始化不用于重置已有账号密码。

## 生产访问与验收

通过自己的反向代理终止 Workrun TLS。对 `/api/v1/llm/` 关闭响应缓冲，读取超时覆盖 `LITELLM_TIMEOUT_MS`（默认 300 秒）。按需允许上传大小，部分 archive 请求可达 200 MB。数据库与管理端口限制在预期私有接口；各组件的公开 URL 与监听地址独立配置。

只验收已启用的组件：

- **Server：** 从另一台桌面登录，发布测试资产，确认另一账号可以使用共享版本。
- **LiteLLM：** 选择 Server 模型并发起小推理请求。模型目录可读不代表 Provider 凭据可用，推理可能产生 Provider 费用。
- **Trace 导出：** 修改 collector 地址后重启桌面端，用非敏感对话/工作流验证所选后端中的记录。

使用对应 Compose 文件执行 `ps`、`logs`、`stop`、`down`。`down` 保留 named volumes，`down -v` 删除数据。独立备份各组件存储与凭据：MongoDB（含 GridFS 资源）、LiteLLM PostgreSQL 与 salt、Langfuse 各存储与 encryption key。桌面本地数据库、App 和 artifacts 需另做设备备份。不要分享包含密钥的 `docker compose config` 解析输出。

## 常见问题

| 现象                       | 优先检查                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Server 反复重启            | `logs server` 中的配置错误、空认证 secret、MongoDB 凭据；LiteLLM 四项要么全部配置，要么全部不配 |
| 本机可用，另一台电脑连不上 | Server 公网 URL、端口/反向代理；`localhost` 只指当前设备                                        |
| 已登录但没有 Server 模型   | Server 是否启用 LiteLLM、网关地址是否从容器可达、Team Key 是否允许目标 alias                    |
| 模型可见但推理失败         | Provider Key/模型可用性、Team/Key 预算、限流和协议支持；不自动切换直连                          |
| 改 `.env` 没生效           | 用 `up -d server` 重新创建，不只是 `restart`；手动接网的容器重建后需重新连接                    |
| Langfuse 没有 Trace        | 桌面已重启、填写的是 OTLP/gRPC collector 地址而非 UI URL、collector 从桌面设备可达              |
| Trace 没有正文             | 正文默认关闭，在桌面日志设置单独开启并重启；并非部署失败                                        |

提交排障信息时只提供脱敏错误与组件版本，不要附 `.env`、完整解析配置或 Key。
