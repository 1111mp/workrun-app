---
title: 构建第一个工作流
description: 用 Process、Agent 与分支组成一个可解释的自动化流程。
---

以「客户反馈分流」为例：Python 先做确定性清洗，Agent 完成分类与建议，规则决定是否进入人工审核。这也是将[快速开始](/zh-cn/getting-started/quickstart/)中的最小 Agent 扩展为生产流程的方式。

```text
Start → 数据准备（Process） → 分类建议（Agent） → 是否高风险？
                                                   ├─ 是 → Human Review → End
                                                   └─ 否 ─────────────────→ End
```

## 先定义状态契约

在画布连线前，列出每个步骤产生和消费的字段。下表就是本教程的最小契约：

| 节点 | 读取 | 写入 | 是否发布到全局状态 |
| --- | --- | --- | --- |
| Start | — | `feedback` | 是，后续节点需要它。 |
| 数据准备（Process） | `feedback` | `normalized_feedback`、`is_high_risk` | 是，Agent 和分支需要它。 |
| 分类建议（Agent） | `normalized_feedback` | `category`、`priority`、`recommendation` | 是，审核和 End 需要它。 |
| 人工审核 | `recommendation` | `approved` | 是，分支或 End 需要它。 |

选中产生输出的节点，在 **发布到全局状态 → 已发布的输出键** 中以逗号填入这些键。输出默认是节点私有的；没有发布或没有授予读取权限时，下游节点不能假定能读取。

## 分配职责

1. **Process**：读取输入、清洗字段、补全固定规则或查询内部系统；
2. **Agent**：处理语义判断，要求返回固定字段，例如 `category`、`priority` 与 `recommendation`；
3. **If/Else 或 Switch**：只根据已声明的状态字段分支；
4. **Human Review**：把影响用户、资金、权限或公开内容的决定交给人确认。

## 配置分支与审核

1. 为 **If/Else** 节点设置条件，例如 `is_high_risk == true || priority == "high"`；
2. 将“是”分支连接到 **Human Review**，将“否”分支连接到 End；
3. 在 Human Review 的 **审核请求** 中，把内容键设为 `recommendation`，上下文键填入 `category, priority, normalized_feedback`；
4. 需要审核人可改写建议时，开启 **允许编辑**；
5. 分别连接“批准”和“拒绝”输出。不要让拒绝分支无声结束，应连接到补充信息、重写建议或明确结束节点。

> **素材占位 · 截图 `workflows/01-state-publication.png`**  
> 画面：Process 节点的“发布到全局状态”区域，已填入多个输出键。  
> 用途：说明“节点产生输出”和“工作流公开该输出”是两个不同动作。

> **素材占位 · 视频 `workflows/02-branch-and-review.mp4`（45–60 秒）**  
> 画面：添加 If/Else、填写条件、配置 Human Review，并运行到暂停状态后批准恢复。  
> 用途：完整展示高风险分支的控制流。

## 设计提示

- 让每个节点只做一件可描述的事；
- 先定义节点输出，再写 Prompt 和代码；
- 用可读的状态字段名，避免把完整文本塞进每一个节点；
- 将副作用操作放在审核之后，并为 Agent 工具调用开启人工确认。

运行三类样例再进入评估：普通反馈、明确高风险反馈、信息不足反馈。它们会成为第一批[评测用例](/zh-cn/quality/evaluations/)。
