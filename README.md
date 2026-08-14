# Workrun

> 一个本地优先的桌面工作流平台：把 AI Agent、可编程的 Python App 与人工输入编排成可运行、可观察的自动化流程。

Workrun 面向希望把 AI 从“单次对话”变成“可复用流程”的开发者。你可以在可视化画布上定义步骤和分支，为 Agent 配置模型与指令，把本地 Python 程序接入流程；运行时由桌面应用在本机执行，并把节点状态、模型输出与脚本日志集中呈现。

项目仍处于早期开发阶段，工作流文件格式与部分接口可能调整。本文标注的“已实现”能力以当前代码为准；尚未完成的方向集中列在文末路线图中。

<p align="center">
  <img src="https://github.com/user-attachments/assets/fff837af-95c4-47a9-a32a-6f5248dfba3b" width="32%" alt="Workrun workflow editor" />
  <img src="https://github.com/user-attachments/assets/cfc71fac-3a71-42e4-ab8a-9e77a2a5ff61" width="32%" alt="Workrun app management" />
  <img src="https://github.com/user-attachments/assets/89c1fa7c-5d8f-4800-b9f8-e0d215014eaf" width="32%" alt="Workrun settings" />
</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/b81808fc-6d35-4425-b650-69bc796164d5" width="32%" alt="Workrun app editor" />
  <img src="https://github.com/user-attachments/assets/26c1ede7-25d7-43ab-ad69-1c527085309f" width="32%" alt="Workrun app run" />
  <img src="https://github.com/user-attachments/assets/3da51c59-b5ac-4058-ba18-481fe9094c72" width="32%" alt="Workrun app output" />
</p>

## 它解决什么问题

许多 AI 自动化任务都会同时包含三类工作：向用户收集信息、调用 AI 推理、执行确定性的脚本或服务。若这些步骤散落在提示词、终端命令和多个工具中，流程不易复用，也很难知道某次运行在哪一步失败。

Workrun 将它们组织到同一份工作流中：

- **人机协作**：工作流启动时可显示输入表单；Python App 也可在运行中向桌面端请求表单或确认。
- **AI 推理**：Agent 节点携带角色、指令和模型配置，读取当前工作流状态后生成结果。
- **本地自动化**：Python App 以独立、可编辑的 `uv` 项目存在，接收工作流状态并返回结构化 JSON。
- **流程控制与可观察性**：If/Else、Switch 节点根据状态字段选择路径；运行面板流式显示节点状态、模型消息、思考过程和脚本输出。

换言之，Workrun 不是又一个聊天窗口，而是把 AI 与本地程序纳入有输入、输出、分支和执行记录的工作流运行时。

## 当前已实现的能力

### 可视化工作流编辑与运行

- 基于节点画布创建、连接、保存和加载工作流，支持撤销/重做与工作流基本设置。
- 已提供 `Start`、`End`、`Agent`、`Remote Agent`、`Process`、`If/Else`、`Switch` 与 `Group` 节点；其中 Group 仅用于画布布局，不参与执行。
- 工作流可配置为任务模式或对话模式；任务模式会根据输入定义生成测试运行表单，对话模式提供消息输入。
- 运行前会校验图结构并编译为执行计划：必须且只能有一个 Start、至少一个 End，边连接与分支出口也会被验证。
- 运行时将画布 DSL 编译为 Rust 工作流图，按事件流向界面发送节点开始/结束、模型消息与错误；最终状态和执行计划会一并返回。

### Agent 与模型

- 本地 Agent 节点可配置名称、职责描述、指令和模型 Profile，并使用当前工作流状态作为上下文。
- Remote Agent 节点通过 A2A（Agent-to-Agent）协议调用远程 Agent，作为工作流中的正式执行步骤。
- 设置页可管理模型提供商凭据和连接地址；当前运行时已接入 Gemini、OpenAI / OpenAI-compatible、Anthropic、DeepSeek、Groq 与 Ollama。
- API Key 以加密形式写入本地 Workrun 配置，而非交给前端持久化。

### Python App（Process Node）

Workrun 中的 App 是可在工作流中复用的本地 Python 节点。创建 App 后，桌面端会在应用数据目录中生成并管理一个独立的 `uv` Python 项目：包含 `pyproject.toml`、锁文件、虚拟环境和可编辑的入口脚本。

