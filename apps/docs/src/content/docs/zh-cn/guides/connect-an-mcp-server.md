---
title: 连接 MCP Server
description: 连接本地 stdio 或远程 Streamable HTTP MCP Server，完成验证，并仅向 Agent 授予所需工具。
---

MCP 让 Workrun 使用你现有环境或托管服务中的工具。连接只会将 Server 添加到 **MCP 服务器**注册表，并不会把它发现的所有工具自动提供给每个 Agent。应先测试并启动 Server，再为 Agent 逐一选择所需工具。

> MCP 工具可以在其 Server 所拥有的权限范围内读取数据或执行有副作用的操作。只连接可信的 Server，使用最小权限凭据；对于发送、写入、删除等操作，务必要求人工审批。

## 选择连接类型

| 选择 | Server 运行位置 | 需要提供的内容 |
| --- | --- | --- |
| **本地进程（stdio）** | 当前电脑 | 命令、每行一个参数，以及所需环境变量 |
| **远程端点（HTTP）** | 托管服务 | 公开的 Streamable HTTP URL，以及所需认证信息 |

如果 MCP Server 是由 Workrun 在这台电脑上启动的命令行程序，请选 **本地进程**。只有服务商明确提供 Streamable HTTP MCP 端点时才选择 **远程端点**；普通 REST API 地址或旧版 SSE 端点无法连接。

## 连接本地 stdio Server

添加前，先在终端中手动运行一次启动命令。这样可确认运行环境已安装，并弄清所需参数和环境变量。不要把 shell 管道、重定向或整条命令行粘贴进 **命令**：Workrun 会直接执行该命令。

1. 从账户菜单打开 **MCP 服务器**，点击 **添加服务器**。
2. 填写易于识别的名称和说明，例如 `GitHub MCP` 与 `搜索和管理 GitHub 仓库`。
3. 在 **连接类型** 中选择 **本地进程（stdio）**。
4. 在 **命令** 中填写可执行文件；在 **参数**中每行填写一个参数。例如终端命令 `npx -y @example/mcp-server` 应拆为：

   | 字段 | 内容 |
   | --- | --- |
   | 命令 | `npx` |
   | 参数 | `-y`<br />`@example/mcp-server` |

5. 每行填一个 `KEY=value` 格式的环境变量。变量值会随该 Server 配置加密保存。不要将密钥放在参数、工作流输入、Agent 指令或截图中。
6. 保持 **启用此服务器** 打开，点击 **测试连接**。确认测试成功，并且发现的工具名称符合预期。
7. 点击 **保存服务器**。回到注册表后点击 **启动**，等待状态变为 **在线**。

<video controls preload="metadata" playsinline aria-label="连接本地 stdio MCP Server">
  <source src="/media/mcp/01-connect-stdio.mp4" type="video/mp4" />
  您的浏览器不支持 MP4 视频。请从文档媒体目录下载视频。
</video>

## 连接远程 HTTP Server

1. 添加 Server，填写名称，然后选择 **远程端点（HTTP）**。
2. 填入服务商提供的公开 Streamable HTTP 端点 URL。URL 必须以 `https://` 或 `http://` 开头；服务支持时应优先使用 HTTPS。
3. 选择服务商说明的认证方式：

   | 方式 | 适用场景 | 下一步 |
   | --- | --- | --- |
   | **无认证** | 端点有意公开 | 测试连接。 |
   | **Bearer 令牌** | 服务商提供静态访问令牌 | 粘贴令牌后测试连接。令牌会被加密保存。 |
   | **OAuth** | 服务商要求在浏览器授权 | 先保存 Server，再在注册表中点击 **授权** 并在浏览器完成流程。 |

4. 无认证或 Bearer 令牌可在保存前点击 **测试连接**。OAuth 则应先保存、完成授权，再点击 **重新连接** 或 **启动**。
5. 确认 Server 状态为 **在线**，且发现的工具数量合理。在线但发现 `0` 个工具的 Server 虽已连接，却无法为 Agent 提供工具。

<video controls preload="metadata" playsinline aria-label="连接远程 Streamable HTTP MCP Server">
  <source src="/media/mcp/02-connect-streamable-http.mp4" type="video/mp4" />
  您的浏览器不支持 MP4 视频。请从文档媒体目录下载视频。
</video>

## 仅向 Agent 授予合适的工具

1. 打开工作流并选中目标 Agent。
2. 在 **工具** 中选择该运行中 MCP Server 发现的具体工具。仅连接 Server 不会将工具加入 Agent。
3. 设置 **调用上限** 和 **工具超时**。查询或有副作用的操作可从 `1` 次调用开始；只有任务确实需要重复调用时再提高。
4. 对发送、写入、删除、支付或其他重要操作开启人工确认。工具自身的描述不能代替人工复核。
5. 在 Agent 指令中说明何时使用工具及其边界。然后用最小输入运行一次，在运行面板检查工具参数、结果和审批事件。

例如：

```text
当用户询问问题状态时，使用 issue ID 调用 get_issue。
该工具只能用于读取信息；不要创建、编辑、关闭问题或添加评论。
```

## 验证完整配置

只有以下四项都通过，连接才算真正可用：

1. **测试连接**列出了预期工具；
2. 已保存的 Server 在注册表中显示为 **在线**；
3. 目标工具已在目标 Agent 上被选中；
4. 一次小范围工作流运行展示了有效参数，以及符合预期的结果或审批记录。

对于敏感工具，请先用只读操作或非生产目标测试。连接测试仅验证传输是否可用，不能证明 Agent 一定会选择正确的工具或生成正确参数。

## 排查

| 现象 | 优先检查 |
| --- | --- |
| **本地 Server 测试连接失败** | 在终端手动运行可执行文件；再检查可执行文件是否在 `PATH` 中、每个参数是否独占一行、工作目录假设是否成立，以及环境变量名是否准确。 |
| **远程 Server 测试连接失败** | 确认 URL 是服务商提供的 Streamable HTTP MCP 端点，而不是网站或 REST API URL；检查网络、TLS 和认证方式。 |
| **Server 在线但没有工具** | Server 已连接，但没有声明工具。检查其配置和日志；仅提供 resources 或 prompts 的 MCP Server 没有可供 Agent 选择的工具。 |
| **Agent 看不到工具** | 启动或重新连接 Server，然后在 Agent 的 **工具** 中显式选中它；同时确认工作流已经保存。 |
| **OAuth 反复要求授权** | 必须先保存 Server 再授权；在同一 Workrun 配置中完成浏览器流程后重新连接。若服务商已撤销或授权已过期，请重新授权。 |
| **Agent 调用过多或超时** | 降低调用上限，让 Agent 指令更具体，并确认 Server 的正常响应时间。不要无限调大超时来掩盖慢 Server。 |

若需要自己构建并控制本地工具，请参阅[使用 Python Apps](/zh-cn/guides/python-apps/)。有关工具契约、审批和运行时行为，请参阅[Apps、工具与 MCP](/zh-cn/concepts/apps-tools-and-mcp/)。
