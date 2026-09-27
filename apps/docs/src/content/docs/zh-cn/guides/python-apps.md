---
title: 使用 Python App
description: 将完整的 Python 项目作为 Process 节点或 Agent 工具使用。
---

选择 Python App，而不是把所有逻辑写进 Prompt，适用于数据清洗、复杂计算、内部服务集成、文件操作和必须稳定复现的业务规则。每个 App 是独立的本地 `uv` 项目，拥有自己的 `pyproject.toml`、锁文件和虚拟环境。

## 创建并配置 App

1. 进入 **Apps**，点击新建；
2. 选择它是工作流中的 **App / Process Node**，还是由 Agent 调用的 **Tool App**；
3. 选择项目位置，让 Workrun 创建或关联 `uv` 项目；
4. 在编辑器中安装依赖、实现入口，并声明输入/输出 Schema；
5. 在 App 页面运行一次，确认 stdout、stderr 和结果符合预期；
6. 回到工作流，将 Process App 选为 Process 节点，或在 Agent 的 **工具** 中勾选 Tool App。

> **素材占位 · 视频 `python-apps/01-create-and-run.mp4`（60–90 秒）**  
> 画面：新建 Process App、查看项目文件、编写最小入口、安装依赖、运行并观察 stdout/stderr。  
> 用途：解释 Workrun 管理运行环境，但不会把业务代码塞进节点配置。

## Process App

Process App 作为工作流中的一个节点运行，可读取工作流完整状态并返回结构化结果。

```python
from workrun_sdk import process

# 只返回后续节点真正需要的字段，保持状态边界清晰。
process.result({"normalized_feedback": "...", "is_high_risk": False})
```

将 App 添加到工作流后，在 Process 节点的 **应用连接** 中选择该已安装 App。节点会通过标准输入接收其被授权读取的 State JSON 视图；只把后续需要的值写入结果，并在节点中发布对应输出键。

## Tool App

Tool App 由 Agent 在需要时调用。为它定义清晰的 JSON Schema 参数，让 Agent 了解何时能调用、要传什么以及会得到什么结果。

需要用户输入或确认时，Python SDK 还提供 `form()`、`collect()` 与 `confirm()` 等 API，通过受令牌保护的本地 IPC 请求桌面端界面。

### Tool App 的运行边界

在 Agent 节点的 **工具** 中选择 Tool App 后，再配置 **调用上限** 与 **工具超时**。副作用工具（写入、删除、发送）应启用人工确认。Tool App 必须返回 JSON 对象；它不是沙箱，只运行你信任的代码。
