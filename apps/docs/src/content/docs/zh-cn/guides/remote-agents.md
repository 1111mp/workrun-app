---
title: Remote Agent 与 A2A 任务处理
description: 连接 Remote Agent，了解 workflow 失败或停止后的单次尽力取消与结果展示。
---

Remote Agent 节点通过 A2A 调用外部 Agent。Workrun 在本地调度 workflow，远程服务负责执行自己的任务。workflow 失败时，远程任务可能仍在运行，也可能已经完成。

workflow 失败或用户停止后，Workrun 对已知 taskId、且本地状态尚未结束的远程任务自动发起一次尽力取消，**不需要运行时人工确认**。请求与返回状态显示在对应节点的 message 中，原 workflow 的失败原因仍然保留。

## 配置 Remote Agent

1. 添加 **Remote Agent** 节点，填写 A2A 服务 URL。服务需要提供 Agent Card 和兼容的 A2A 1.0 JSON-RPC 接口；普通聊天 API 地址不能直接使用。
2. 配置节点获准读取的 State 输入，把服务需要的业务指令放入输入。如需发送文件，填写附件路径。
3. 按服务要求选择无认证、已保存的 Bearer 凭据，或带请求头名称的 API Key 凭据。凭据与服务来源关联，不要把密钥写进提示词或 workflow 输入。
4. 使用连接测试检查服务发现与认证。连接测试不会提交业务任务。
5. 按需设置请求超时：默认 120 秒，支持 1–600 秒。保存并执行 workflow。

当前实现使用 A2A JSON-RPC 接口；这不表示已经支持协议的所有传输方式与可选能力。

## 正常执行过程

```text
提交消息
 → 收到 taskId 后持久化远程任务身份
 → 接收进度和结果
 → 在本地保存结果
 → 继续后续 workflow 节点
```

恢复同一逻辑操作时，可以复用已经保存的成功结果。请求超时或流中断不代表远程业务失败；有 taskId 时，可以查询原任务，而不是重新提交业务请求。

## 订阅更新与交互支持范围

对于支持流式响应的服务，Workrun 通过流或 `SubscribeToTask` 接收进度，而不定时轮询活动任务。恢复已知任务或提交流断开时，会先读取任务快照，再订阅尚未结束的任务；若任务恰好在订阅建立前结束，会再读取一次快照以获得最终结果。服务需要支持相应订阅能力。对于非流式服务，`SendMessage` 必须等待并返回最终结果；返回未完成任务会报错。

远程任务返回 `INPUT_REQUIRED` 或 `AUTH_REQUIRED` 时，当前实现会把运行标记为中断。这些 A2A 状态尚未接入 Workrun 的待处理动作、授权提示或自动恢复流程，不能按本地 Human Review / Ask Human 节点的方式补充输入后继续。远程任务面板展示已保存的状态、消息和文件结果，不提供手动查询、获取或取消入口。

## workflow 失败或用户停止后

Workrun 停止后续本地调度，根据保存的远程记录识别尚未结束的原调用，包括并行分支中的调用。随后直接发送 `CancelTask`，不先查询远程状态：

| 已保存的本地情况                                      | 自动处理                             |
| ----------------------------------------------------- | ------------------------------------ |
| 有 taskId；已提交、执行中、等待输入或认证，或结果未知 | 发起一次取消，展示返回状态           |
| 已完成、已失败、已取消或已拒绝                        | 跳过取消                             |
| 未收到 taskId                                         | 展示提交结果未知，不取消、不重新提交 |
| 取消请求失败或超时                                    | 展示取消结果未确认，不自动重试       |

发出取消请求不等于已经取消。服务可能返回“仍在执行”，也可能在取消到达前已经完成任务。Workrun 展示本次返回状态，不继续轮询后续状态。某个请求失败不会阻止其他独立调用发起取消。

## 查看节点 message

例如某个并行分支失败，而 Remote Agent 仍在执行：

```text
远程任务：正在请求取消…
远程任务：已取消
```

如果请求失败或超时，则显示“取消结果未确认：请求失败或超时，不会自动重试”。workflow 仍保留原失败状态，远程返回不会把整个 workflow 改成成功。

失败或已停止的 workflow 不提供“继续原任务”；“重新运行”创建新的业务执行。应用退出造成的中断保留原恢复路径。详见 [运行记录、调试与追踪](/zh-cn/quality/runs-and-traces/)。

## 退出与重启

取消消息和远程任务记录保存在本地。如果取消请求完成前退出 Workrun，远程任务可能继续执行。重启后不会续接这次取消、轮询取消结果或再次发送取消请求。

仅退出应用不会触发 `CancelTask`。中断任务仍保留原有恢复路径，与失败或停止后的尽力取消分别处理。当前取消处理也不会在启动时扫描历史失败任务。

## 文件附件与输出

在 Remote Agent 的附件路径配置中选择可读取的 State 文件字段，例如 `document`。Workrun 解析这些 artifact 引用并把文件内容作为 A2A 内联文件 part 发送；本地引用 ID 不会作为文件访问凭据传给远端。当前一次请求最多附带 10 个文件，原始文件总大小不超过 20 MiB，编码后的请求仍须满足传输大小限制。

远端文件输出应返回带文件名和 MIME 类型的内联 `raw`（base64）内容，Workrun 会将其保存为本地 artifacts 并让后续节点使用引用。当前不支持 URL 文件输出，也不会自动下载远端提供的文件链接。文件引用、节点权限和本地存储范围见 [文件输入与 artifacts](/zh-cn/concepts/workflows-and-state/#文件输入与-artifacts)。

## A2A 定义与 Workrun 策略的区别

A2A 提供任务查询和取消：`GetTask` 获取状态与输出 artifacts；`CancelTask` 尝试取消，可能返回 `TaskNotCancelableError` 或 `TaskNotFoundError`。参见官方 [Get Task](https://a2a-protocol.org/v1.0.1/specification/#313-get-task) 与 [Cancel Task](https://a2a-protocol.org/v1.0.1/specification/#315-cancel-task) 定义。

协议规定取消是幂等的，但消息提交只可能具备幂等性。Workrun 当前“只尝试一次取消”是本地实现策略，并非 A2A 禁止重复取消。参见 [A2A 幂等语义](https://a2a-protocol.org/v1.0.1/specification/#331-idempotency)。

A2A 没有标准的“父 workflow 失败通知”或业务补偿操作。取消运行中的任务不承诺撤销已完成的发布、删除已经创建的资源。Workrun 不会自动为已完成的 Remote Agent 任务生成撤销指令。本地 Process App 和 Tool App 可以提供自己的清理入口，详见 [App 失败补偿](/zh-cn/guides/app-compensation/)。
