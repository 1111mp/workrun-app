---
title: 构建第一个工作流
description: 从客户反馈输入到人工审批，搭建一条可运行、可验证的 Process → Agent → 分支流程。
---

本教程在[快速开始](/zh-cn/getting-started/quickstart/)的 Agent 基础上，加上确定性数据处理、结构化输出、条件分支和人工审核。完成后，你会得到一条可解释的「客户反馈分流」流程：低优先级反馈自动结束，高优先级反馈等待人工决定。

```text
Start → 规范化反馈（Process） → 分类建议（Agent） → 优先级为 high？
                                                        ├─ 是 → Human Review ─┬─ 批准 → End
                                                        │                    └─ 拒绝 → End
                                                        └─ 否 ─────────────────→ End
```

开始前，请确认已在 **设置 → 模型** 配置至少一个 Provider 的 API 密钥。还没有创建工作流或 `feedback` 输入时，先完成[快速开始](/zh-cn/getting-started/quickstart/)。

## 1. 先写下这条流程的状态契约

不要让下游节点从一段自由文本中猜测答案。先约定每一步读什么、产出什么；键名将同时出现在 App Schema、Agent 输出、分支条件和审核界面中。

| 产生者                | 读取                      | 写入并发布到全局状态                                                       | 消费者                |
| --------------------- | ------------------------- | -------------------------------------------------------------------------- | --------------------- |
| 运行输入              | —                         | `feedback`（Label：客户反馈）                                              | Process               |
| 规范化反馈（Process） | `feedback`                | `normalized_feedback`（Label：规范化反馈）                                 | Agent、Human Review   |
| 分类建议（Agent）     | `normalized_feedback`     | `category`（反馈类别）、`priority`（优先级）、`recommendation`（处理建议） | If/Else、Human Review |
| Human Review          | `recommendation` 和上下文 | 审核决定                                                                   | 批准或拒绝出口        |

运行输入本身是全局状态。节点产生的输出默认留在节点私有命名空间；只有在该节点的 **发布到全局状态 → 已发布的输出键** 中列出后，才可供分支、后续节点和工作流输出使用。此示例使用全局键，因此不需要额外配置「允许读取的节点」；该设置仅用于有意共享某个节点私有命名空间的情况。

## 2. 创建用于规范化的 Process App

进入 **Apps → 新建**，创建一个 **App / Process Node**，例如「规范化反馈」。在数据契约中声明：

| 方向 | Label      | Key                   | 类型   | 必填 |
| ---- | ---------- | --------------------- | ------ | ---- |
| 输入 | 客户反馈   | `feedback`            | string | 是   |
| 输出 | 规范化反馈 | `normalized_feedback` | string | 是   |

将入口代码替换为下面的最小实现。它折叠多余空白，保证后续节点始终处理同一份干净文本：

```python
import json
import sys

from workrun_sdk import process


def main() -> None:
    state = json.loads(sys.stdin.read() or "{}")
    feedback = " ".join(str(state.get("feedback", "")).split())
    process.result({"normalized_feedback": feedback})


if __name__ == "__main__":
    main()
```

保存后，在 App 页面单独运行一次，确认结果中有 `normalized_feedback`。Process App 的项目结构、依赖和调试方式见[使用 Python App](/zh-cn/guides/python-apps/)。

## 3. 在画布搭建并配置节点

新建一个**任务**工作流；画布已有 Start 和 End。依次添加 **Process**、**Agent**、**If/Else** 和 **Human Review**，按本文开头的图连接。选中 Process，在 **应用连接** 中选择刚创建的「规范化反馈」App。

然后在 Process 的 **发布到全局状态 → 已发布的输出键** 填入：

```text
normalized_feedback
```

选中 Agent，选择已配置 Provider 的模型，并在「结构化输出架构（高级）」中粘贴以下 Schema。它把分类结果变成稳定字段，而不是只生成一段说明文字：

```json
{
  "type": "object",
  "properties": {
    "category": { "type": "string", "description": "反馈类别" },
    "priority": {
      "type": "string",
      "description": "优先级",
      "enum": ["low", "medium", "high"]
    },
    "recommendation": { "type": "string", "description": "处理建议" }
  },
  "required": ["category", "priority", "recommendation"]
}
```

在 Agent 指令中使用清晰、可检查的规则，例如：

```text
你是客户反馈分流助手。阅读 normalized_feedback，返回 category、priority 和 recommendation。

涉及账户安全、欺诈、数据泄露、付款异常或用户无法使用核心功能时，priority 必须为 high。
信息不足时，说明缺失的信息；不要编造事实。
```

