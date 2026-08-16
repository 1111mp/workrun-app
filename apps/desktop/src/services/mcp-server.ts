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

export function listMcpServers() {
  return invoke<McpServer[]>('mcp_server_list');
}

export function createMcpServer(request: CreateMcpServerRequest) {
  return invoke<McpServer>('mcp_server_create', { request });
}

export function updateMcpServer(definition: UpdateMcpServerRequest) {
  return invoke<McpServer>('mcp_server_update', { definition });
}

export function deleteMcpServer(id: string) {
  return invoke('mcp_server_delete', { id });
}

export function testMcpServerConnection(
  request: TestMcpServerConnectionRequest,
) {
  return invoke<McpServerConnectionTest>('mcp_server_test_connection', {
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
    invoke<McpServer>('mcp_server_start', { id }),
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
  return invoke<McpServer>('mcp_server_stop', { id });
}

export function reconnectMcpServer(id: string) {
  return invoke<McpServer>('mcp_server_reconnect', { id });
}

export function authorizeMcpServer(id: string) {
  return invoke('mcp_server_authorize', { id });
}
