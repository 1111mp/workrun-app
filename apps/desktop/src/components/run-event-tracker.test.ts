// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { RunEventTracker } from './run-event-tracker';

const subscriptions = vi.hoisted(
  () =>
    new Map<
      string,
      {
        callback: (event: { payload: { runId: string } }) => void;
        resolve: (stop: () => void) => void;
      }
    >(),
);
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (name: string, callback: (event: { payload: { runId: string } }) => void) =>
      new Promise<() => void>((resolve) =>
        subscriptions.set(name, { callback, resolve }),
      ),
  ),
}));

it('refreshes after subscribing, handles pushed updates, and releases late listeners', async () => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  subscriptions.clear();
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const host = document.createElement('div');
  const root = createRoot(host);
  const stops = Array.from({ length: 5 }, () => vi.fn());
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RunEventTracker),
        ),
      ),
    );
    expect(subscriptions.size).toBe(5);
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      subscriptions.get('remote-tasks-changed')!.resolve(stops[0]!);
      subscriptions.get('mcp-servers-changed')!.resolve(stops[1]!);
    });
    expect(invalidate.mock.calls.map(([arg]) => arg?.queryKey)).toEqual([
      ['remoteTasks'],
      ['remoteTaskWarnings'],
      ['mcp-servers'],
    ]);
    invalidate.mockClear();
    subscriptions
      .get('remote-tasks-changed')!
      .callback({ payload: { runId: 'run' } });
    expect(invalidate).toHaveBeenCalledTimes(2);
    subscriptions.get('run-event')!.callback({ payload: { runId: 'run' } });
    subscriptions.get('run-event')!.callback({ payload: { runId: 'run' } });
    expect(invalidate).toHaveBeenCalledTimes(3);
    subscriptions
      .get('run-status-changed')!
      .callback({ payload: { runId: 'run' } });
    expect(invalidate).toHaveBeenCalledTimes(5);
    await act(async () => root.unmount());
    invalidate.mockClear();
    await act(async () => {
      subscriptions.get('run-event')!.resolve(stops[2]!);
      subscriptions.get('run-status-changed')!.resolve(stops[3]!);
      subscriptions.get('pending-action-created')!.resolve(stops[4]!);
    });
    expect(invalidate).not.toHaveBeenCalled();
    for (const stop of stops) expect(stop).toHaveBeenCalledOnce();
  } finally {
    client.clear();
    host.remove();
  }
});
