import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => {
  vi.resetModules();
  vi.mocked(invoke).mockReset();
});

it('shares concurrent verification and issues logout even while login is pending', async () => {
  const { syncTeamModelSession, teamModelSessionVersion } =
    await import('./team-model-session');
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const a = syncTeamModelSession('https://team.example', 'session-a');
  const initial = teamModelSessionVersion();
  const b = syncTeamModelSession('https://team.example', 'session-a');
  expect(a).toBe(b);
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockResolvedValueOnce(undefined);
  await syncTeamModelSession('https://team.example', null);
  expect(teamModelSessionVersion()).toBeGreaterThan(initial);
  expect(invoke).toHaveBeenLastCalledWith('schedule_set_team_session', {
    serverUrl: 'https://team.example',
    token: null,
  });
  finish();
  await a;
});

it('ignores cleanup belonging to a Server that has already been replaced', async () => {
  const { syncTeamModelSession, clearTeamModelSession } =
    await import('./team-model-session');
  vi.mocked(invoke).mockResolvedValue(undefined);
  await syncTeamModelSession('https://b.example', 'b');
  await clearTeamModelSession('https://a.example');
  expect(invoke).toHaveBeenCalledTimes(1);
  await clearTeamModelSession('https://b.example');
  expect(invoke).toHaveBeenLastCalledWith('schedule_set_team_session', {
    serverUrl: 'https://b.example',
    token: null,
  });
});
