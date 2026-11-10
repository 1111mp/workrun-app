# Workrun Server

Workrun 的 NestJS 服务端应用。当前提供基础 HTTP 服务，并使用 SWC 加速构建、Vitest 运行单元测试与端到端测试。

## 环境要求

- Node.js 24 或更高版本
- pnpm 11

依赖请在仓库根目录安装：

```bash
pnpm install
```

## 开发

从仓库根目录启动服务：

```bash
pnpm server:dev
```

服务默认监听 `http://localhost:3000`。访问根路径可得到：

```text
Hello World!
```

也可以直接运行此 workspace 的脚本：

```bash
pnpm --filter workrun-server dev
```

使用 `PORT` 指定其他端口：

```bash
PORT=4000 pnpm --filter workrun-server dev
```

## 构建与运行

```bash
# 使用 Nest CLI 的 SWC builder 编译到 dist/
pnpm --filter workrun-server build

# 运行已编译的服务
pnpm --filter workrun-server start:prod
```

`nest-cli.json` 已启用 SWC builder；`@swc/core` 负责转换 TypeScript，保留 Nest 所需的 decorator metadata。

## 测试

项目使用 Vitest，并通过 `unplugin-swc` 处理 Nest 的 TypeScript decorators。

```bash
# 单元测试
pnpm --filter workrun-server test

# 监听模式
pnpm --filter workrun-server test:watch

# V8 覆盖率报告（输出到 coverage/）
pnpm --filter workrun-server test:cov

# 端到端测试
pnpm --filter workrun-server test:e2e
```

## 代码质量

```bash
# 静态检查
pnpm --filter workrun-server oxlint

# 自动修复可修复的问题
pnpm --filter workrun-server oxlint:fix

# 检查格式
pnpm --filter workrun-server format

# 写入格式化结果
pnpm --filter workrun-server format:write
```

## 目录结构

```text
src/
├── app.controller.ts        HTTP 控制器
├── app.controller.spec.ts   单元测试
├── app.module.ts            根模块
├── app.service.ts           业务服务
└── main.ts                  应用入口
test/
└── app.e2e-spec.ts          端到端测试
vitest.config.mts            单元测试与覆盖率配置
vitest.e2e.config.mts        端到端测试配置
nest-cli.json                Nest CLI / SWC 构建配置
```

## 团队模型服务（LiteLLM）

第一版采用一个 Workrun Server 对应一个 LiteLLM Team，所有有效登录用户共享该 Team 的模型权限，尚未新增组织成员管理或成员级模型授权。Provider 凭据由 LiteLLM 管理，Team Virtual Key 只配置在 Server；桌面端通过 Workrun 登录会话访问接口，不接收 LiteLLM Key。

### 部署配置

1. 为 LiteLLM 配置数据库，以启用 Virtual Key、预算和用量治理；这与 Workrun 的 MongoDB 相互独立。
2. 在 LiteLLM 创建 Team，设置允许访问的模型、预算和限流，再创建属于该 Team 的应用 Virtual Key。不要使用 master key 处理推理请求。
3. 在 Server 的部署环境配置以下变量，重启后生效：

```dotenv
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_TEAM_KEY=<team-virtual-key>
LITELLM_TEAM_ID=<team-id>
LITELLM_DEPLOYMENT_ID=workrun-production
LITELLM_TIMEOUT_MS=300000
```

`LITELLM_BASE_URL` 是 Server 能访问的地址；在容器里应填写 LiteLLM 的服务名，而不是宿主机的 `localhost`。裸 origin 自动补 `/v1`；自定义路径须包含实际 API 前缀。关闭全部四个连接/身份变量即可禁用模型服务，此时接口返回 503，其他业务接口不受影响。启用时缺少任一配置会阻止 Server 启动。

Team 的实际权限和预算由 Virtual Key 在 LiteLLM 中的归属决定。`LITELLM_TEAM_ID` 必须与管理员创建 Key 时选择的 Team 一致；它用于 Workrun 归因 metadata，不覆盖 LiteLLM 的 Team 授权。

`LITELLM_DEPLOYMENT_ID` 必须稳定且在共享 LiteLLM 的部署间唯一，使用字母、数字、下划线或连字符。Server 根据登录会话生成 `user=workrun:<deploymentId>:<encodedUserId>`。同一用户的交互和后台请求使用相同身份；客户端不能通过请求体或 header 改写它。LiteLLM 的 End User 与 Internal User/Team Member 是不同概念，End User 预算按整个 LiteLLM 部署的用户 ID 累计。

### 接口

| 接口                                | 行为                                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/v1/llm/models`            | 验证登录后返回 OpenAI `{ object: "list", data: [...] }` 模型目录                       |
| `POST /api/v1/llm/chat/completions` | 验证登录及模型可见性，覆盖 End User 和 metadata，返回 Chat Completions JSON 或原始 SSE |
| `POST /api/v1/llm/responses`        | 创建无状态 Responses，返回 output Items 或原始 Responses SSE events                    |

上述接口均复用 Better Auth 的 Bearer token 或会话 Cookie。推理接口不使用普通业务的 `{ errorCode, payload }` 包装；认证失败、参数错误等也返回 `{ error: { message, type, param, code } }`。

```bash
curl http://localhost:3000/api/v1/llm/models \
  -H "Authorization: Bearer $WORKRUN_SESSION_TOKEN"

