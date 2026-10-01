---
title: App、工具与 MCP
description: 用 Process App、Tool App、MCP、Skill 与运行时表单，为 Agent 和代码划清职责边界。
---

Workrun 不需要把业务规则、外部集成和人工操作全塞进 Prompt。工作流决定何时执行确定性代码；Agent 决定何时调用工具；App 可在运行时向人请求输入；MCP 用于复用已有工具服务。

本页以一个可完整演示的「客户支持工单」为例：客户说“订单一直没有收到，想知道怎么办？”，工作流规范化消息；Agent 查询订单并提出建议；工作人员确认退款、补发或升级。

## 先决定能力放在哪里

| 能力             | 谁触发                      | 适合的工作                               | 本例                           |
| ---------------- | --------------------------- | ---------------------------------------- | ------------------------------ |
| Process App      | 工作流的 Process 节点       | 必须在固定位置稳定执行的代码             | 清理工单文本                   |
| Tool App         | Agent 按需调用              | Agent 根据上下文决定是否查询、计算或行动 | 查询订单状态                   |
| MCP Server       | Agent 调用已发现的 MCP 工具 | 已由另一项服务维护的能力                 | 搜索帮助中心政策               |
| Skill            | Agent 按需加载              | 任务步骤、语气和约束                     | 先查订单；仅在可退款时建议退款 |
| JSON Schema 表单 | 正在运行的 Python App       | 需要人补充信息或确认的时刻               | 选择并确认处理方式             |

简单原则：**固定且可复现的步骤用 Process App；是否行动取决于语言和上下文时用 Agent + Tool；已有 MCP 集成时接 MCP；需要人为判断时让 App 弹出表单。** Skill 只提供规则和上下文，不执行代码。

## 一条可以直接演示的闭环

```text
客户输入：TK-2025-001，订单一直没有收到，想知道怎么办？
        ↓
Process App：规范化消息，写回 normalized_message
        ↓
Agent + lookup_order Tool App：查询订单，得到 delayed / can_refund=true
        ↓
Agent：建议退款，并把建议写入工作流状态
        ↓
Process App：collect() 请求工作人员选择处理方式
        ↓
confirm() 确认 → 返回 { status: "approved", resolution: "refund" }
```

这条链路故意只用一个本地 Tool App。MCP 是同一位置的替换项：若帮助中心或订单系统已提供 MCP，就在 Agent 工具列表中选择它，而不是再写一遍集成。

## 配置这个示例

App 的输入来自工作流状态，Tool App 的参数来自 Agent 调用；两者都应在工作流中验证，而不是作为独立命令行程序手动输入 stdin。以下按创建顺序配置。

### 1. 创建三个 App

在 **Apps → 新建** 中先创建「规范化支持工单」。在“应用类型”选择 **App**（不要选 Tool App），创建后进入详情页。在“数据契约”里，分别在“输入”和“输出”区域点击“添加字段”，填入下表；每个字段的“字段名称”就是 Key。保存 App 元数据后，点击“打开项目目录”，用编辑器替换项目入口文件中的示例代码。首次运行会自动创建 Python 环境并安装依赖，因此可能比后续运行多花一点时间。

| 方向 | Label      | Key                  | 类型   | 必填 |
| ---- | ---------- | -------------------- | ------ | ---- |
| 输入 | 工单编号   | `ticket_id`          | string | 是   |
| 输入 | 客户消息   | `customer_message`   | string | 是   |
| 输出 | 工单编号   | `ticket_id`          | string | 是   |
| 输出 | 规范化消息 | `normalized_message` | string | 是   |
| 输出 | 消息长度   | `message_length`     | number | 是   |

将入口改为下面的代码。它只清理空白字符，并将后续节点需要的字段写回状态：

```python
import json
import sys

from workrun_sdk import process


def main() -> None:
    state = json.loads(sys.stdin.read() or "{}")
    ticket_id = str(state.get("ticket_id", "")).strip()
    # Normalize once so every downstream node reads the same customer message.
    message = " ".join(str(state.get("customer_message", "")).split())
    process.result(
        {
            "ticket_id": ticket_id,
            "normalized_message": message,
            "message_length": len(message),
        }
    )


if __name__ == "__main__":
    main()
```

