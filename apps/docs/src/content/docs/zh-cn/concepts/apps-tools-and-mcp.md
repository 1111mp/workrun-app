---
title: App、工具与 MCP
description: 选择正确的执行方式：Process App、Tool App、MCP Server 或 Skill。
---

Workrun 将代码工程和 Agent 工具生态一起带进工作流。它们承担的职责不同。

| 能力        | 谁调用它   | 适合什么                                  |
| ----------- | ---------- | ----------------------------------------- |
| Process App | 工作流节点 | 数据处理、系统集成、确定性业务规则        |
| Tool App    | Agent      | 按 JSON Schema 接收参数的查询、计算或操作 |
| MCP Server  | Agent      | 接入本地或远程已有工具生态                |
| Skill       | Agent      | 渐进加载的任务说明与受限工具集合          |

每个 Python App 都是可自由编辑的本地 `uv` 项目，拥有自己的 `pyproject.toml`、锁文件、虚拟环境和入口脚本。Process App 通过 `workrun_sdk.process.result(...)` 返回结果。

MCP Server 支持本地 `stdio` 与远程 Streamable HTTP。远程服务可使用无认证、Bearer Token 或 OAuth；凭据仅加密存储在本机。

> 本地 App 不是沙箱。只运行你信任的代码，并按照真实权限范围审查项目。
