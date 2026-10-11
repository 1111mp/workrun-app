import { invoke } from '@tauri-apps/api/core';

export type RemoteAuthentication =
  | { type: 'none' }
  | { type: 'bearer'; credentialId: string }
  | { type: 'apiKey'; credentialId: string; headerName: string };

export type RemoteCredential = {
  id: string;
  name: string;
  kind: 'bearer' | 'apiKey';
  origin: string;
};

export function listRemoteCredentials() {
  return invoke<RemoteCredential[]>('remote_credentials_list');
}

// The secret is a write-only input to native encrypted storage. It never belongs
// in the workflow patch or in query-cache metadata.
export function saveRemoteCredential(payload: {
  id?: string;
  name: string;
  kind: 'bearer' | 'apiKey';
  serviceUrl: string;
  secret?: string;
}) {
  return invoke<RemoteCredential>('remote_credential_save', { payload });
}

export function deleteRemoteCredential(id: string) {
  return invoke<void>('remote_credential_delete', { id });
}

export function testRemoteConnection(
  url: string,
  authentication: RemoteAuthentication,
) {
  return invoke<void>('remote_agent_test_connection', { url, authentication });
}

export type RemoteTask = {
  id: string;
  runId: string;
  nodeId: string;
  messageId: string;
  serviceOrigin: string;
  taskId?: string | null;
  status: string;
  lastKnownState?: string | null;
  result?: { response: string; artifacts: unknown[] } | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt?: string | null;
};

export function listRemoteTasks(runId: string) {
  return invoke<RemoteTask[]>('remote_tasks_list', { runId });
}

export function manageRemoteTask(
  id: string,
  operation: 'query' | 'fetch' | 'cancel',
) {
  return invoke<RemoteTask>('remote_task_manage', { id, operation });
}

export function listRemoteTaskWarnings(workflowId: string) {
  return invoke<RemoteTask[]>('remote_task_warnings', { workflowId });
}
