import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';

import { changeScheduledTask } from '@/services/schedules';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: vi.fn() }));
vi.mock('@/stores', () => ({
  useWorkrunStore: {
    getState: () => ({ config: { workspace_mode: 'personal' } }),
  },
}));
vi.mock('@/lib/auth-client', () => ({ createTeamAuthClient: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it.each(['pause', 'resume'] as const)(
  'uses only task interfaces to %s and reload its detail',
  async (operation) => {
    const task = { id: 'task-1', enabled: operation === 'resume' };
    vi.mocked(invoke)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(task);
    expect(await changeScheduledTask({ operation, id: task.id })).toEqual(task);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['schedule_set_enabled', { id: task.id, enabled: task.enabled }],
      ['schedule_detail', { id: task.id }],
    ]);
  },
);

it('deletes through the task interface without creating a session or requesting a response', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  expect(
    await changeScheduledTask({ operation: 'delete', id: 'task-1' }),
  ).toBeNull();
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['schedule_delete', { id: 'task-1' }],
  ]);
});

it('saves form edits through the versioned task update interface', async () => {
  const change = {
    operation: 'update' as const,
    id: 'task-1',
    version: 'v1',
    name: 'Renamed',
  };
  vi.mocked(invoke).mockResolvedValue({ id: change.id, name: change.name });
  await changeScheduledTask(change);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['schedule_update', { change, teamToken: undefined }],
  ]);
});
