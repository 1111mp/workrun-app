---
title: 配置模型访问
description: 在设置中为 Provider 添加凭据，并在 Agent 中选择内置模型。
---

Workrun 内置模型目录，Agent 和 CodeAct Agent 都从该目录选择模型。无需创建模型 Profile，也无需为每个工作流重复填写模型 ID。

## 添加 Provider 凭据

1. 打开 **设置 → 模型**；
2. 在要使用的 Provider 一行填写 API 密钥；
3. 设置自动保存；
4. 新建或编辑 Agent，在其 **模型配置** 中选择该 Provider 的内置模型。

Ollama 使用端点配置而非 API 密钥；本地默认端点通常即可使用，远程部署时填写相应地址。

## 使用建议

- 一个 Provider 的密钥可供该 Provider 下的内置模型使用；
- 不要将密钥放入节点指令、工作流输入或 Python 代码；
- Agent 的名称、职责、指令、工具和生成参数仍在节点检查器中配置；
- 切换模型后，用同一组输入重新运行工作流，确认结果符合预期。

![Agent 检查器中的模型配置：按 Provider 分组的内置模型目录。](/media/model-profiles/01-model-settings.png)