- **App 既是独立程序，也是工作流能力单元。** 它可以从 Apps 页面单独运行、调试和迭代；也可以作为 Process 节点接入任意工作流，接收上游状态并将结构化结果交给下游节点。
- 这使 App 适合封装画布之外的复杂实现：数据处理、内部系统集成、确定性规则，甚至完整的业务流程编排都可以写在独立 Python 项目中。对工作流而言，它仍是一个输入明确、输出明确的可复用节点；对开发者而言，它保留了用代码自由组织复杂逻辑的空间。
- 运行时从 stdin 向脚本传递完整工作流状态；脚本通过 `workrun_sdk.process.result(...)` 返回结构化结果，并保留 stdout/stderr 作为实时日志。
- 桌面端托管 Python 与依赖缓存，避免把运行时写入应用安装包；创建、依赖同步与运行过程均会回报状态或输出。
- 随附的 Python SDK 提供 `form()`、`collect()`、`confirm()` 等 API。脚本可经由本地 IPC 请求桌面端展示 JSON Schema 驱动的表单，并取得用户提交的数据。
- 当前 IPC 传输在 macOS/Linux 使用 Unix domain socket；Windows named pipe 支持仍待补齐。

### 桌面端与本地体验

- 基于 Tauri 2 的 React/TypeScript 桌面应用，前端画布使用 React Flow。
- 支持浅色、深色与跟随系统主题；中英文界面；日志等级和保留策略设置。
- 已集成自动检查更新、开机启动、静默启动、系统托盘、单实例和窗口状态等桌面能力（不同平台的实际可用性取决于系统支持）。

## 示例：健康报告工作流

下面是当前准备录制演示的视频场景：用户填写自身健康信息，Health Agent 根据这些输入生成一份健康报告。

```text
Start
  │
  ├─ 在运行面板填写：年龄、性别、身高、体重、生活习惯、关注点……
  │
  ▼
Health Agent
  ├─ 读取本次输入与 Agent 指令
  ├─ 调用已配置的模型
  └─ 生成健康报告（仅作健康信息整理，不替代医疗诊断）
  │
  ▼
End
```

同一流程可以自然扩展：在 Agent 前增加 Python App 做 BMI 或数据规范化；在 Agent 后按 `route` / `approved` 等状态使用 Switch 或 If/Else 分流；也可以把某一步替换为符合 A2A 协议的远程 Agent。

## 演示视频

### App：创建与运行 Python App

<a href="https://github.com/1111mp/workrun-app/releases/download/resources/app.mp4">
  <img src="https://github.com/user-attachments/assets/fc876517-b695-49f3-bdfa-e4c43ec5085c" width="860" alt="App 操作演示动图；点击查看完整 MP4" />
</a>

### Workflow：配置并运行 Health Agent

<a href="https://github.com/1111mp/workrun-app/releases/download/resources/workflow.mp4">
  <img src="https://github.com/user-attachments/assets/1658cfdf-faeb-4365-891d-54133622b015" width="860" alt="Workflow 操作演示动图；点击查看完整 MP4" />
</a>

## 项目架构

Workrun 采用 pnpm monorepo。桌面端负责交互、工作流执行编排和本地运行时管理；共享包承载 UI 与动态表单能力；Python SDK 则是 App 与桌面端之间的受控交互层。

```mermaid
flowchart TB
  User[用户]
  UI[Desktop UI\nReact + TypeScript + React Flow]
  Tauri[Tauri Host / Rust]
  Compiler[Workflow compiler\nReact Flow DSL → StateGraph]
  Agent[本地 Agent\n模型 Provider]
  Remote[Remote Agent\nA2A]
  Process[Process Node\nuv-managed Python project]
  SDK[workrun-sdk\n表单 / 确认 / 结构化结果]
  Form[JSON Schema Form\n桌面端输入对话框]

  User --> UI
  UI <-->|Tauri commands + event channels| Tauri
  Tauri --> Compiler
  Compiler --> Agent
  Compiler --> Remote
  Compiler --> Process
  Process --> SDK
  SDK <-->|local IPC| Form
  Form --> UI
```

### 分层与职责

