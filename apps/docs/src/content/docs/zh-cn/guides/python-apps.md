---
title: 使用 Python App
description: 理解 App 与 Tool App 的区别；独立运行 App，或将它作为 Process 节点和 Agent 工具接入工作流。
---

Python App 是完整、可编辑的本地 `uv` 项目，适合稳定复现的数据处理、计算、文件操作和内部系统集成。不要把它理解为另一种 Prompt：App 的代码、依赖和数据契约都可以独立测试、审查和版本管理。

Workrun 有两种类型。选择的关键不是代码使用什么语言，而是**谁决定何时运行它**。

| 类型                   | 谁触发                                    | 可否独立运行                | 如何加入工作流                                   | 适用场景                                   |
| ---------------------- | ----------------------------------------- | --------------------------- | ------------------------------------------------ | ------------------------------------------ |
| **App / Process Node** | 人在 App 页面运行，或工作流按画布顺序运行 | 可以                        | 选为 **Process** 节点的“应用连接”                | 固定位置的收集、清洗、计算、文件或系统操作 |
| **Tool App**           | Agent 根据名称、描述和 Schema 决定调用    | 它的有效调用来自 Agent 参数 | 在 Agent 的**工具**中勾选，不能放到 Process 节点 | 查询、计算或行动是否需要发生取决于当前任务 |

> App 不是沙箱。它拥有当前用户环境中的文件、网络和系统权限；只运行可信代码，并尽量缩小敏感数据和副作用操作的范围。

## 1. 独立运行一个 App：收集健康信息

先从独立运行开始，最容易理解 App 的运行模型。下面的「健康信息收集」App 不需要工作流输入：用户在 **Apps** 页面点击运行后，代码请求 Workrun 弹出表单，收集邮箱、身高和体重，再将结果显示在运行输出中。

进入 **Apps → 新建**，选择 **App**（不要选择 Tool App），命名为「健康信息收集」。选择项目位置，让 Workrun 创建 `uv` 项目。在“数据契约”的输出区域添加以下字段；取消表单时只有 `status` 会返回，因此其余三个输出应设为**非必填**。

| 方向 | Label        | Key         | 类型   | 必填 |
| ---- | ------------ | ----------- | ------ | ---- |
| 输出 | 收集状态     | `status`    | string | 是   |
| 输出 | 邮箱         | `email`     | string | 否   |
| 输出 | 身高（厘米） | `height_cm` | number | 否   |
| 输出 | 体重（千克） | `weight_kg` | number | 否   |

将入口代码替换为：

```python
import json

from workrun_sdk import collect, number, process, text


def main() -> None:
    profile = collect(
        title="填写健康信息",
        description="这些信息仅用于本次收集。",
        layout=[["height_cm", "weight_kg"]],
        fields={
            "email": text("邮箱", required=True, placeholder="name@example.com"),
            "height_cm": number("身高（厘米）", required=True, minimum=50, maximum=300),
            "weight_kg": number("体重（千克）", required=True, minimum=1, maximum=500),
        },
    )

    # A cancellation still has a defined result, so a workflow caller can continue safely.
    result = {"status": "cancelled"} if profile is None else {
        "status": "submitted",
        **profile,
    }
    print(json.dumps(result, ensure_ascii=False))
    process.result(result)


if __name__ == "__main__":
    main()
```

<video controls preload="metadata" playsinline aria-label="独立运行健康信息收集 App">
  <source src="/media/python-apps/01-standalone-health-information.mp4" type="video/mp4" />
  当前浏览器不支持 MP4 视频播放，请从文档媒体目录下载视频查看。
</video>

在 App 页面点击**运行**。你会看到表单；提交后，运行输出会打印 `status`、`email`、`height_cm` 和 `weight_kg` 的 JSON。`collect()` 返回字典；用户取消时返回 `None`，因此示例只返回 `{"status": "cancelled"}`。

视频展示从 Apps 页面独立运行「健康信息收集」、填写表单并查看结果的完整过程。

这个例子说明了独立 App 的用途：它可以是一个本地小工具或人工收集步骤，并不需要 Agent 或工作流才能产生价值。`form()` 适合嵌套数据、数组或完整 JSON Schema；`confirm()` 适合只有同意/拒绝的情况。

## UI SDK：用 JSON Schema 构建运行时交互

