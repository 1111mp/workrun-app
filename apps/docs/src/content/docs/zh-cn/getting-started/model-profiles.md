---
title: 配置模型 Profile
description: 保存 Provider、模型与加密凭据，并在工作流节点中稳定复用。
---

模型 Profile 是 Agent 和 CodeAct Agent 使用模型的配置单元。将密钥和模型选择放在 Profile 中，而不是复制到每个节点，能让轮换凭据、替换模型和排查问题更清晰。

## 创建 Profile

1. 打开 **设置 → 模型 Profile**；
2. 点击新增；
3. 填写名称，建议按用途命名，例如 `prod-review`、`local-ollama` 或 `eval-cheap`；
4. 选择 Provider；
5. 填写模型 ID 与所需凭据；兼容接口还需要填写 Base URL；
6. 保存，并用一次最小工作流实际验证连接。

## 在 Agent 中使用

选中 Agent 节点，打开右侧检查器的 **模型与指令 → 模型配置**，选择 Profile。模型 Profile 只定义“调用哪个模型”；角色、任务目标、输出格式和工具边界应写在节点指令中。

## 配置建议

- 用不同 Profile 区分本地、开发、评测和正式用途；
- 不要把密钥放入节点指令、工作流输入或 Python 代码；
- 更换模型、温度或 Provider 后，运行同一评测集再发布；
- 温度和 Top P 是节点级生成控制。先留空使用模型默认值，只有需要稳定性或多样性时才显式调整。

> **素材占位 · 截图 `model-profiles/01-profile-list.png`**  
> 画面：设置页的 Profile 列表，包含本地、评测、正式三种命名示例；真实 Provider 凭据必须遮蔽。
