---
title: 5 分钟快速开始
description: 配置 API 密钥，创建并运行第一个 Start → Agent → End 工作流。
---

本教程会创建一个最小工作流：提交一段客户反馈，由 Agent 给出处理建议。你只需配置一个 Provider 的 API 密钥；模型目录和工作流运行模式已经由 Workrun 提供。

```text
Start → Agent → End
```

## 1. 在设置中添加 API 密钥

打开 **设置 → 模型**，在你要使用的 Provider 一行填入 API 密钥。设置会自动保存。

不需要新建模型 Profile、手动填写模型 ID，或为本教程创建运行模式。Workrun 已内置可选模型；稍后在 Agent 节点中选择一个与已配置 Provider 对应的模型即可。使用 Ollama 时，填写本地或远程 Ollama 端点，而不是 API 密钥。

![设置 → 模型：为 Provider 添加 API 密钥，密钥已遮蔽。](/media/quickstart/01-api-key.png)

## 2. 创建工作流和 Agent

进入 **Workflows**，新建工作流，命名为「客户反馈助手」。新工作流已带有 **Start** 节点；它是固定入口，不能编辑，也不需要配置。

从节点面板添加 **Agent** 和 **End**，并连接：

```text
Start → Agent → End
```

选中 Agent，在右侧检查器中：

1. 填写名称，例如「反馈助手」；
2. 填写描述：`分析客户反馈并给出处理建议`；
3. 在模型配置中选择一个已配置 Provider 的内置模型；
4. 填入以下指令：

```text
你是客户反馈助手。

阅读本次运行提供的 feedback 输入，简洁地说明：
1. 用户遇到的问题；
2. 问题的紧急程度；
3. 建议的下一步处理动作。

信息不足时，明确说明需要补充什么；不要编造事实。
```

<video controls preload="metadata" playsinline aria-label="创建客户反馈助手工作流">
  <source src="/media/quickstart/02-create-workflow.mp4" type="video/mp4" />
  当前浏览器不支持 MP4 视频播放，请从文档媒体目录下载视频查看。
</video>

视频展示新建工作流（含默认 Start）、添加并连接 Agent 和 End，以及在 Agent 检查器中选择内置模型和填写指令。

## 3. 在「更多设置」定义入口输入

工作流的入口输入不在 Start 节点中配置。点击编辑器右上角的 **更多设置**，在 **运行输入** 中添加一个字段：

| 字段 | 值 |
| --- | --- |
| 标签 | `客户反馈` |
| 键 | `feedback` |
| 类型 | `多行文本` |
| 必填 | 开启 |
| 帮助文本 | `请输入需要分析的客户反馈` |

保存工作流。这个键会作为每次运行的输入提供给工作流，供 Agent 在指令中引用；实际输入内容只属于该次运行，不会写回工作流定义。

## 4. 运行并查看结果

点击 **运行**，在出现的输入框填写：

```text
升级后导出的 CSV 文件打不开，今天下午要给财务对账，请尽快处理。
```

提交后，运行面板会显示 Start、Agent、End 的执行状态和 Agent 的回复。预期结果应指出这是高优先级的导出/文件问题，并给出可执行的跟进建议。

如果运行失败，检查：对应 Provider 的 API 密钥是否已在 **设置 → 模型** 中保存，以及 Agent 选择的是否是该 Provider 的模型。

![运行结果：Start、Agent、End 的执行状态和 Agent 回复。](/media/quickstart/03-run-result.png)

下一步：阅读[构建第一个工作流](/zh-cn/guides/build-a-workflow/)，继续加入 Python、条件分支与人工审核。
