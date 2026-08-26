import { tauriFetchImpl } from '@daveyplate/better-auth-tauri';

interface TeamUser {
  email: string;
  id: string;
  image?: string | null;
  name: string;
}

function normalizeServerUrl(value: string) {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    return url.href.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

async function getTeamUser(serverUrl: string): Promise<TeamUser | null> {
  const response = await tauriFetchImpl(`${serverUrl}/api/v1/users/me`, {
    credentials: 'include',
  });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Unable to fetch current user');

  const body = (await response.json()) as {
    payload?: { user?: TeamUser | null };
  };
  return body.payload?.user ?? null;
}

export { getTeamUser, normalizeServerUrl, type TeamUser };