在同一 Agent 节点的 **已发布的输出键** 填入：

```text
category, priority, recommendation
```

## 4. 用稳定字段配置分支和审核

选中 **If/Else**。分别填写两个出口的条件：

| 出口 | 条件                 |
| ---- | -------------------- |
| 是   | `priority == "high"` |
| 否   | `priority != "high"` |

条件一次只比较一个状态字段；不要写 `||`、`&&`，也不要从 `recommendation` 的自然语言里匹配词语。上面的 Schema 限定了 `priority` 的取值，两个条件因而覆盖所有有效结果。

将「是」连接到 **Human Review**，「否」连接到 End。选择 Human Review 后，在 **审核请求** 中：

1. 填写明确的标题和说明，例如「确认高优先级反馈的处理建议」；
2. 将**内容键**设为 `recommendation`；
3. 将**上下文键**填为 `category, priority, normalized_feedback`；
4. 需要审核人改写建议时，开启**允许编辑**；
5. 在本教程中，将“批准”和“拒绝”两个出口都连接到 End。

这样做表示“人工审核已完成，不论决定为何都结束本次运行”；审核结果仍会保留在运行记录中。只有拒绝后还要继续处理时，才将“拒绝”接到补充信息、重写建议或通知节点，而将“批准”接到真正执行副作用的节点。有关暂停、编辑和从检查点恢复的细节见[人工审批与恢复](/zh-cn/guides/human-in-the-loop/)。

## 5. 运行三组样例，检查每一层

保存工作流，点击 **运行**，并在运行面板依次检查节点状态和全局状态。

| 输入                                 | 应看到的结果                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `页面的说明文字有一处错别字。`       | Process 发布 `normalized_feedback`；Agent 返回 `low` 或 `medium`；流程走「否」到 End。      |
| `我的账户出现陌生付款，请立刻冻结。` | Agent 返回 `high`；流程在 Human Review 暂停；批准或拒绝后从检查点继续，不会重跑前面的节点。 |
| `不能用，请处理。`                   | Agent 说明信息不足；确认它仍返回完整的 `category`、`priority` 和 `recommendation`。         |

![低优先级反馈：If/Else 走“否”出口并到达 End。](/media/build-a-workflow/01-low-priority-to-end.png)

![高优先级反馈：流程在 Human Review 暂停，等待人工批准或拒绝。](/media/build-a-workflow/02-high-priority-human-review.png)

![信息不足反馈：Agent 仍返回 category、priority 和 recommendation 三个结构化字段。](/media/build-a-workflow/03-insufficient-information.png)

如果结果不符合预期，按这个顺序排查：先看 App 的 stdout/stderr 和 `normalized_feedback`，再确认 Agent 的模型与 Schema，随后检查两个节点是否发布了所需键，最后核对 If/Else 的条件和出口连线。将这三组输入保存下来，它们就是第一批[评测用例](/zh-cn/quality/evaluations/)。

## 分享或删除已保存的 Workflow

在个人模式下，先保存修改，再打开 Workflow 详情页的 **更多（⋯）** 菜单，选择 **导出**。选择 ZIP 或 TAR 并检查包内容。包内会包含主 Workflow 定义、Process App、Agent 和 CodeAct 使用的 Tool App，以及递归引用的子 Workflow。重复依赖只打包一次；缺失依赖或子 Workflow 循环引用会阻止导出。

在 Workflow 列表选择 **导入**，打开压缩包，检查依赖、确认名称，并绑定当前设备上的外部配置。导入会为主 Workflow、子 Workflow 和 App 创建新 ID，同时更新引用，不会覆盖已有对象。

模型、MCP 工具、Skill、远程凭证、挂载路径、环境变量值和私有 URL 可能需要在本地重新配置。包内不包含 Skill 源码和 MCP 服务配置；导出的定义会移除凭证、本机路径和环境变量值。提示词和 App 源码中手动写入的私有数据仍需自行检查。

可以暂时留空配置，之后在编辑器中打开 **配置导入依赖** 补齐。待配置项会在关闭编辑器后保留，并阻止运行，直到配置完成。运行前可通过单独的依赖安装操作准备包内 App。运行历史、聊天会话和定时任务不会随包导入。

删除入口位于详情页 **更多（⋯）→ 删除**，需要确认。个人模式删除本地定义；Team 模式仅作者显示入口，删除后会从团队列表移除，包括已发布版本。关联 App、子 Workflow 和历史运行记录会保留。列表卡片不展示删除入口。
