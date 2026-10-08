# Process/App 自动补偿手工验收

本例无需 LLM 或外部服务：

```text
Start → Generate document (Process) → Audit document (Process) → End
```

Generator 成功生成文件，Auditor 默认拒绝审核，workflow 失败后自动执行 Generator 的 `compensate.py`。
Auditor 只读且没有配置补偿。失败调用不会触发补偿；有副作用的 App 必须在业务代码中自行处理失败清理。
业务文件和测试开关位于 `/tmp/workrun-saga-demo/<caseId>/`，不修改 App 源码指纹。

## 准备 App

使用当前开发版本 Workrun 和包含 `workrun_sdk.compensation` 的 SDK。
创建两个 Workflow 类型 App：

| App                 | 业务入口 | 补偿入口      | 复制文件                   |
| ------------------- | -------- | ------------- | -------------------------- |
| Saga Demo Generator | main.py  | compensate.py | generator/ 中所有 .py 文件 |
| Saga Demo Auditor   | main.py  | 不配置        | auditor/main.py            |

保留 Workrun 创建的 `pyproject.toml`、`uv.lock`、`.venv`。
`app-config.json` 是配置参考，不是导入文件。按对应 JSON 配置 inputs/outputs；
Generator 启用补偿并填写 `compensate.py`，无需幂等契约、另一 App 或执行时补偿审批。
Auditor 关闭补偿。若之前创建过这两个 App，需要同步脚本与配置后创建新任务；不要改动尚待补偿的原 App 代码。

补偿入口通过 `compensation.context()` 读取冻结的原输入和结果，不读取最新 workflow State。
脚本退出码 0 即补偿完成，`compensation.result()` 是可选回执。本例通过 stdout 输出补偿结果。
清理前验证原文件路径和内容哈希；文件已经不存在也视为成功，避免删除其他执行生成的文件。

## 配置 workflow

选择生产模式，输入字段 `caseId`、输出字段 `audit`。
Generate document 选择 Generator App，State readers / 可读节点允许 Audit document。
Audit document 选择 Auditor App，globalKeys 添加 `audit`。
无需提升 document 到 global，也无需配置节点补偿覆盖。

`workflow-dsl.json` 是后端 DSL 参考，替换两个 `REPLACE_*_APP_ID` 后使用。
它不是 React Flow 编辑器文档；界面操作可按上述说明配置。

## 失败后自动补偿

1. 使用新的输入 `{"caseId":"auto-01"}`，不创建 `allow-audit.flag`。
2. Generator 成功，Auditor 报 `DEMO_AUDIT_REJECTED`，任务失败。
3. 不需要点击“放弃并补偿”、对账 Auditor 或确认补偿。等待 Generator 补偿完成。
4. 查看运行输出：Generator 的应用 stdout、结构化结果、补偿完成状态、补偿 stdout 依次显示。
   补偿输出包含 `COMPENSATED`；Auditor 的错误显示在自己的失败 message 中。
5. 检查：
   ```bash
   ls /tmp/workrun-saga-demo/auto-01/files
   cat /tmp/workrun-saga-demo/auto-01/executions.jsonl
   cat /tmp/workrun-saga-demo/auto-01/compensations.jsonl
   ```
   files 目录为空；业务日志一行、补偿日志一行，补偿记录 `removed=true`。
   诊断日志保留，便于核对。任务执行状态仍为失败，不因补偿成功变为成功。
6. 自动补偿开始后不能继续原任务、复用已删除的文件。修复条件后使用“重新运行”，创建新任务。

## 成功执行不补偿

先准备新的案例，再运行 `{"caseId":"success-01"}`：

```bash
mkdir -p /tmp/workrun-saga-demo/success-01
touch /tmp/workrun-saga-demo/success-01/allow-audit.flag
```

预期审核通过，`audit.approved=true`；文件保留，没有补偿日志或补偿 message。
用户“停止执行”也不触发自动补偿；本例运行很短，不适合用点击时机验证停止行为。

## 修复后重新运行

在 `auto-01` 自动补偿完成后：

```bash
touch /tmp/workrun-saga-demo/auto-01/allow-audit.flag
```

点击“重新运行”。预期任务 ID 改变，重新生成文件且 token 改变，业务日志增加一行，审核通过。
这是新业务执行，不是恢复原操作。不要再使用旧说明中的“补偿后继续原任务”。

## 补偿失败与重启

补偿自动启动，故障开关必须在 workflow 执行前准备：

```bash
mkdir -p /tmp/workrun-saga-demo/undo-failure-01
touch /tmp/workrun-saga-demo/undo-failure-01/fail-compensation.flag
```

运行 `{"caseId":"undo-failure-01"}`。审核失败后，Generator 补偿在删除前抛异常。
预期原文件保留，补偿 stdout/stderr 可见，补偿结果待确认。
退出并重启 Workrun，任务及尝试历史保留；未知的 Process 补偿不会盲目重发。
删除开关本身不会让未知操作自动重试。当前简化输出面板不提供完整的补偿对账/重试操作，
本例只验收持久化及防重复提交，不承诺通过面板完成这一故障的恢复。

若退出时补偿尚未派发，重启后 worker 可继续；若已经派发且结果未持久化，则可能待确认。
本例不是精确的崩溃窗口测试，该窗口需后端测试或故障注入验证。

## 可选：App 作为 Agent 工具

创建 Tool 类型 App，复制 generator/ 的全部 .py 文件，业务入口用 `tool_main.py`，
补偿入口用 `compensate.py`，输入输出与 Generator 相同。
workflow 改为 `Start → Agent → Audit(Process) → End`：

- Agent 只选择这个工具，要求原样传入 caseId、仅调用一次，并原样返回 document 结构化结果。
- 工具参数 caseId 使用 State 绑定；Agent 的 State readers 允许 Audit。
- 使用新 caseId，不创建审核通过开关。

若业务工具策略是 ask_every_time，正常工具调用仍需批准；自动补偿无需独立审批。
工具成功后，无论 Agent 整理回答失败还是后续审核失败，都应补偿该成功调用。
多次成功调用各有独立操作及补偿记录，按依赖逆序处理。
这是 LLM 集成场景，建议先完成确定性的 Process 场景。

## 验收边界

每个独立场景使用新的 caseId，记录任务 ID、文件 token、业务/补偿日志行数。
App 页面单独运行不属于 workflow 自动补偿验收。
历史失败任务不会被追溯补偿，历史未保存的补偿 stdout 也无法补回。
源代码或 lockfile 在原执行后发生变化时，清理会被保护性阻止；恢复原文件不意味着未知补偿可直接重发。
