## v0.1.0-rc.1

Workrun 的首个 Release Candidate，欢迎体验本地优先的 AI 自动化工作台。

### 核心能力

- 在可视化画布中组合 Agent、Python App、MCP 工具、条件分支与人工审核，构建可复用工作流。
- 支持任务和对话两种工作流模式，以及子工作流、暂停/恢复、失败重试与本地 SQLite 检查点。
- Python App 保持独立 `uv` 工程体验，可作为 Process 节点或供 Agent 调用的 Tool App。
- 支持本地 stdio 与远程 Streamable HTTP MCP Server，并可为工具调用设置人工确认。
- 支持 Gemini、OpenAI 及兼容接口、Anthropic、DeepSeek、Groq 和 Ollama 等模型 Provider。
- 提供运行日志、工具调用记录和 OpenTelemetry 轨迹；内置评估集、回归对比与质量门能力。

### RC 版本说明

- 这是首个候选发布版本，建议先在测试工作流和非关键数据上验证。
- Python App、MCP Server 与工具调用会按其实际权限在本机运行，请仅连接和执行你信任的代码与服务。
- 欢迎通过 GitHub Issues 反馈安装、更新、工作流执行或模型/工具集成问题，并附上系统版本和可复现步骤。

感谢每一位参与体验和反馈的用户！
