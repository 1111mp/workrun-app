---
title: Connect an MCP server
description: Connect a local stdio or remote Streamable HTTP MCP server, verify it, and give an Agent only the tools it needs.
---

MCP lets Workrun use tools that already exist in your environment or on a hosted service. A connection adds a server to the **MCP servers** registry; it does **not** give every Agent access to every discovered tool. Test and start the server first, then select only the tools an Agent needs.

> MCP tools can read data or perform side effects with the permissions of their server. Connect only servers you trust, use narrowly scoped credentials, and require approval for actions such as sending, writing, or deleting.

## Choose a connection type

| Choose this                | When the server runs | What you provide                                                |
| -------------------------- | -------------------- | --------------------------------------------------------------- |
| **Local process (stdio)**  | On this computer     | A command, one argument per line, and any environment variables |
| **Remote endpoint (HTTP)** | On a hosted service  | A public Streamable HTTP URL and, if required, authentication   |

Use **Local process** for a command-line MCP server that Workrun should start on this device. Use **Remote endpoint** only when the provider documents a Streamable HTTP MCP endpoint; a regular REST API URL or an older SSE endpoint will not connect.

## Connect a local stdio server

Before adding the server, run its command in a terminal once. This confirms the runtime is installed and makes its required arguments and environment variables clear. Do not paste a shell pipeline, redirection, or a whole command line into **Command**: Workrun runs the command directly.

1. Open **MCP servers** from the account menu and select **Add server**.
2. Give the connection a recognizable name and description, for example `GitHub MCP` and `Search and manage GitHub repositories`.
3. Under **Connection type**, choose **Local process (stdio)**.
4. Enter the executable in **Command**. Put each command argument on its own line in **Arguments**. For example, a command that you would run as `npx -y @example/mcp-server` becomes:

   | Field     | Value                           |
   | --------- | ------------------------------- |
   | Command   | `npx`                           |
   | Arguments | `-y`<br />`@example/mcp-server` |

5. Add each required environment variable on its own line as `KEY=value`. Values are encrypted with this server configuration. Keep secrets out of arguments, workflow inputs, Agent instructions, and screenshots.
6. Leave **Enable this server** on and select **Test connection**. Confirm both that it succeeds and that the discovered tool names are the ones you expect.
7. Select **Save server**. Back in the registry, select **Start** and wait for the status to become **Online**.

<video controls preload="metadata" playsinline aria-label="Connect a local stdio MCP server">
  <source src="/media/mcp/01-connect-stdio.mp4" type="video/mp4" />
  Your browser does not support MP4 video. Download the video from the documentation media directory.
</video>

## Connect a remote HTTP server

1. Add a server, name it, and choose **Remote endpoint (HTTP)**.
2. Enter the provider's public Streamable HTTP endpoint URL. It must begin with `https://` or `http://`; prefer HTTPS whenever the service supports it.
3. Select the authentication method documented by the provider:

   | Method                | Use it when                                 | Next step                                                                                   |
   | --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
   | **No authentication** | The endpoint is intentionally public        | Test the connection.                                                                        |
   | **Bearer token**      | The provider issued a static access token   | Paste the token, then test the connection. It is stored encrypted.                          |
   | **OAuth**             | The provider requires browser authorization | Save the server first, then select **Authorize** in the registry and finish in the browser. |

4. For no authentication or Bearer token, select **Test connection** before saving. For OAuth, save first, complete authorization, then select **Reconnect** or **Start**.
5. Confirm the server is **Online** and the discovered tool count is plausible. An online server with zero tools is connected, but cannot help an Agent.

<video controls preload="metadata" playsinline aria-label="Connect a remote Streamable HTTP MCP server">
  <source src="/media/mcp/02-connect-streamable-http.mp4" type="video/mp4" />
  Your browser does not support MP4 video. Download the video from the documentation media directory.
</video>

## Give an Agent the right tools

1. Open the workflow and select the target Agent.
2. Under **Tools**, choose the specific tools discovered from the running MCP server. Connecting a server alone does not add its tools to an Agent.
3. Set a **Call limit** and **Tool timeout**. Start with a small call limit such as `1` for a lookup or a side-effecting action; increase it only when the task genuinely needs repeated calls.
4. Enable human confirmation for sends, writes, deletes, payments, or other consequential actions. A tool's own description is not a substitute for a review step.
5. Give the Agent an instruction that says when to use the tool and its boundary. Then run a minimal test input and inspect the tool arguments, result, and any approval event in the run panel.

For example:

```text
When the user asks for the status of an issue, use get_issue with the issue ID.
Use it only to retrieve information. Do not create, edit, close, or comment on an issue.
```

## Verify the complete setup

The connection is ready only when all four checks pass:

1. **Test connection** lists the expected tools.
2. The saved server is **Online** in the registry.
3. The intended tool is selected on the intended Agent.
4. A small workflow run shows valid arguments and the expected result or approval record.

If a tool is sensitive, test first with a read-only operation or a non-production target. Treat connection testing as a transport check, not proof that an Agent will select the correct tool or arguments.

## Connection state and session recovery

The server registry updates connection state through native events. For HTTP servers, Online reflects the last observed session state; it is not a continuous remote reachability probe. If a session closes, use **Reconnect** to restore it. Workrun can also recreate a closed HTTP session on demand when the server is needed again, without a background reconnect loop.

Stopping an HTTP server connection closes its local session; stopping a local stdio server terminates its process. Failed OAuth initialization clears the pending authorization state so you can correct the configuration and authorize again.

## Troubleshooting

| Symptom                                           | Check first                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Test connection fails for a local server**      | Run the executable manually. Then verify the executable is on `PATH`, each argument occupies its own line, the working-directory assumptions are valid, and environment variable names are exact. |
| **Test connection fails for a remote server**     | Confirm the URL is the provider's Streamable HTTP MCP endpoint, not a website or REST API URL. Check network access, TLS, and the selected authentication method.                                 |
| **The server is online but has no tools**         | The server connected but did not advertise tools. Inspect its configuration and logs; a resource-only or prompt-only MCP server has no Agent tools to select.                                     |
| **The Agent cannot see a tool**                   | Start or reconnect the server, then explicitly select that tool in the Agent's **Tools**. Also check that the workflow is saved.                                                                  |
| **OAuth keeps requesting authorization**          | Save the server before authorizing. Complete the browser flow, return to the same Workrun profile, then reconnect the server. Reauthorize if the provider revoked or expired the grant.           |
| **The Agent calls a tool too often or times out** | Lower the call limit, make the Agent instruction more specific, and verify the server's expected response time. Do not solve a slow server by indefinitely increasing the timeout.                |

For local tools you can build and control yourself, see [Use Python Apps](/guides/python-apps/). For tool contracts, confirmations, and runtime behavior, see [Apps, tools, and MCP](/concepts/apps-tools-and-mcp/).
