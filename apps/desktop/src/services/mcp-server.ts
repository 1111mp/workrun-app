import { invoke } from '@tauri-apps/api/core';

export type McpServerStatus =
  | 'Running'
  | 'Stopped'
  | 'Crashed'
  | 'Restarting'
  | 'Disabled'
  | 'FailedToStart';

export type McpServerTransport = 'stdio' | 'streamable_http';
export type McpServerAuth = 'none' | 'bearer' | 'oauth';
export type McpServerAuthorizationStatus =
  | 'not_required'
  | 'authorization_required'
  | 'authorizing'
  | 'authorized';

export type McpServerDefinition = {
  id: string;
  name: string;
  description: string;
  transport: McpServerTransport;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  auth: McpServerAuth;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  authorizationStatus: McpServerAuthorizationStatus;
};

export type McpServerHealth = {
  lastCheckedAt?: string;
  lastError?: string;
  toolCount?: number;
};

export type McpServer = {
  definition: McpServerDefinition;
  status: McpServerStatus;
  health: McpServerHealth;
};

export type CreateMcpServerRequest = Pick<
  McpServerDefinition,
  | 'name'
  | 'description'
  | 'command'
  | 'args'
  | 'env'
  | 'enabled'
  | 'transport'
  | 'url'
  | 'auth'
> & {
  bearerToken?: string;
};

export type UpdateMcpServerRequest = McpServerDefinition;

export type McpServerConnectionTest = {
  toolNames: string[];
};

export type TestMcpServerConnectionRequest = Pick<
  CreateMcpServerRequest,
  'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'auth'
> & {
  id?: string;
  bearerToken?: string;
};

export type McpServerWorkflowReference = {
  id: string;
  name: string;
};

export function getMcpServers() {
  return invoke<McpServer[]>('get_mcp_servers');
}

export function createMcpServer(request: CreateMcpServerRequest) {
  return invoke<McpServer>('create_mcp_server', { request });
}

export function updateMcpServer(definition: UpdateMcpServerRequest) {
  return invoke<McpServer>('update_mcp_server', { definition });
}

export function deleteMcpServer(id: string) {
  return invoke('delete_mcp_server', { id });
}

export function testMcpServerConnection(
  request: TestMcpServerConnectionRequest,
) {
  return invoke<McpServerConnectionTest>('test_mcp_server_connection', {
    request,
  });
}

export function listMcpServerWorkflowReferences(id: string) {
  return invoke<McpServerWorkflowReference[]>(
    'mcp_server_workflow_references',
    {
      id,
    },
  );
}

export function startMcpServer(id: string) {
  return Promise.race([
    invoke<McpServer>('start_mcp_server', { id }),
    new Promise<never>((_, reject) => {
      window.setTimeout(
        () =>
          reject(new Error('MCP Server connection timed out after 35 seconds')),
        35_000,
      );
    }),
  ]);
}

export function stopMcpServer(id: string) {
  return invoke<McpServer>('stop_mcp_server', { id });
}

export function reconnectMcpServer(id: string) {
  return invoke<McpServer>('reconnect_mcp_server', { id });
}

export function authorizeMcpServer(id: string) {
  return invoke('authorize_mcp_server', { id });
}
