import { describe, expect, it } from 'vitest';

import { mockTauriCommands } from '@/test/tauri';

import { getAppInitialData, getStartupData } from './init';

describe('application initialization through Tauri IPC', () => {
  it('uses injected startup data once, then reloads current settings', async () => {
    const initial: IWorkrunConfig = { theme: 'dark', locale: 'en' };
    const updated: IWorkrunConfig = { theme: 'system', locale: 'zh-CN' };
    window.__WORKRUN_INITIAL_SETTINGS__ = initial;
    window.__WORKRUN_INITIAL_THEME__ = 'dark';
    sessionStorage.setItem('__WORKRUN_INITIAL__', 'no');
    const calls = mockTauriCommands({
      get_workrun_config: () => updated,
      'plugin:window|theme': () => 'light',
    });

    await expect(getAppInitialData()).resolves.toEqual([initial, 'dark']);
    expect(calls).not.toHaveBeenCalled();
    await expect(getAppInitialData()).resolves.toEqual([updated, 'light']);
    expect(calls).toHaveBeenCalledWith('get_workrun_config', {});
    expect(calls).toHaveBeenCalledWith('plugin:window|theme', {
      label: 'main',
    });
  });

  it('falls back to light when the native window has no theme', async () => {
    const config: IWorkrunConfig = { theme: 'system' };
    mockTauriCommands({
      get_workrun_config: () => config,
      'plugin:window|theme': () => null,
    });
    await expect(getAppInitialData()).resolves.toEqual([config, 'light']);
  });

  it('surfaces backend initialization failures', async () => {
    mockTauriCommands({
      get_workrun_config: () => {
        throw new Error('Configuration unavailable');
      },
      'plugin:window|theme': () => 'light',
    });
    await expect(getAppInitialData()).rejects.toThrow(
      'Configuration unavailable',
    );
  });
});

it('shares one startup read between concurrent consumers and keeps explicit reloads fresh', async () => {
  const config: IWorkrunConfig = { theme: 'system' };
  const calls = mockTauriCommands({
    get_workrun_config: () => config,
    'plugin:window|theme': () => 'dark',
  });
  const first = getStartupData();
  const second = getStartupData();
  expect(first).toBe(second);
  await expect(first).resolves.toEqual([config, 'dark']);
  expect(
    calls.mock.calls.filter(([command]) => command === 'get_workrun_config'),
  ).toHaveLength(1);
  await getAppInitialData();
  expect(
    calls.mock.calls.filter(([command]) => command === 'get_workrun_config'),
  ).toHaveLength(2);
});