再创建名为 `lookup_order` 的 App，类型选择 **Tool App**。它在工作流编辑器的工具列表中显示为这个 App 名称；无需、也没有单独的“工具名称”输入框。描述填写“按订单号查询订单状态和退款资格；仅在需要确认订单状态或退款资格时调用”。在数据契约中添加：

| 方向 | Label        | Key                  | 类型    | 必填 |
| ---- | ------------ | -------------------- | ------- | ---- |
| 输入 | 工单编号     | `ticket_id`          | string  | 是   |
| 输出 | 订单状态     | `status`             | string  | 是   |
| 输出 | 预计送达日期 | `estimated_delivery` | string  | 是   |
| 输出 | 是否可退款   | `can_refund`         | boolean | 是   |

使用稳定的演示返回值，避免演示依赖真实订单服务：

```python
from workrun_sdk.tool import tool


@tool(
    name="lookup_order",
    description="Look up an order before recommending a refund or replacement.",
)
def lookup_order(ticket_id: str) -> dict[str, object]:
    return {
        "status": "delayed",
        "estimated_delivery": "2025-03-12",
        "can_refund": True,
    }
```

最后创建「人工确认处理方式」，类型仍选择 **App**。在数据契约中添加：

| 方向 | Label    | Key              | 类型   | 必填 |
| ---- | -------- | ---------------- | ------ | ---- |
| 输入 | 工单编号 | `ticket_id`      | string | 是   |
| 输入 | 处理建议 | `recommendation` | string | 是   |
| 输出 | 处理状态 | `status`         | string | 是   |
| 输出 | 处理方式 | `resolution`     | string | 否   |

将 `resolution` 标记为可选，确保用户取消表单时仍可返回结果。完整入口代码如下：

```python
from collections.abc import Mapping

from workrun_sdk import choice, collect, confirm, process


RESOLUTION_LABELS = {
    "reply": "仅回复客户",
    "reship": "补发商品",
    "refund": "办理退款",
    "escalate": "升级给人工客服",
}


def main() -> None:
    settings = collect(
        title="处理支持工单",
        description="选择处理方式后再继续。",
        fields={
            "resolution": choice(
                "处理方式",
                RESOLUTION_LABELS,
                required=True,
            ),
        },
    )

    # collect() returns generic JSON, so validate it before indexing or publishing it.
    if not isinstance(settings, Mapping):
        process.result({"status": "cancelled"})
        return

    resolution = settings.get("resolution")
    if not isinstance(resolution, str) or resolution not in RESOLUTION_LABELS:
        process.result({"status": "cancelled"})
        return

    # Persist the stable value (for example, "refund") but show its Chinese label to people.
    if confirm(f"确认将工单处理为“{RESOLUTION_LABELS[resolution]}”？", title="确认处理"):
        process.result({"status": "approved", "resolution": resolution})
    else:
        process.result({"status": "rejected", "resolution": resolution})


if __name__ == "__main__":
    main()
```

### 2. 搭建画布（先连线，再填配置）

新建**任务型**工作流。画布默认已有 Start 和 End；从左侧拖入两个“应用”节点和一个“智能体”节点，按下面顺序连接。必须保留 Start 和 End：只有中间三个节点相连，运行不会形成完整流程。

```text
Start → 规范化支持工单（应用） → 订单处理建议（智能体）
      → 人工确认处理方式（应用） → End
```

逐个选中两个“应用”节点，在右侧“应用连接”中的“应用”下拉框选择相应的 App。若下拉列表为空，回到 Apps 检查该项目已创建且本地可用；不要选择 `lookup_order`，它只能附加到智能体，不能放在画布的“应用”节点上。

点击画布工具栏的“更多设置”，在“运行输入”中点击三次“添加输入”，再填入下列字段。保存工作流后再运行；运行面板会按这些 Key 显示输入框。

