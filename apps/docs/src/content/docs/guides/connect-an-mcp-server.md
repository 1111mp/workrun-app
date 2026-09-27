---
title: Connect an MCP server
description: Make a local stdio or remote Streamable HTTP MCP server available to an Agent.
---

MCP servers are how Workrun connects to an existing tool ecosystem. Connect and test a server in the registry first, then let specific Agents select the tools it discovers. Do not automatically expose one connection to every Agent.

## Add a local stdio server

1. Open **MCP Servers** from the account menu.
2. Select **Add server**.
3. Enter a recognizable name and description, such as `GitHub MCP` / `Search and manage GitHub repositories`.
4. Choose **Local process (stdio)** as the connection type.
5. Enter the startup command; add one argument per line and each required environment variable as `KEY=value` on its own line.
6. Keep **Enable this server** on and select **Test connection**.
7. Confirm the number and names of discovered tools, then save and start it.

Environment variable values are encrypted with the server configuration. Do not put keys in command arguments, workflow inputs, or screenshots.

## Add a remote HTTP server

Choose **Remote endpoint (HTTP)** and enter the public URL for a Streamable HTTP endpoint. Authentication can be none, Bearer token, or OAuth. OAuth completes authorization in a browser after saving; return to Workrun and test the connection again when it succeeds.

## Let an Agent use its tools

1. Confirm that the server is **Online**.
2. Select the target Agent and open **Tools**.
3. In **Available tools**, select the specific tools discovered by that server.
4. Set a call limit and timeout for each tool call.
5. Run a minimal input and inspect tool parameters, return values, and approval records in the run panel.

> **Media placeholder · screenshot `mcp/01-connect-stdio.png`**  
> Show the MCP connection dialog with a name, stdio command, line-separated arguments, and environment variables. Do not expose a real key.

> **Media placeholder · screenshot `mcp/02-agent-tool-selection.png`**  
> Show the Agent inspector’s Tools section with one MCP tool selected and its call limit and timeout.

## Troubleshooting

- **Connection test fails:** first verify in a local terminal that the command starts; then check line breaks, working directory, and environment variable names.
- **The server is online but has no tools:** a successful connection does not mean the server declared tools. Inspect the discovered tool list and server logs.
- **The Agent cannot see a tool:** the server must be running, and the tool must be explicitly selected in that Agent’s tool list.
- **Remote authorization loops:** test again after reauthorizing; make sure the callback browser and Workrun are using the same local configuration.
