# Workrun

> 本地优先的 AI 自动化桌面平台：用可视化工作流组合 Agent、Python App 与 MCP 工具，并把运行、评估和发布放在同一个工作台。

Workrun 面向想把一次性的 AI 对话沉淀为可复用自动化能力的开发者和团队。它将用户输入、模型推理、确定性代码、外部工具和人工审批组织为可执行工作流；你可以在画布上搭建流程，也可以维护完整的本地 Python 项目，并在每次运行后检查结果、轨迹和质量。

项目仍在快速迭代。本文的“已实现”内容以当前代码为准；尚未交付的方向列于文末。

<p align="center">
  <img src="https://github.com/user-attachments/assets/525a19ce-a28b-4671-8e31-0f3ba5539069" width="24%" alt="Workrun workflow list" />
  <img src="https://github.com/user-attachments/assets/baedb261-5990-41d4-8565-dc81131f6a13" width="24%" alt="Workrun workflow editor" />
  <img src="https://github.com/user-attachments/assets/7c5afcf0-8ab2-4ada-9226-ceff3a4d633c" width="24%" alt="Workrun run output" />
  <img src="https://github.com/user-attachments/assets/800103bb-85a8-4e8e-bf94-52a544233e01" width="24%" alt="Workrun app editor" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/948c92ec-306b-4a14-9328-3b60f02c5846" width="24%" alt="Workrun workflow list" />
  <img src="https://github.com/user-attachments/assets/db940f4d-c75d-40c6-b42d-48b22c800666" width="24%" alt="Workrun workflow editor" />
  <img src="https://github.com/user-attachments/assets/4ea37888-4f7e-4393-85b8-f945be61e282" width="24%" alt="Workrun run output" />
  <img src="https://github.com/user-attachments/assets/f1a946e2-0c5f-4259-95a3-07b9e04b1765" width="24%" alt="Workrun app editor" />
</p>

## 你可以用 Workrun 做什么

- 将 Agent、Python App、MCP 工具、条件分支和人工操作组合成可视化工作流。
- 管理可编辑的 Python 项目：既可作为工作流中的 Process 节点，也可作为 Agent 按需调用的 Tool App。
- 在运行面板查看节点状态、模型输出、工具调用、脚本日志和 OpenTelemetry 轨迹；失败后可从检查点重试。
- 用评估集批量回归工作流，比较版本结果，并以质量门约束发布。
- 在团队服务中发布带版本的工作流和 App；已发布工作流会固定引用对应版本的 Team App，保证复现性。

## 快速开始

### 前置条件

- Node.js 24+
- pnpm 12（仓库锁定 `pnpm@12.5.1`）
- Rust 工具链与对应平台的 Tauri 构建依赖
- Python App 开发需要网络，以便 `uv` 下载 Python 与依赖；发行包会携带 `uv` sidecar

### 启动桌面端

```bash
pnpm install
pnpm app:dev
```

首次启动后，在设置中创建模型 Profile，随后新建工作流、添加 `Start → Agent → End`，填写输入并运行即可。模型密钥只加密保存在本机配置中，不会被前端持久化。

### 常用命令

```bash
# 桌面端开发 / 仅启动前端
pnpm app:dev
pnpm ui:dev

# 检查
pnpm typecheck
pnpm oxlint
pnpm format
pnpm test

# 团队服务（需 MongoDB 和认证环境变量）
pnpm server:dev
```

团队服务至少需要 `MONGODB_URI`；认证配置见 `apps/server/src/env.validation.ts`。Python SDK 的开发与使用说明见 [packages/python-sdk/README.md](packages/python-sdk/README.md)。

## 核心能力

### 1. 工作流：从画布到可恢复执行

工作流支持任务与对话两种模式。画布提供 `Start`、`End`、`Agent`、`CodeAct Agent`、`Remote Agent`、`Process`、`If/Else`、`Switch`、`Human Review`、`Ask User Question`、`Subworkflow`、`Terminate` 和 `Group` 节点；`Group` 仅用于布局。

- 运行前会验证图结构、分支和输入/输出 JSON Schema，并编译为 Rust 执行图。
- `Subworkflow` 会传递上下文与暂停恢复信息，并阻止自引用、循环引用和过深嵌套；`Terminate` 可结束整次运行。
- 人工审核和提问会将执行状态写入本地 SQLite 检查点。用户提交结果后从暂停点继续，而非重跑已完成节点。
- 失败的后台运行可从检查点重试；运行记录保留执行计划、最终状态和关键事件。

```text
Start → 数据准备（Process） → Agent → Human Review → If/Else → End
                                  │             │
                                  │             └─ 审批后从检查点恢复
                                  └─ Tool App / MCP 工具调用
```

### 2. Agent、工具与模型

- Agent 可配置名称、职责、指令、模型 Profile、结构化输出、工具调用上限和超时；结果可写入指定状态字段，供后续节点和分支使用。
- 支持 Gemini、OpenAI 与兼容接口、Anthropic、DeepSeek、Groq、Ollama。
- 本地 Skills 兼容 Agent Skills 的 `SKILL.md` 格式，可渐进加载说明，并限制 Agent 可用工具。
- `CodeAct Agent` 在受限 Python 运行环境内编写和执行代码，支持迭代次数、工具调用数、时长、内存、目录挂载、环境变量和系统时钟限制。
- `Remote Agent` 通过 A2A（Agent-to-Agent）协议成为工作流中的一个执行节点。
- 工具可以来自本地 Tool App 或 MCP Server；可要求每次人工确认，拒绝会反馈给 Agent 以便调整方案。

### 3. Python App：保留代码工程化体验