| Label    | Key                | 类型   | 示例值                             |
| -------- | ------------------ | ------ | ---------------------------------- |
| 工单编号 | `ticket_id`        | string | `TK-2025-001`                      |
| 客户消息 | `customer_message` | string | `订单一直没有收到，想知道怎么办？` |

### 3. 发布节点输出到全局状态

运行输入本身就是全局状态，所有节点都能读取。因此这里**不用**在下游节点设置“可读取的状态”。右侧的“状态访问”只控制“本节点的私有输出可被哪些其他节点读取”；本例把结果发布为全局状态即可。

分别选中三个执行节点，在右侧最下方的“发布到全局状态 → 已发布的输出键”填入：

| 节点             | 已发布的输出键                       |
| ---------------- | ------------------------------------ |
| 规范化支持工单   | `normalized_message, message_length` |
| 订单处理建议     | `recommendation`                     |
| 人工确认处理方式 | `status, resolution`                 |

不要在第一个节点发布 `ticket_id`：它已经是运行输入中的全局键，重复发布没有必要。也不要在本例中修改“允许读取的节点”。如果将来故意保留某项私有输出，应该在**产生该输出的节点**的“允许读取的节点”中选中消费者节点，而不是在消费者节点里寻找读取字段的设置。

### 4. 配置智能体、工具与结构化输出

选中“订单处理建议”智能体节点，在“模型与指令”选择已配置的模型配置。在“工具”区域选择 `lookup_order`，将“调用上限”设为 `1`、“工具超时”设为 `10` 秒。这个演示工具通过 `ticket_id` 查询工单关联订单；它与工作流输入 Key 同名，因此会自动从状态恢复，无需添加“状态绑定”。只有 Tool App 参数名和状态 Key 不同时才需要使用“状态绑定（高级）”。

在“结构化输出架构（高级）”粘贴以下完整 JSON Schema。该编辑器接受的是对象 Schema，并非逐字段的 Label/Key 表单；填写它后，`recommendation` 会成为智能体的节点输出。

```json
{
  "type": "object",
  "properties": {
    "recommendation": {
      "type": "string",
      "description": "给工作人员的处理建议"
    }
  },
  "required": ["recommendation"]
}
```

在指令框使用以下内容：

```text
你是客户支持分流助手。对于订单未送达问题，必须先调用 lookup_order，并传入已授权状态中的 ticket_id。

当工具返回 status 为 delayed 且 can_refund 为 true 时，recommendation 必须为“建议退款”。
不要实际执行退款、补发或升级；只说明订单状态、预计送达时间和处理建议。
```

### 5. 运行、逐步验证与排错

保存后点击“运行”，输入步骤 2 的示例值。正常的可观察顺序如下：

1. “规范化支持工单”完成，运行详情的全局状态出现 `normalized_message` 和 `message_length`。
2. 智能体调用一次工具列表中的 `lookup_order`，随后发布 `recommendation: "建议退款"`。
3. “人工确认处理方式”先显示处理方式表单；选择后点击“提交”，随后会显示第二个确认框。确认后节点才会结束。
4. 最终全局状态出现 `status: "approved"` 和 `resolution: "refund"`。

| 现象                                                | 优先检查                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 应用节点下拉框找不到 App                            | Apps 中该 App 是否为 **App** 类型、已创建完成且本地可用。Tool App 不会出现在这里。                                              |
| 智能体找不到 `lookup_order`                         | 它是否为 **Tool App**，输入和输出是否至少各有一个字段；然后在该智能体的“可用工具”中显式选中它。                                 |
| Tool App 报参数不完整                               | Tool App 的输入 Key 应为 `ticket_id`；运行输入也必须有 `ticket_id`。同名时不需要状态绑定。                                      |
| 下游拿不到 `normalized_message` 或 `recommendation` | 检查**产生值的节点**是否已将该 Key 填入“已发布的输出键”，并保存工作流。                                                         |
| Agent 只有文本，没有 `recommendation`               | 检查“结构化输出架构”是否为上面的有效 JSON，并且 Agent 节点已发布 `recommendation`。                                             |
| 表单没有出现或运行失败                              | 打开该应用节点的运行输出，确认入口调用了一次 `process.result({...})`；取消表单时 `resolution` 必须在 App 输出契约中设为非必填。 |

