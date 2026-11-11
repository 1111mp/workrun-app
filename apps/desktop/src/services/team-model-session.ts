import { invoke } from '@tauri-apps/api/core';

// All callers await the same native verification for a given session. Native code
// verifies the user with Server and rejects stale completions after account changes.
let version = 0;
let context = '';
export const teamModelSessionVersion = () => version;
let pending:
  | { server: string; token: string | null; promise: Promise<void> }
  | undefined;
export function syncTeamModelSession(
  server: string,
  token: string | null,
): Promise<void> {
  const nextContext = JSON.stringify([server, token]);
  if (nextContext !== context) {
    context = nextContext;
    version += 1;
  }
  if (pending?.server === server && pending.token === token)
    return pending.promise;
  const promise = invoke<void>('schedule_set_team_session', {
    serverUrl: server,
    token,
  });
  const entry = { server, token, promise };
  pending = entry;
  void promise
    .finally(() => {
      if (pending === entry) pending = undefined;
    })
    .catch(() => {});
  return promise;
}