| 层              | 主要位置                                             | 职责                                                                                                          |
| --------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 桌面界面        | `apps/desktop/src`                                   | 工作流画布、节点编辑器、运行面板、Apps 管理、模型与应用设置。前端只描述工作流并展示结果，不直接持有执行逻辑。 |
| 桌面主机        | `apps/desktop/src-tauri/src`                         | Tauri commands、配置与加密、系统集成、Python 运行时、Process Node 注册表，以及工作流编译与执行。              |
| 工作流运行时    | `module/workflow.rs`                                 | 将 React Flow 的 `nodes` / `edges` 转成 ADK Rust `StateGraph`，验证图、连接条件边，并以流式事件驱动界面状态。 |
| AI 执行器       | `module/workflow.rs`、模型配置                       | 创建本地 LLM Agent 或 A2A Remote Agent；模型密钥和 Base URL 来自本地配置。                                    |
| 本地 App 执行器 | `module/process_node.rs`、`module/python_runtime.rs` | 创建、登记、检查和执行 `uv` 管理的 Python 项目；将状态、日志和结构化结果接入工作流。                          |
| Python 交互 SDK | `packages/python-sdk`                                | 为 Python App 提供 `process.result()` 与 UI 请求 API，通过带令牌的本地 IPC 和桌面端通讯。                     |
| 共享前端包      | `packages/ui`、`packages/json-schema-form`           | 复用基础组件，以及基于 RJSF/Ajv 的 JSON Schema 表单渲染能力。                                                 |

### 一次工作流如何运行

1. 用户在画布定义节点、连线、输入字段和 Agent / App 配置，前端保存 React Flow 文档。
2. 点击运行后，前端收集本次输入并调用 Tauri command；这类运行参数属于本次执行，不会回写工作流定义。
3. Rust 端验证并编译文档，构建仅包含执行语义的 StateGraph。节点位置等画布布局信息不会进入运行时模型。
4. 图执行各个 Agent、Remote Agent、Process 与控制节点。状态在图中传递，If/Else 和 Switch 根据选择器字段决定后继路径。
5. 执行事件通过 Tauri Channel 实时回到运行面板；Process Node 的 stdout/stderr 也以流形式展示。结束后返回最终 state 与执行计划。

### 本地数据与安全边界

- 工作流定义、Workrun 配置、日志及 Process Node 项目均以本地文件为主。
- 模型推理请求会发送给用户所选模型服务；Remote Agent 节点会请求其配置的远程地址。因此，输入中包含敏感信息时，请审查对应模型服务和远程 Agent 的数据政策。
- Python App 由本机执行，应只运行你信任的代码。App 可以访问其被授予的本机权限；Workrun 不将其视为沙箱。

### 从本地资产到团队市场（规划中）

当前 Workrun 以本地文件为中心，便于个人在自己的设备上开发、试验和维护工作流与 App。后续计划引入服务端，用于集中保存这些可复用资产，并提供发布与分发能力。

设想中的团队市场会让成员把已经验证有效的工作流或 App 发布为可发现、可安装、可复用的能力。例如，某位同学沉淀了一个解决特定业务场景的工作流，或将复杂集成封装成 App 后，其他同学可在市场中找到它、复用它，并在自己的工作流中继续组合。版本、权限、依赖与发布流程将随该能力一并逐步设计。

> 这一服务端、发布与市场能力尚未实现；现阶段的工作流和 App 仍由本地桌面端管理。

## 仓库结构

```text
apps/desktop/                 Tauri 桌面应用
├── src/                      React UI、画布节点、运行面板与服务层
└── src-tauri/src/            Rust commands、运行时、配置与系统集成
packages/python-sdk/          Python App SDK（本地 IPC、表单、结果协议）
packages/json-schema-form/    JSON Schema 表单主题与模板
packages/ui/                  共享 UI 组件
```

## 本地开发

### 环境要求

- Node.js 24 或更高版本
- pnpm 11
- Rust 工具链（用于 Tauri 桌面应用）
- macOS/Linux 上运行 Python App 时，网络可用以便 `uv` 下载所需 Python / 依赖；生产包会随附 `uv` sidecar

### 常用命令

```bash
# 安装依赖
pnpm install

# 启动桌面应用开发环境
pnpm dev:app

# 仅启动前端界面
pnpm ui:dev

# 类型检查
pnpm typecheck

# 代码检查与格式检查
pnpm oxlint
pnpm format
```

Python SDK 的开发和测试说明见 [packages/python-sdk/README.md](packages/python-sdk/README.md)。

## 路线图

以下方向仍在持续完善中，不应视为已经完成的承诺：

- 服务端持久化、工作流 / App 的版本管理、发布机制与团队市场复用。
- 更完整的本地导入导出与可分享模板能力。
- 更丰富的节点类型、工具连接器、运行控制（取消、重试、恢复）与调试记录。
- 更成熟的权限模型、插件机制与跨平台 Python IPC 支持。
- 将运行历史、输入输出和错误上下文沉淀为更易复现的调试体验。

## 参与贡献

欢迎围绕工作流节点、运行时与插件机制、模型 / 工具集成、桌面端体验、Python SDK、示例流程和文档参与贡献。较大的改动建议先通过 Issue 讨论设计方向。

## License

本项目采用 [LICENSE](LICENSE) 中的许可证。