每个 App 都是可自由编辑的本地 `uv` Python 项目，拥有自己的 `pyproject.toml`、锁文件、虚拟环境和入口脚本。桌面端负责创建环境、同步依赖和显示 stdout/stderr，但不会把业务代码塞进节点配置。

| 类型               | 在工作流中的角色                   | 适用场景                           |
| ------------------ | ---------------------------------- | ---------------------------------- |
| App / Process Node | 读取完整工作流状态，返回结构化结果 | 数据处理、系统集成、确定性业务规则 |
| Tool App           | 由 Agent 按 JSON Schema 参数调用   | 查询、计算、文件或服务操作         |

- Process App 通过 `workrun_sdk.process.result(...)` 返回结果。
- Python SDK 还提供 `form()`、`collect()`、`confirm()` 等 API，可经受令牌保护的本地 IPC 向桌面端请求表单或确认。
- 本地 App 不是沙箱：只运行你信任的代码，并按实际权限范围审查项目。

### 4. MCP Server：接入已有工具生态

可注册本地 `stdio` 或远程 Streamable HTTP MCP Server，测试连接、启停、重连并查看已发现工具。远程服务支持无认证、Bearer Token 和 OAuth；凭据仅以加密形式保存在本机。已启用 Server 中的工具可以被 Agent 选择，并同样受超时、调用额度、审批和运行追踪约束。

### 5. 状态、安全与可观察性

- 节点拥有隔离的状态命名空间；只有显式发布的字段才能共享，读取权限逐节点授予。
- 输入和节点输出可声明为敏感；检查点原始状态加密保存，对模型、工具和界面默认提供脱敏视图。
- 内置输入、输出和工具护栏：限制长度，脱敏常见 PII、中国大陆手机号和身份证号，并阻止凭据或认证秘密进入工具参数。
- 运行面板流式展示节点状态、模型消息、工具输入输出、脚本日志和轨迹。可配置 OTLP/gRPC collector，将诊断 Trace 导出到外部可观测性系统。

### 6. 评估、回归与发布质量

工作流编辑器内置 Evaluation lab，用评估集验证工作流变更：

- 创建、导入、排序、归档和恢复评估用例，批量执行用例并查看每项结果与失败原因。
- 对比两个版本的用例判定与评分标准，识别新增失败、回归和修复；失败用例可单独重试。
- 为工作流配置质量门，在发布前要求指定评估条件；必要时可记录带理由的人工豁免审计。
- 评估会保存对应工作流快照，避免把草稿变更误认为已发布版本的结果。

### 7. 团队工作区与版本化资产

桌面端可连接 NestJS 团队服务并登录。团队成员可以浏览和运行已发布的工作流，也可发布带语义版本的 Workflow 与 App。工作流发布时会校验引用；Team App 以不可变 release 固定到工作流版本，运行时按该 release 安装隔离副本，从而让历史运行和回归结果可复现。

## 架构概览

```mermaid
flowchart LR
  UI[React + TypeScript UI] <-->|Tauri commands / events| Host[Rust / Tauri Host]
  Host --> Runtime[Workflow runtime]
  Runtime --> Agent[Agent / CodeAct / A2A]
  Runtime --> App[Process App]
  Agent --> Tools[Tool App / MCP]
  Runtime --> State[Validated, access-controlled state]
  State --> Checkpoint[Encrypted SQLite checkpoints]
  Runtime --> History[Run history / evaluation]
  Host -. optional OTLP .-> Collector[Telemetry collector]
  UI <--> Team[NestJS team service]
```

| 区域       | 位置                                       | 作用                                                      |
| ---------- | ------------------------------------------ | --------------------------------------------------------- |
| 桌面应用   | `apps/desktop`                             | React UI、React Flow 画布、运行面板、设置与团队体验       |
| 本地运行时 | `apps/desktop/src-tauri`                   | Rust 工作流编译/执行、状态与检查点、Python/MCP 管理、遥测 |
| 团队服务   | `apps/server`                              | NestJS、认证、团队 App / Workflow / 文件 API 与发布版本   |
| Python SDK | `packages/python-sdk`                      | App 结果协议和本地 IPC 表单/确认 API                      |
| 共享包     | `packages/ui`、`packages/json-schema-form` | UI 基础组件与 JSON Schema 表单                            |

## 演示

### Python App：创建与运行

<a href="https://github.com/1111mp/workrun-app/releases/download/resources/app.mp4">
  <img src="https://github.com/user-attachments/assets/fc876517-b695-49f3-bdfa-e4c43ec5085c" width="860" alt="点击查看 Python App 演示视频" />
</a>

### Workflow：配置并运行 Health Agent

<a href="https://github.com/1111mp/workrun-app/releases/download/resources/workflow.mp4">
  <img src="https://github.com/user-attachments/assets/1658cfdf-faeb-4365-891d-54133622b015" width="860" alt="点击查看 Workflow 演示视频" />
</a>

## 项目状态与路线图

已具备本地工作流、App/MCP 集成、运行恢复、评估、遥测，以及团队发布和运行已发布工作流的基础能力。以下方向仍在持续完善，不应视为既有承诺：

- 更完整的资产同步、导入导出、模板和市场发现体验。
- 更丰富的节点、连接器、运行控制与可复现调试信息。
- 更成熟的权限、插件机制和跨平台运行时体验。
- 团队协作下更细粒度的版本、权限和发布流程。

## 参与贡献

欢迎围绕工作流节点与运行时、模型和工具集成、桌面端体验、Python SDK、评估体系、示例流程和文档贡献改进。较大的设计变更建议先通过 Issue 讨论。

## License

本项目采用 [LICENSE](LICENSE) 中的许可证。
