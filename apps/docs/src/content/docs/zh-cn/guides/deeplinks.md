---
title: 通过 Deeplink 打开与运行
description: 为已保存的 App 和 Workflow 生成外部调用链接，传入 Workflow 输入并查看运行结果。
---

通过 `workrun://v1` 链接，可以从浏览器、快捷指令或其他应用打开和运行已保存的 App 或 Workflow。每次发起新运行都需要在 Workrun 中确认。如需按指定时间无人值守执行，请使用[定时运行](/zh-cn/guides/scheduled-runs/)。

## 复制链接

1. 在目标工作区保存 App 或 Workflow。通过链接运行前，先安装 App，或准备好 Workflow 所需的 App 依赖。
2. 在 App 详情页点击 **外部调用**；对于 Workflow，在操作菜单中选择 **外部调用**。
3. 对于 Workflow，可在统一 JSON 编辑器中填写输入对象。键名和类型需要符合已保存的 Workflow 输入配置。
4. 复制 **打开链接** 或 **运行链接**，放入浏览器、快捷指令或其他应用中使用。

输入对象仅用于生成当前运行链接，不会保存到 Workflow。重新打开弹窗会重置输入；复制运行链接后可重复使用相同参数，无需再次配置。

链接定位当前工作区中的目标，不会导出、导入或安装 App 与 Workflow。请使用已安装的桌面构建验证系统协议注册，尤其是 macOS；仅启动开发服务器不足以验证系统级唤起。

### Workflow 外部调用弹窗

![Workflow 外部调用弹窗：JSON 输入编辑器、参数不持久化提示，以及打开链接和运行链接的复制按钮。](/media/deeplinks/01-workflow-external-invocation.png)

### App 外部调用弹窗

![App 外部调用弹窗：打开链接和运行链接的复制按钮，无 JSON 输入区域。](/media/deeplinks/02-app-external-invocation.png)

## 打开链接后会发生什么

| 链接          | 行为                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| 打开 App      | 进入 App 详情页，不执行。                                                                              |
| 运行 App      | 进入 App 列表页，显示包含 App 名称和版本的确认弹窗；确认后在列表页打开执行输出抽屉。                   |
| 打开 Workflow | 进入 Workflow 详情页，不执行。                                                                         |
| 运行 Workflow | 进入 Workflow 列表页，显示包含 Workflow 名称和输入表单的确认弹窗；确认后进入详情页并打开执行输出抽屉。 |

取消确认后停留在对应列表页。执行结束后，App 保持在列表页，Workflow 保持在详情页，并保留输出。Workflow 使用现有运行交互，包括已支持的审批与继续操作。

Workrun 会等待启动以及必要的登录流程完成后处理请求。桌面进程仍在运行时，待确认链接可以在 WebView 刷新后恢复；退出桌面进程会丢弃待确认请求。如果待处理期间切换了工作区，请关闭请求，并在目标工作区重新打开链接。

## 链接格式

```text
workrun://v1/apps/{appId}
workrun://v1/apps/{appId}/run
workrun://v1/workflows/{workflowId}
workrun://v1/workflows/{workflowId}/run
```

ID 是已保存目标的 ID，不是显示名称。建议直接复制生成的链接，无需手动拼接 ID。

只有运行链接接受 `requestId`；只有 Workflow 运行链接接受 `input`，其值必须是经过 URL 编码的 JSON 对象。假设 Workflow 有一个名为 `message` 的文本输入：

```text
workrun://v1/workflows/{workflowId}/run?input=%7B%22message%22%3A%22hello%22%7D&requestId=example-1
```

在 JavaScript 中可以这样构造查询参数：

```js
const url = new URL(`workrun://v1/workflows/${workflowId}/run`);
url.searchParams.set('input', JSON.stringify({ message: 'hello' }));
url.searchParams.set('requestId', 'example-1');
const link = url.toString();
```

`message` 只是示例，请使用实际保存的输入配置。未知键名或不匹配的值类型会被拒绝；缺失的必填项可以在确认表单中补充。Chat 模式 Workflow 使用 `input` 文本键。文件输入需要引用当前工作区中可访问的已有 artifact，传入本地路径或 URL 不等于上传文件。详见[文件输入与产物](/zh-cn/concepts/workflows-and-state/#文件输入与-artifacts)。

## 避免重复执行

`requestId` 是可选参数，作用范围为当前工作区。链接生成弹窗不会自动添加它；需要去重的调用方可以在构造链接时添加。

- 同一 `requestId`、目标和原始链接输入再次调用时，会打开已有运行，不创建新运行。只要原运行记录仍然存在，重启 Workrun 后也能去重。
- 同一 `requestId` 对应不同目标或原始输入时会报冲突。新的业务执行应使用新的值。
- 不带 `requestId` 时，每次新调用都可能创建新运行。重复投递的待处理请求可能被合并，不要用连续点击次数作为执行计数。

去重比较的是原始链接请求，不是随后在确认表单中修改的输入。重新打开已完成的运行不会再次执行。

## 查看结果与排查问题

Deeplink 触发的运行在历史中标记为 **外部链接**。在输出抽屉查看 App 的 stdout/stderr 或 Workflow 事件，也可以从历史重新查看已保存的结果。详见[运行、调试与追踪](/zh-cn/quality/runs-and-traces/)。

| 问题                       | 检查方法                                                          |
| -------------------------- | ----------------------------------------------------------------- |
| 系统没有打开 Workrun       | 安装桌面构建，检查协议注册，以及浏览器是否提示允许打开外部应用。  |
| 找不到目标                 | 确认当前工作区和目标是否仍然存在；链接不会选择或切换工作区。      |
| App 或 Workflow 依赖不可用 | 先在 Workrun 中安装 App 或准备依赖，再重新打开链接。              |
| 输入无效                   | 使用符合已保存输入配置的 JSON 对象，通过 `URLSearchParams` 编码。 |
| 请求 ID 冲突               | 完整复用原请求，或为新的执行使用新的 `requestId`。                |

链接上限为 32,768 字节。未知或重复查询参数、不支持的版本和 URL fragment 会被拒绝。当前不支持 App 输入参数、跳过确认自动执行或结果回调。请勿把密钥或文件内容放入链接，URL 可能保存在浏览器历史或快捷指令配置中。