Python UI SDK 不要求你写 React 界面。App 将 JSON Schema、可选的 UI Schema 和文案经本地 IPC 发送给桌面端；桌面端使用[react-jsonschema-form（RJSF）](https://github.com/rjsf-team/react-jsonschema-form)及 AJV 8 校验器渲染表单。也就是说：**Schema 定义数据结构和校验，UI Schema 控制组件与布局，Python 接收提交后的 JSON。**

`collect()` 是针对常见字段的便捷封装：它自动构建对象 Schema，并将 `layout` 转换为 RJSF 的 `LayoutGridField` 配置。需要嵌套对象、数组、条件结构或精确控制 UI Schema 时，直接使用 `form()`。表单取消会返回 `None`；同一次 App 运行可以在收到结果后继续发起下一次交互。

| API          | 用途                                  | 返回值                        | 何时使用                                             |
| ------------ | ------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| `form()`     | 发送完整 JSON Schema 和可选 UI Schema | 提交的 JSON 值；取消时 `None` | 嵌套对象、数组、`oneOf`，或需要直接使用 RJSF 配置时  |
| `collect()`  | 用字段构造器快速收集命名字段          | JSON 对象；取消时 `None`      | 普通表单；本页健康信息示例即使用它                   |
| `confirm()`  | 显示确认/取消对话框                   | `True` 或 `False`             | 发送、删除、覆盖等单一决定                           |
| `text()`     | 构造字符串字段                        | `Field`，传给 `collect()`     | 单行/多行文本、说明、占位符                          |
| `number()`   | 构造数字或整数字段                    | `Field`，传给 `collect()`     | 范围、整数、步长和数值占位符                         |
| `choice()`   | 构造单选字段                          | `Field`，传给 `collect()`     | 下拉选择或单选按钮；Key 是保存值，Value 是显示 Label |
| `boolean()`  | 构造布尔字段                          | `Field`，传给 `collect()`     | 复选框或开关式确认                                   |
| `path()`     | 构造文件/目录选择字段                 | `Field`，传给 `collect()`     | 需要桌面端原生文件或目录选择器                       |
| `shutdown()` | 关闭共享 IPC 客户端                   | 无                            | 通常无需调用；SDK 已在进程退出时自动清理             |

### 使用 `form()`：完整 Schema 与 UI Schema

下面的例子要求邮箱和身高，允许选择活动目标；`ui_schema` 则将邮箱替换为带占位符的控件，并让目标使用单选按钮。JSON Schema 和 RJSF 支持的 UI Schema 是可序列化数据，不能在其中传入 Python 回调或 React 组件。

```python
from workrun_sdk import form


health_profile = form(
    title="补充健康信息",
    description="提交前会按 Schema 校验必填字段和数值范围。",
    schema={
        "type": "object",
        "properties": {
            "email": {"type": "string", "title": "邮箱", "format": "email"},
            "height_cm": {"type": "integer", "title": "身高（厘米）", "minimum": 50, "maximum": 300},
            "goal": {
                "type": "string",
                "title": "活动目标",
                "oneOf": [
                    {"const": "maintain", "title": "保持健康"},
                    {"const": "reduce", "title": "控制体重"},
                ],
            },
        },
        "required": ["email", "height_cm", "goal"],
    },
    ui_schema={
        "email": {"ui:placeholder": "name@example.com"},
        "goal": {"ui:widget": "radio"},
    },
    submit_label="保存",
    cancel_label="暂不填写",
)
```

`form()` 的返回值是 JSON 兼容值，因此在将它传给 `process.result()` 前，应先处理取消并确认顶层结果是对象。若只是平铺的命名字段，优先使用 `collect()`，它能避免手写上述 Schema。

### 使用 `collect()` 与字段构造器

本页第一个例子已经展示 `text()` 和 `number()`。以下片段补充其余常见字段：`choice()` 的字典键是程序读取的稳定值，字典值才是用户看到的 Label；`ui_options` 会原样传入 RJSF 的 `ui:options`。

```python
from workrun_sdk import boolean, choice, collect, path, text


settings = collect(
    title="导出设置",
    layout=[["format", "include_headers"], ["destination"]],
    fields={
        "format": choice(
            "导出格式",
            {"csv": "CSV", "json": "JSON"},
            required=True,
            widget="radio",
        ),
        "include_headers": boolean("包含表头"),
        "destination": path("保存目录", directory=True, required=True, button_label="选择目录"),
        "note": text("备注", multiline=True, placeholder="可选"),
    },
)
```

`layout` 中同一行的字段等宽显示；未列出的字段会自动追加为单独一行。取消时 `settings` 为 `None`，不要直接索引它。表单只应收集运行时确实需要由人判断或补充的值；已知输入、固定配置或工作流状态应直接使用，避免无意义地暂停运行。

### 使用 `confirm()`：把副作用交给人决定

`confirm()` 返回布尔值，适合简单、明确的风险操作。应在实际写入、删除或发送之前调用，而不是让 Agent 或代码在没有人确认的情况下完成副作用。

```python
from workrun_sdk import confirm


if confirm("将向 42 位订阅者发送本周摘要。", title="确认发送", confirm_label="发送"):
    send_weekly_digest()
```

## 2. 同一个 App 也能作为 Process 节点

**App** 的第二种用法是进入工作流。将「健康信息收集」作为 **Process** 节点选择后，工作流到达该节点时会出现同一个表单；提交结果成为该节点的结构化输出。选择节点后，在 **发布到全局状态 → 已发布的输出键** 填入需要给后续节点使用的键：

```text
status, email, height_cm, weight_kg
```

这时，下游 Agent、条件或其他 Process 节点才能读取这些值。由于邮箱是敏感信息，应只发布和授权真正需要它的节点；如果后续只需根据身高和体重计算指标，就不要发布 `email`。

Process App 也可读取工作流状态。例如要在用户填写前显示已知邮箱，在“数据契约”中增加输入字段：

| 方向 | Label    | Key     | 类型   | 必填 |
| ---- | -------- | ------- | ------ | ---- |
| 输入 | 已知邮箱 | `email` | string | 否   |

工作流输入本身是全局状态。Process 的普通输出默认留在私有命名空间，只有列入“已发布的输出键”才会成为共享状态。有关将 Process、Agent 和分支组合为流程的完整示例，见[构建第一个工作流](/zh-cn/guides/build-a-workflow/)。

## 3. Tool App：让 Agent 按需调用能力

当是否查询或行动取决于 Agent 对任务的判断时，使用 **Tool App**。例如新建 Tool App，命名为 `lookup_order`；工具名用动词开头，描述必须写清何时可以使用以及不能做什么，例如：“按订单号查询订单状态和退款资格；仅在需要确认订单状态或退款资格时调用。”

声明小而明确的契约：

| 方向 | Label        | Key                  | 类型    | 必填 |
| ---- | ------------ | -------------------- | ------- | ---- |
| 输入 | 订单编号     | `ticket_id`          | string  | 是   |
| 输出 | 订单状态     | `status`             | string  | 是   |
| 输出 | 预计送达日期 | `estimated_delivery` | string  | 是   |
| 输出 | 是否可退款   | `can_refund`         | boolean | 是   |

用下面的演示实现验证接线。接入真实订单系统时，只替换函数内部的查询逻辑，并保留相同的输入和输出契约：

```python
from workrun_sdk.tool import tool


@tool(
    name="lookup_order",
    description="Look up an order before recommending a refund or replacement.",
)
def lookup_order(ticket_id: str) -> dict[str, object]:
    # A fixed result keeps this tutorial independent from a real order system.
    return {
        "status": "delayed",
        "estimated_delivery": "2025-03-12",
        "can_refund": True,
    }
```

在工作流画布选中 Agent，在**工具**区域勾选 `lookup_order`。Tool App 不能作为 Process 节点拖入画布；Agent 会根据工具描述、输入 Schema 和自己的指令决定是否调用它。为此工具设置调用上限 `1`、工具超时 `10` 秒。查询是只读演示，可以关闭人工确认；写入、删除、发送等副作用工具必须开启确认。

![Agent 的工具配置：已选择 lookup_order，并设置调用上限、超时和人工确认。](/media/python-apps/02-agent-tool-configuration.png)

若 Tool App 的参数 Key 与工作流状态 Key 相同，Workrun 会从已授权状态恢复参数。例如运行输入也是 `ticket_id` 时，不需要状态绑定。参数名不同才使用**状态绑定（高级）**，并将每个工具参数映射到正确的状态 Key。

在 Agent 指令中明确调用规则：

```text
客户询问订单状态、退款或补发时，先调用 lookup_order，并传入 ticket_id。
调用后根据 status、estimated_delivery 和 can_refund 提出建议；不要实际执行退款或补发。
```

## 为有副作用的 App 配置补偿

Process App 和 Tool App 都可以在同一项目配置独立的 `compensate.py`。workflow 最终失败后，Workrun 自动清理已成功的调用，并在对应节点 message 中显示结果；正常完成和停止执行不触发。修复后通过“重新运行”创建新任务。完整配置、可运行示例和恢复边界见[App 失败补偿](/zh-cn/guides/app-compensation/)。

## 4. 验证与排错

先在 App 页面独立运行 App，确认表单、stdout/stderr 和输出 JSON 正常；再把它接到工作流验证状态发布。Tool App 则在包含 Agent 的工作流中验证。

| 现象                    | 优先检查                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| 表单没有出现            | 代码是否由 Workrun 的 App 页面或工作流启动；入口是否调用 `collect()`、`form()` 或 `confirm()`。 |
| 取消表单后工作流失败    | 输出契约中可能在取消时缺失的字段是否已设为非必填；代码是否返回了 `status`。                     |
| 下游看不到 Process 的值 | 在**产生该值的节点**中检查它是否已列入“已发布的输出键”。                                        |
| Agent 没有调用工具      | 是否已勾选 Tool App；工具描述和 Agent 指令是否写明使用条件；输入是否含 `ticket_id`。            |
| 工具参数为空或校验失败  | Tool App 输入 Schema 的 Key 是否为 `ticket_id`；名称不同时是否配置状态绑定。                    |

运行记录会保留 App 的 stdout/stderr、工具输入输出和节点事件。先定位失败节点，再决定改代码、Schema、权限、指令还是模型配置。

完整的表单 API 说明见[App、工具与 MCP](/zh-cn/concepts/apps-tools-and-mcp/#运行时-json-schema-表单让代码等待人的判断)；已有工具服务可通过[连接 MCP Server](/zh-cn/guides/connect-an-mcp-server/)接入。
