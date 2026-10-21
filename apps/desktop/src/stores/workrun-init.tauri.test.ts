import { expect, it, vi } from 'vitest';

import { getStartupData } from '@/services/init';
import { mockTauriCommands } from '@/test/tauri';

it('hydrates from the shared startup read and fetches fresh settings on explicit rehydration', async () => {
  let config: IWorkrunConfig = {
    theme: 'system',
    locale: 'en',
    workspace_mode: 'personal',
  };
  const calls = mockTauriCommands({
    get_workrun_config: () => config,
    'plugin:window|theme': () => 'dark',
  });
  await getStartupData();
  const { useWorkrunStore } = await import('./workrun.store');
  await vi.waitFor(() =>
    expect(useWorkrunStore.getState().config).toEqual(config),
  );
  expect(useWorkrunStore.getState().resolvedTheme).toBe('dark');
  expect(
    calls.mock.calls.filter(([command]) => command === 'get_workrun_config'),
  ).toHaveLength(1);
  config = { ...config, theme: 'light' };
  await useWorkrunStore.persist.rehydrate();
  expect(useWorkrunStore.getState().config).toEqual(config);
  expect(useWorkrunStore.getState().resolvedTheme).toBe('light');
  expect(
    calls.mock.calls.filter(([command]) => command === 'get_workrun_config'),
  ).toHaveLength(2);
});
