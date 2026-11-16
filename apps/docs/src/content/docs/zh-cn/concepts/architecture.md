---
title: 架构与部署边界
description: 了解桌面运行时、团队服务、LiteLLM 网关和 Langfuse 的职责与数据流。
---

Workrun 在桌面端执行工作流。团队模式增加身份认证、版本共享和可选的服务端模型访问；Trace 导出是一条独立、按需启用的链路。

```text
桌面端（React 界面 → Tauri 命令 → Rust 运行时）
  ├─ 本地 SQLite：工作流、修订、对话、定时任务、运行、检查点
  ├─ 本地文件：Python App 项目、运行环境、artifacts
  ├─ 选定的本机 Provider 连接 ───────────────────────────────→ Provider
  ├─ Workrun 会话 ─→ Workrun Server ─→ LiteLLM Team Virtual Key ─→ Provider
  │                       └─ MongoDB：账号、共享版本、文件资源
  └─ 可选 OTLP/gRPC ─→ OTel Collector ─→ Langfuse web/worker
                                             └─ PostgreSQL、ClickHouse、
                                                Redis、对象存储
```

Server、LiteLLM、Langfuse 可以分别部署或接入已有服务，不要求同一套 Compose、共享网络或统一启动器。

## 桌面端负责编排和执行

React 界面提交命令并接收原生事件。Rust host 维护持久状态和权限校验，模型回复本身不能代替方案批准、未批准变更的保存或执行授权。

首页先通过轻量路由器进入对话、任务或工作流路径。普通任务可使用现有工具或匹配的已保存工作流；工作流编排遵循以下边界：

1. Planner 搜索现有能力，读取可能匹配项的完整契约；找到可复用工作流则返回该对象，否则保存待审方案。
2. 用户批准方案后，Author 才能验证并保存约定的定义。保存不代表运行或发布。
3. 独立的执行请求及必要的执行确认，才允许原生 run manager 启动已保存定义。
4. 修复请求先检查已存运行诊断和当前定义，再针对明确的目标工作流提出修改。

Run manager 编译执行图、推送节点/模型/工具事件、保存运行结果，并维护检查点和待处理交互。Process App 在本机 Python 环境运行；MCP 工具、Remote Agent 使用各自配置的连接。这些资源不会随团队服务部署进 Server 容器。

“定时任务”页面使用独立的调度 Agent：发现现有目标、预览时间配置，经原生确认后保存任务。它不能创建工作流或立即发起业务运行。调度仍在桌面端，应用必须运行并能访问目标与凭据，详见[定时运行](/zh-cn/guides/scheduled-runs/)。

## 本地定义与共享版本

本地数据按工作区隔离；团队工作区进一步区分 Server 和登录账号。个人模式创建的工作流不会自动进入团队空间，切换账号也不会暴露上一账号的本地草稿和历史。

| 入口                   | 团队模式选择的定义                                               |
| ---------------------- | ---------------------------------------------------------------- |
| 首页能力发现与复用     | 当前账号已保存的本地工作流，随后是可访问的团队发布版本与本地 App |
| 首页按 ID 读取和执行   | 同 ID 存在本地定义时读取本地最新定义，否则读取团队发布版本       |
| 团队定时任务           | 发布定义，根据 recipe 跟随最新发布版或固定 release               |
| 其他成员使用共享工作流 | 发布版本及其固定版本的 Team App 依赖                             |

因此，自己保存的本地工作流无需发布就能被首页复用。编辑器尚未保存的修改不属于已保存能力。同 ID 同时有本地定义和发布版时，首页去重并使用本地定义；发现后本地定义被删除，读取会失败，不会静默改用旧发布版。发布是明确向其他成员共享版本的步骤。

## Server 提供协作和模型访问

NestJS Server 使用 MongoDB 保存账号、Workflow/App 记录、发布版本和文件资源，其中部分资源通过 GridFS 保存。Better Auth 验证桌面端会话。工作流执行、检查点、运行历史、本地 artifacts 和定时任务仍在执行设备上。

启用 LiteLLM 后，桌面端从 `GET /api/v1/llm/models` 获取模型目录，通过 `POST /api/v1/llm/chat/completions` 或 `POST /api/v1/llm/responses` 推理。Server 验证登录和模型可见性，注入 Team Virtual Key 并生成用户归因。Provider 凭据只在 LiteLLM，桌面端不接收 Team Key 或 master key。

启用网关接入时，当前一个 Server 部署对应一个 LiteLLM Team。有效登录用户共享该 Team 的模型访问权限，尚无独立的 Workrun 组织成员管理或成员级模型策略。团队模式也允许明确选择本机 Provider 直连；网关失败不会自动切换到直连。

Responses 使用无状态模式：桌面端重放历史，Server 强制 `store: false`，不开放上游托管会话、previous response ID 或后台 Responses。详见[配置模型访问](/zh-cn/getting-started/model-profiles/)。

## Langfuse 观测桌面运行时

可选 exporter 通过 OTLP/gRPC 导出桌面端对话、工作流、节点、模型 generation 和工具 observation。Collector 添加 Langfuse 项目认证并通过 OTLP/HTTP 转发 Trace；配套 Collector 配置丢弃 metrics。这条链路不需要 Langfuse AI Gateway，也不需要 LiteLLM 的 Langfuse callback。

导出 metadata 可能包含工作区/账号身份，以及 session/run/node/call ID。输入输出正文默认不导出，在 **设置 → 日志** 中单独开启。本地运行历史仍负责恢复，Trace 不会恢复检查点和 artifacts。当前接入没有把 NestJS Server 单独仪表化为分布式追踪服务。

详见[运行与追踪](/zh-cn/quality/runs-and-traces/)和[部署 Server、LiteLLM 与 Langfuse](/zh-cn/team/deployment/)。

## 源码位置

| 职责                             | 仓库路径                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| 桌面 UI 与服务适配               | `apps/desktop/src`                                                                 |
| 对话、任务、规划与编排运行时     | `apps/desktop/src-tauri/src/module/assistant`                                      |
| 工作流持久修订                   | `apps/desktop/src-tauri/src/feat/workflow`                                         |
| 运行管理、执行图与调度           | `apps/desktop/src-tauri/src/module/{run_manager,workflow,schedule,schedule_agent}` |
| 团队模型传输与身份               | `apps/desktop/src-tauri/src/module/team_model.rs`                                  |
| OTLP 导出与 Langfuse observation | `apps/desktop/src-tauri/src/core/telemetry*.rs`                                    |
| 认证、版本与模型代理             | `apps/server/src`                                                                  |
| 独立 Compose 部署示例            | `apps/server/docker-compose.yaml`、`infra/litellm`、`infra/langfuse`（独立示例）   |
