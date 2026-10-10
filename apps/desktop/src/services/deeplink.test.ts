import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createDeeplink,
  subscribeDeeplinks,
  validateDeeplinkInput,
} from './deeplink';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

describe('deeplink protocol', () => {
  it('encodes JSON and request IDs without changing their values', () => {
    const input = { message: '中文 & + # ?', count: 2, enabled: false };
    const url = new URL(
      createDeeplink('workflows', 'workflow-1', 'run', input, 'request & 1'),
    );
    expect(url.pathname).toBe('/workflows/workflow-1/run');
    expect(JSON.parse(url.searchParams.get('input')!)).toEqual(input);
    expect(url.searchParams.get('requestId')).toBe('request & 1');
    expect(createDeeplink('apps', 'app-1', 'open')).toBe(
      'workrun://v1/apps/app-1',
    );
  });

  it('rejects unsupported input and oversized links', () => {
    expect(() => createDeeplink('apps', 'app-1', 'run', {})).toThrow();
    expect(() =>
      createDeeplink('workflows', 'workflow-1', 'open', {}),
    ).toThrow();
    expect(() => createDeeplink('apps', '../app', 'run')).toThrow();
    expect(() =>
      createDeeplink('workflows', 'workflow-1', 'run', {
        message: 'x'.repeat(33_000),
      }),
    ).toThrow();
  });

  const settings = {
    mode: 'task',
    inputSchema: {
      fields: [
        { key: 'count', type: 'number', required: true },
        { key: 'enabled', type: 'boolean' },
      ],
    },
  } as WorkflowSettings;

  it('preserves scalar types and permits required values to be filled later', () => {
    expect(() => validateDeeplinkInput(settings, {})).not.toThrow();
    expect(() =>
      validateDeeplinkInput(settings, { count: 0, enabled: false }),
    ).not.toThrow();
    expect(() => validateDeeplinkInput(settings, { count: '2' })).toThrow(
      'count',
    );
    expect(() => validateDeeplinkInput(settings, { enabled: 'false' })).toThrow(
      'enabled',
    );
    expect(() => validateDeeplinkInput(settings, { unknown: 'value' })).toThrow(
      'unknown',
    );
  });
});

describe('deeplink push subscription', () => {
  beforeEach(() => vi.resetAllMocks());

  it('subscribes before synchronization and ignores an older startup snapshot', async () => {
    const stop = vi.fn();
    const onRequest = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(stop);
    let resolveSnapshot!: (value: unknown) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      }),
    );
    const subscription = subscribeDeeplinks(onRequest);
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('deeplink_snapshot'),
    );
    const receive = vi.mocked(listen).mock.calls[0]![1] as (event: {
      payload: unknown;
    }) => void;
    const first = { id: 'first' };
    const next = { id: 'next' };
    receive({ payload: { revision: 2, pending: first } });
    resolveSnapshot({ revision: 1, pending: null });
    const unlisten = await subscription;
    expect(onRequest.mock.calls).toEqual([[first]]);
    receive({ payload: { revision: 3, pending: next } });
    receive({ payload: { revision: 2, pending: first } });
    receive({ payload: { revision: 4, pending: null } });
    expect(onRequest.mock.calls).toEqual([[first], [next], [null]]);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith(
      'deeplink-request',
      expect.any(Function),
    );
    unlisten();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('releases the listener when initial synchronization fails', async () => {
    const stop = vi.fn();
    vi.mocked(listen).mockResolvedValueOnce(stop);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('snapshot failed'));
    await expect(subscribeDeeplinks(vi.fn())).rejects.toThrow(
      'snapshot failed',
    );
    expect(stop).toHaveBeenCalledOnce();
  });
});
