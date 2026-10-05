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
