---
title: App 失败补偿
description: 为 Process App 和 Agent Tool App 配置独立补偿入口，自动清理失败工作流中已成功调用产生的资源。
---

App 创建文件、上传内容或写入外部系统后，后续步骤仍可能失败。为 App 配置补偿入口，Workrun 就能在 **workflow 最终失败后**自动清理该次任务中已经成功的调用。补偿逻辑由你编写，例如删除本次创建的文件、撤销本次发布或取消本次预订。

**修复后点击“重新运行”，创建一次新的运行。** 新运行会重新执行业务；原运行保留失败原因和补偿记录。已补偿的文件或资源不能继续作为有效结果使用。

## 何时执行补偿

| 场景                                            | 行为                                                       |
| ----------------------------------------------- | ---------------------------------------------------------- |
| workflow 最终失败，App 调用成功且配置了补偿入口 | 自动执行补偿，无需执行时确认                               |
| App 调用失败，或结果未知                        | 不自动补偿；失败调用由代码自行清理，未知结果先核实外部状态 |
| App 未配置补偿入口                              | 跳过，不要求所有 App 提供补偿                              |
| workflow 正常完成                               | 不执行补偿                                                 |
| 用户停止执行                                    | 不触发自动补偿；停止不代表副作用已经撤销                   |
| 从 Apps 页面独立运行 App                        | 不属于本教程的 workflow 失败补偿范围                       |

触发条件是运行最终标记为失败。业务返回 `approved: false` 或走到拒绝分支，如果 workflow 正常结束，仍属于完成，不会自动补偿。评测运行也不触发这套自动清理；补偿不能代替评测隔离。

只读查询通常不需要补偿。发送邮件等不可逆操作也不能通过配置入口保证撤销，应设计业务补救方式。

## 最小示例：创建文件，失败后删除

这两个文件放在同一个 App 项目中。`main.py` 创建临时文件并返回路径；`compensate.py` 从原执行结果取出路径，删除本次创建的文件。

```python
# main.py
from tempfile import NamedTemporaryFile
from workrun_sdk import process

with NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as file:
    file.write("Hello, Workrun!")

process.result({"file_path": file.name})
```

```python
# compensate.py
from pathlib import Path
from workrun_sdk import compensation

ctx = compensation.context()
Path(ctx.original_result["file_path"]).unlink(missing_ok=True)
compensation.result({"removed": True})
```

在 App 的输出契约中声明必填字符串 `file_path`，并将补偿入口配置为 `compensate.py`。当这个 App 在 workflow 中成功执行、后续步骤导致 workflow 失败时，Workrun 自动执行补偿入口。文件已经不存在时，`missing_ok=True` 让清理仍能成功。

下面的完整教程进一步展示正常调用失败时的自行清理，以及补偿时的路径范围检查。

## 1. 创建可清理的 Process App

先完成[使用 Python App](/zh-cn/guides/python-apps/)中的项目创建与 SDK 配置。在 Apps 中创建一个普通 App，使用 `main.py` 作为正常入口。在输出数据契约中增加必填字符串 `file_path`。下面的代码会为每次调用生成一个独立的临时文件：

```python
# main.py — Process App
from pathlib import Path
from tempfile import gettempdir
from uuid import uuid4
from workrun_sdk import process


def create_file() -> dict[str, str]:
    # Keep generated files outside the App source directory.
    folder = Path(gettempdir()) / "workrun-cleanup-demo"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{uuid4().hex}.txt"
    try:
        path.write_text("Created by this workflow run", encoding="utf-8")
        return {"file_path": str(path)}
    except Exception:
        path.unlink(missing_ok=True)
        raise


if __name__ == "__main__":
    process.result(create_file())
```

独立运行一次，确认返回的路径存在。独立运行不会自动清理这个文件，可在测试后手动删除它。

## 2. 在同一个项目添加补偿入口

在项目中创建 `compensate.py`，与 `main.py` 共用 `pyproject.toml` 和 `uv.lock`：

```python
# compensate.py — shared by Process App and Tool App
from pathlib import Path
from tempfile import gettempdir
from workrun_sdk import compensation


def main() -> None:
    ctx = compensation.context()
    path = Path(ctx.original_result["file_path"]).resolve()
    folder = (Path(gettempdir()) / "workrun-cleanup-demo").resolve()
    # Restrict cleanup to files created by this example.
    if path.parent != folder or path.suffix != ".txt":
        raise ValueError("Unexpected cleanup path")
    path.unlink(missing_ok=True)
    compensation.result({"removed_file": str(path)})


if __name__ == "__main__":
    main()
```

打开 App 详情中的补偿配置，启用提供补偿入口，将入口设为 `compensate.py`，保存 App。**仅创建文件不会启用补偿，还需要保存入口配置。** 路径相对于 App 项目，必须与正常入口不同；不需要创建另一个 App，也不需要填写幂等契约。

正常退出表示完成；非零退出表示未完成。`compensation.result({...})` 可选，用于保存额外结果。

示例使用 `missing_ok=True`，文件已经不存在时也能成功完成清理。这种幂等写法有助于安全处理恢复和人工补救。

## 3. 接入 workflow 并验证

