---
title: 5 分钟快速开始
description: 创建并运行第一个 Start → Agent → End 工作流。
---

本教程的目标是建立最小可运行闭环：输入一段客户反馈，让 Agent 返回分类、优先级和建议，并在运行面板验证它实际做了什么。

## 完成后你会得到什么

```text
Start（feedback） → Agent（分类） → End
```

最终状态包含 `category`、`priority` 和 `recommendation` 三个字段。后续教程会以它为基础，加入 Python App、条件分支和人工审核。

## 准备

- 已启动的 Workrun 桌面端；
- 一个可用的模型 Provider 密钥，例如 OpenAI、Gemini、Anthropic、DeepSeek、Groq、Ollama 或兼容接口；
- 一个真实的小任务，例如「把这段客户反馈归类并给出跟进建议」。

## 1. 创建模型 Profile

打开 **设置 → 模型 Profile**，点击新增后依次填写：

| 字段 | 本教程建议 | 说明 |
| --- | --- | --- |
| 名称 | `default-chat` | 给工作流作者看的名称；不发送给模型。 |
| Provider | 你持有密钥的服务商 | 例如 OpenAI、Gemini、Anthropic、DeepSeek、Groq、Ollama 或兼容接口。 |
| 模型 | 一个通用文本模型 | 先用稳定、成本可控的模型；模型升级应作为独立变更评估。 |
| API Key / 连接配置 | 你的凭据 | 保存后以加密形式保存在本机，不会被前端持久化。 |

保存后，用 Profile 提供的测试或实际运行确认凭据可用。若使用自托管兼容接口，同时确认 Base URL 与模型 ID 和服务端配置一致。

> **素材占位 · 截图 `quickstart/01-model-profile.png`**  
> 画面：模型 Profile 新建表单，展示 Provider、模型和已遮蔽的密钥字段。  
> 用途：让首次使用者确认入口与必填信息；不要在截图中出现真实密钥。

## 2. 新建工作流

进入 **Workflows**，点击新建工作流。建议命名为「客户反馈分类」。在节点面板拖入并依次连接：

```text
Start → Agent → End
```

选中 **Agent** 节点，在右侧检查器完成以下配置：

1. 在 **基本信息** 中填写名称 `反馈分类 Agent` 和职责说明；
2. 在 **模型与指令** 中选择 `default-chat`；
3. 在 **指令** 中填入下面的内容；
4. 展开 **结构化输出架构（高级）**，将根类型设为对象，并添加三个字段；
5. 连接 `Start → Agent → End`，保存工作流。

```text
你是客户反馈分析助手。

根据输入中的 feedback 判断问题类别、紧急程度，并给出一条可以直接交给客服执行的跟进建议。

不要编造订单、客户身份或产品能力。信息不足时，在 recommendation 中说明需要补充什么。
```

输出 Schema 建议：

```json
{
  "type": "object",
  "properties": {
    "category": { "type": "string", "description": "billing、bug、feature 或 other" },
    "priority": { "type": "string", "enum": ["low", "medium", "high"] },
    "recommendation": { "type": "string" }
  },
  "required": ["category", "priority", "recommendation"]
}
```

> **素材占位 · 视频 `quickstart/02-create-workflow.mp4`（30–45 秒）**  
> 画面：新建工作流、拖入 Start/Agent/End、连线，再在 Agent 检查器选择模型和粘贴指令。  
> 用途：展示画布操作与右侧检查器的对应关系；建议录制 1440px 宽窗口。

## 3. 运行并检查结果

选中 **Start** 节点，添加一个字符串输入 `feedback`。运行前输入：

```text
升级后导出的 CSV 文件打不开，今天下午要给财务对账，请尽快处理。
```

点击运行。运行面板会依次显示 Start、Agent、End 的状态；展开 Agent 事件，检查模型最终返回的三个字段。预期结果应接近：`category: bug`、`priority: high`，且建议没有虚构具体解决时间。

如果运行失败，先检查模型 Profile、Agent 是否选择了 Profile、Schema 是否为根对象，以及 `Start` 输入名称是否与指令中引用的 `feedback` 一致。

> **素材占位 · 截图 `quickstart/03-run-result.png`**  
> 画面：运行面板的节点时间线和展开后的结构化最终输出。  
> 用途：说明“完成”不只看聊天文本，还要检查结构化状态与事件。

下一步：阅读[构建第一个工作流](/zh-cn/guides/build-a-workflow/)，将 Python、条件分支与人工审核接入流程。