<video controls preload="metadata" playsinline aria-label="已完成配置的支持工单工作流">
  <source src="/media/apps-tools-and-mcp/apps-tools-and-mcp-demo.mp4" type="video/mp4" />
</video>

该视频展示已配置完成的工单工作流：输入工单、订单查询、Agent 建议、人工确认，以及最终结构化结果。视频仅使用演示数据。

## App 与 Schema：可维护的确定性能力

每个 Python App 都是可编辑的本地 `uv` 项目，有自己的 `pyproject.toml`、锁文件、虚拟环境和入口脚本。Workrun 创建、运行项目并显示 stdout/stderr；代码仍可正常测试、审查和版本管理。

- **Process App** 从标准输入读取获授权的工作流状态 JSON，以 `process.result({...})` 返回结构化更新。
- **Tool App** 由 Agent 根据名称、描述和 JSON Schema 决定是否调用；它接收已验证参数，必须返回 JSON 对象。

Schema 是调用契约，而不只是表单配置。为 Process App 声明输入、输出可以让数据边界在编辑器中可见；Tool App 的输入、输出会被编译为 Agent 可读的 JSON Schema。字段应小而明确：`lookup_order` 接收 `ticket_id` 并查询其关联订单，返回 `status`、`estimated_delivery`、`can_refund`，而不是接收整段工单或返回原始日志。

「规范化支持工单」的完整入口代码已在上面的配置步骤中给出；它读取输入、清理文本并只返回下游节点需要的字段。

## Tool App 与 MCP：给 Agent 可验证的行动能力

Tool App 的名称、描述、输入 Schema 和输出 Schema共同构成调用契约。Agent 只能生成已声明字段的参数；Workrun 在调用前校验参数。工具名称以动词开头，描述写清何时该用、何时不该用；对写入、删除、发送等副作用工具设置人工确认、调用上限和单次超时。

例如，`lookup_order` 可只接受 `ticket_id` 并查询关联订单，返回 `status`、`estimated_delivery` 和 `can_refund`。MCP 适合已有服务或团队维护工具的情形；需要在本机快速编写、测试和版本化能力时使用 Tool App。两者都必须在具体 Agent 的工具列表中显式选择，不能因为“已连接”就默认暴露给所有 Agent。

## 运行时 JSON Schema 表单：让代码等待人的判断

App 在运行中可请求 Workrun 显示表单，提交、拒绝或取消后取得 JSON 兼容结果继续执行。这是运行时 App 到人的交互，不是编辑器中的静态配置。

| API         | 适用场景                                         | 返回值                  |
| ----------- | ------------------------------------------------ | ----------------------- |
| `form()`    | 完整 JSON Schema、嵌套数据、数组或自定义 RJSF UI | 提交数据；取消为 `None` |
| `collect()` | 常见命名字段，不想手写完整 Schema                | 字段字典；取消为 `None` |
| `confirm()` | 只需确认或拒绝一个动作                           | `True` 或 `False`       |

例如，表单可提供“仅回复客户”“补发商品”“办理退款”“升级给人工客服”四种处理方式，并在确认后返回 `status` 和 `resolution`。表单只用于人必须判断或补充的值。已经存在于输入、已发布状态或固定配置中的数据应直接传给 App，避免无意义地暂停运行。

## 安全与下一步

Workrun 为其启动的 Python 进程提供受令牌保护的本地 IPC；运行时表单通过该通道与桌面端通信。Provider 与 MCP 凭据加密保存在本机，敏感状态默认使用脱敏视图，工具参数和运行事件经过护栏处理。

这不等于沙箱。App 的文件、网络与系统权限取决于本机环境；只运行可信代码，并对外部服务和副作用工具同时使用最小权限、清晰 Schema、人工确认、调用上限、超时和运行记录。

继续阅读[使用 Python App](/zh-cn/guides/python-apps/)了解创建项目和接入工作流的细节，或阅读[连接 MCP Server](/zh-cn/guides/connect-an-mcp-server/)配置已有工具服务。
