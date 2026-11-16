import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';

import { getModelCatalog, getModelCatalogStatus } from './cmd';
import { syncTeamModelSession } from './team-model-session';

const auth = vi.hoisted(() => ({ getSession: vi.fn(), version: 0 }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({
  createTeamAuthClient: () => ({ getSession: auth.getSession }),
}));
vi.mock('./team-model-session', () => ({
  syncTeamModelSession: vi.fn(async () => {}),
  teamModelSessionVersion: () => auth.version,
}));
beforeEach(() => {
  vi.clearAllMocks();
  auth.version = 0;
});

it('keeps personal model access independent of team authentication', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ workspace_mode: 'personal' })
    .mockResolvedValueOnce([{ id: 'personal-model' }]);
  await expect(getModelCatalog()).resolves.toEqual([{ id: 'personal-model' }]);
  expect(auth.getSession).not.toHaveBeenCalled();
  expect(syncTeamModelSession).not.toHaveBeenCalled();
});
it('verifies the current team session before reading the native model directory', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      workspace_mode: 'team',
      team: { server_url: 'https://team.example' },
    })
    .mockResolvedValueOnce([{ id: 'team-model' }]);
  auth.getSession.mockResolvedValue({
    data: { session: { token: 'current-session' } },
  });
  await expect(getModelCatalog()).resolves.toEqual([{ id: 'team-model' }]);
  expect(syncTeamModelSession).toHaveBeenCalledWith(
    'https://team.example',
    'current-session',
  );
  expect(invoke).toHaveBeenLastCalledWith('model_catalog_list');
});
it('does not restore a stale login or return builtin models after the account changes', async () => {
  vi.mocked(invoke).mockResolvedValueOnce({
    workspace_mode: 'team',
    team: { server_url: 'https://team.example' },
  });
  auth.getSession.mockImplementation(async () => {
    auth.version += 1;
    return { data: { session: { token: 'old-session' } } };
  });
  await expect(getModelCatalog()).rejects.toThrow('authentication changed');
  expect(syncTeamModelSession).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('discards a directory returned after a native authentication transition', async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'get_workrun_config')
      return {
        workspace_mode: 'team',
        team: { server_url: 'https://team.example' },
      };
    auth.version += 1;
    return [{ id: 'stale-directory' }];
  });
  auth.getSession.mockResolvedValue({
    data: { session: { token: 'current-session' } },
  });
  await expect(getModelCatalog()).rejects.toThrow('authentication changed');
});

it('keeps direct models available when team authentication is unavailable', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({
      workspace_mode: 'team',
      team: { server_url: 'https://team.example' },
    })
    .mockResolvedValueOnce([{ id: 'direct-model' }]);
  auth.getSession.mockRejectedValue(new Error('Server unavailable'));
  await expect(getModelCatalog()).resolves.toEqual([{ id: 'direct-model' }]);
  expect(syncTeamModelSession).not.toHaveBeenCalled();
});

it('requests diagnostic status and bypasses native cache for manual refresh', async () => {
  vi.mocked(invoke)
    .mockResolvedValueOnce({ workspace_mode: 'personal' })
    .mockResolvedValueOnce({
      models: [{ id: 'direct-model' }],
      serverError: 'HTTP 503',
    });
  await expect(getModelCatalogStatus(true)).resolves.toEqual({
    models: [{ id: 'direct-model' }],
    serverError: 'HTTP 503',
  });
  expect(invoke).toHaveBeenLastCalledWith('model_catalog_status', {
    refresh: true,
  });
});
