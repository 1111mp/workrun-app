import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';

import { getProcessNodes } from './process-node';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@/lib/constant', () => ({ isTeamMode: vi.fn() }));
vi.mock('@/services/fetch-api', () => ({
  fetchApi: { get: vi.fn() },
}));

const definition = {
  id: 'app-1',
  name: 'Shared App',
  description: '',
  version: '0.1.0',
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  entry: 'main.py',
  kind: 'workflow' as const,
  toolExecutionPolicy: 'ask_every_time' as const,
  inputs: {},
  outputs: {},
};

describe('getProcessNodes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the local catalog in personal mode', async () => {
    vi.mocked(isTeamMode).mockReturnValue(false);
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await expect(getProcessNodes()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('get_process_nodes');
    expect(fetchApi.get).not.toHaveBeenCalled();
  });

  it('uses the server catalog in team mode without a local project path', async () => {
    vi.mocked(isTeamMode).mockReturnValue(true);
    vi.mocked(fetchApi.get).mockResolvedValueOnce({ items: [definition] });

    await expect(getProcessNodes()).resolves.toEqual([
      { definition, installStatus: 'notInstalled', projectPath: '' },
    ]);
    expect(fetchApi.get).toHaveBeenCalledWith('/api/v1/app');
    expect(invoke).not.toHaveBeenCalled();
  });
});