1. 在画布添加 Process 节点，选择这个 App。
2. 后接一个专用于测试失败的 Process App。其 `main.py` 可以只写 `raise RuntimeError("Intentional cleanup test")`，并且不配置补偿。
3. 运行 workflow，确认第一个节点成功返回 `file_path`，后一个节点失败。
4. 打开第一个节点的 message，观察补偿从执行中变为成功；确认对应文件已删除。
5. 修复或替换失败节点，点击“重新运行”。新运行创建新的文件，原运行的记录仍可查看。

务必使用测试资源。若后续节点只是返回一段“失败”文字，但执行正常结束，就不会触发补偿。

## 4. 同样用于 Agent 的 Tool App

Tool App 也在自己的 App 配置中启用同一个 `compensate.py`，不用给 Agent 添加一个“删除文件”工具。补偿由 Workrun 调度，模型不会选择补偿入口。

新建 Tool App，声明必填字符串输出 `file_path`。保留上面的 `create_file()` 函数，删除正常入口的 `process.result(...)` 调用，改用：

```python
# Replace the Process entry block in main.py with this Tool App entry.
from workrun_sdk.tool import tool


@tool(name="create_demo_file", description="Create one temporary demo file.")
def create_demo_file() -> dict[str, str]:
    return create_file()
```

在 Agent 的工具列表中选择这个 Tool App，要求 Agent 调用一次 `create_demo_file`；正常业务工具的确认策略仍按原配置执行。后接第 3 步的失败测试节点，运行后检查 **Agent 节点的 message** 和文件删除结果。

Workrun 按每次工具调用记录补偿，而不是按整个 Agent 节点只记录一次：

- 两次成功调用分别保存各自的输入、结果和操作身份，分别补偿；即使参数相同也不会合并。
- 工具成功后，Agent 整理回答失败，只要 workflow 最终失败，这次成功调用仍会补偿。
- 某次工具调用失败时跳过该次，不影响其他成功调用进入补偿。

Tool App 的补偿脚本使用 `compensation.context()`，无需 `@tool` 装饰器。自动补偿不再弹出工具审批；正常业务调用的审批保持原有行为。

## 补偿上下文：使用原记录定位资源

`compensation.context()` 读取 Workrun 传入的原调用记录：

| 字段                    | 用途                                                  |
| ----------------------- | ----------------------------------------------------- |
| `original_operation_id` | 原调用的稳定身份                                      |
| `compensation_id`       | 本次补偿的稳定身份，可传给支持去重的外部服务          |
| `original_input`        | 原调用实际输入                                        |
| `original_result`       | 原调用保存的成功结果，例如文件路径、上传 ID 或预订 ID |
| `resources`             | 原执行记录中的资源信息                                |

只清理原记录指向的资源，不读取最新 workflow State，也不要按目录或时间范围删除其他任务的数据。正常入口应返回可准确定位资源的标识；不能假设 Workrun 会自动发现所有部分写入的资源。

## 如何查看与处理补偿结果

补偿按已记录的依赖逆序处理。例如发布依赖上传时，应先撤销发布，再清理上传。一个补偿失败不会阻止独立分支继续，但相关前置资源会暂缓清理，避免破坏尚未撤销的后续操作。

在对应 Process 或 Agent 节点 message 中查看状态：

| 状态              | 下一步                                                |
| ----------------- | ----------------------------------------------------- |
| 执行中            | 等待清理完成                                          |
| 成功              | 原调用资源已按你的脚本处理；workflow 原失败状态仍保留 |
| 失败              | 检查入口、权限、依赖及补偿代码，核实资源是否仍存在    |
| 阻塞 / 结果待确认 | 核实外部状态；不要假设尚未执行，也不要直接重复提交    |

当前自动补偿在节点消息中展示，没有单独的自动补偿重试按钮。未完成项需要核实并进行人工补救；不要把新一轮业务执行当作旧资源清理。确认旧资源已妥善处理后，修复问题并重新运行。

## 应用退出与当前边界

补偿意图、状态和结果保存在本地。应用退出期间暂停处理，重启后继续调度；这不提供关闭应用后持续执行的后台能力。已保存成功结果的补偿会复用结果。

如果进程已产生副作用，但本地尚未保存结果就中断，结果可能未知。Workrun 不会盲目重发；外部服务仍需提供查询或幂等去重能力。失败的正常调用也可能产生部分副作用，必须在 App 内使用 `try/except/finally` 或业务事务处理。

任务未结束前保留原 App 源码和锁文件。Workrun 会检查记录的代码指纹，代码或依赖锁文件变化会阻止旧任务补偿；当前没有自动保存不可变代码包。把生成文件放在项目之外，例如本教程的临时目录。入口配置只作用于后续执行，不会追溯清理旧版本的历史失败任务。

进一步排查见[运行、调试与追踪](/zh-cn/quality/runs-and-traces/)。

## 与 Remote Agent 的区别

App 补偿执行你配置的清理代码，只针对 workflow 失败前成功的调用；用户停止不触发 App 自动补偿。Remote Agent 在 workflow 失败或停止后，对有 taskId、尚未结束的任务发起一次标准 A2A 尽力取消；不自动轮询、不重试取消，也不自动撤销已经完成的业务。两者的进度都显示在对应节点 message 中。详见 [Remote Agent 与 A2A 任务处理](/zh-cn/guides/remote-agents/)。