curl -N http://localhost:3000/api/v1/llm/chat/completions \
  -H "Authorization: Bearer $WORKRUN_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"fast","messages":[{"role":"user","content":"你好"}],"stream":true,"stream_options":{"include_usage":true}}'
```

`model` 必须是该 Team Key 可见的精确 alias。目录在进程内缓存 30 秒，并合并并发查询；推理请求仍由 LiteLLM 实时执行 Key/Team 权限和预算校验。连接失败不回退到其他 Provider。

目录只返回模型 ID、显示名称及显式配置的能力，不暴露 LiteLLM 部署详情。可用以下可选环境变量配置显示名称和已验证的能力；未配置的能力保持未知，不根据 alias 猜测：

```dotenv
LITELLM_MODEL_CATALOG_JSON={"fast":{"name":"快速模型","apiProtocols":["chat_completions","responses"],"capabilities":{"tools":true,"structuredOutput":true,"vision":false,"reasoningEfforts":["low","high"]}}}
```

`apiProtocols` 可设置为 `["chat_completions"]`、`["responses"]` 或两者。声明后 Server 会拒绝该模型未声明的协议；未配置时保持未知，由 LiteLLM 检查实际支持情况，不自动探测或转换协议。此配置不增加模型访问权限。发现列表可能包含非聊天模型，管理员应将应用 Key 的允许模型限定为经过验证的聊天/Agent 模型。第一版未实现成员级模型差异授权、模型管理界面、Responses 资源管理接口、自动创建 Team/Key 或桌面端接线。

### Responses 调用

```bash
curl -N http://localhost:3000/api/v1/llm/responses \
  -H "Authorization: Bearer $WORKRUN_SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"model":"fast","input":"你好","stream":true,"store":false}'
```

Responses 使用 `input`、`instructions`、`reasoning`、`text.format`、`max_output_tokens` 等参数，不转换成 Chat Completions 的 `messages` 或 `response_format`。函数调用和结果通过 `function_call` / `function_call_output` Items（相同 `call_id`）在 `input` 中重放；加密推理 Item 和 `include: ["reasoning.encrypted_content"]` 也按原始内容传递。普通 JSON 返回原始 `output`，流式输出保留 `event: response.*`，不会重写成 Chat chunks 或补充 `[DONE]`。

第一版让 Workrun 继续拥有会话历史，Server 强制 `store: false`。`store: true`、`background: true`、非空 `previous_response_id` / `conversation` 和 `item_reference` 返回 400。当前 Team Key 是共享凭据，上游资源 ID 不构成 Workrun 用户级访问权限；在实现上游资源所有权校验前，不开放托管状态、检索、删除或后台任务接口。客户端应自行携带上下文 Items。原生 WebSocket Responses 暂不支持。

Responses 的 `user` 和 `metadata` 与 Chat Completions 一样由 Server 覆盖；`safety_identifier` 另外设为 Workrun End User 的 SHA-256，避免由客户端伪造 Provider 侧身份。LiteLLM 的用户消费归因仍使用 `user`。

### 转发、取消和观测

- 两种推理接口只接受各自列明的协议参数；客户端无法指定 `api_key`、`api_base`、fallback、回调或 mock response。客户端 `user` 和 `metadata` 被服务端覆盖，客户端认证/代理 header 不转发到 LiteLLM。
- Server 使用官方 `openai` SDK 连接 LiteLLM：目录通过 `models.list().asResponse()` 查询，推理分别通过 `chat.completions.create().asResponse()` 和 `responses.create().asResponse()` 获取原始响应。JSON 和 SSE 响应按字节转发，保留工具调用、结构化输出及 usage，不逐 token 解析或写数据库。流转发使用背压；SDK 配置 `maxRetries: 0`，上游重试和 fallback 在 LiteLLM 配置。SDK 日志关闭，且不继承环境中的 OpenAI organization/project。
- 客户端断开会中止上游 HTTP 连接；这不保证 Provider 已停止计算或计费。流已开始后发生故障会关闭连接，不追加业务 JSON 或重新发起模型调用。
- `LITELLM_TIMEOUT_MS` 限制整个推理请求。反向代理应关闭该路径的响应缓冲，并将读超时设为匹配模型请求的时长。
- Server 生成 `X-Workrun-Request-Id`，同时写入 LiteLLM 请求的 `metadata.workrun_request_id`，并透传上游 `X-Request-Id`、`X-LiteLLM-Call-Id` 和 `Retry-After`。不记录请求/响应内容或凭据。
- LiteLLM 的 429 作为配额/限流错误返回；上游 401 转为 502，避免将服务端 Team Key 配置错误误判为 Workrun 用户需要重新登录。上游错误正文不直接暴露。

单元测试与 HTTP 集成测试均在 `pnpm --filter workrun-server test` 中运行。HTTP 测试使用临时本机模拟服务和真实 NestJS 认证 Guard，不访问真实 LiteLLM 或付费 Provider。
