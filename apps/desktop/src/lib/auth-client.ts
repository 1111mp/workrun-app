import { tauriFetchImpl } from '@daveyplate/better-auth-tauri';
import { createAuthClient } from 'better-auth/react';

const teamAuthClients = new Map<string, ReturnType<typeof createAuthClient>>();

function createTeamAuthClient(serverUrl: string) {
  const cachedClient = teamAuthClients.get(serverUrl);
  if (cachedClient) return cachedClient;

  const authClient = createAuthClient({
    basePath: '/api/v1/auth',
    baseURL: serverUrl,
    fetchOptions: {
      customFetchImpl: tauriFetchImpl,
    },
  });

  teamAuthClients.set(serverUrl, authClient);
  return authClient;
}

export { createTeamAuthClient };
