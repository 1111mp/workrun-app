import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from '@tanstack/react-query';
import {
  act,
  render as renderComponent,
  type RenderResult,
} from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { RunEventTracker } from './run-event-tracker';

const subscriptions = vi.hoisted(
  () =>
    new Map<
      string,
      {
        callback: (event: {
          payload: {
            runId: string;
            event?: {
              type: string;
            };
          };
        }) => void;
        resolve: (stop: () => void) => void;
      }
    >(),
);
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    (
      name: string,
      callback: (event: {
        payload: {
          runId: string;
          event?: {
            type: string;
          };
        };
      }) => void,
    ) =>
      new Promise<() => void>((resolve) =>
        subscriptions.set(name, { callback, resolve }),
      ),
  ),
}));

it('refreshes after subscribing, handles pushed updates, and releases late listeners', async () => {
  subscriptions.clear();
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const stops = Array.from({ length: 5 }, () => vi.fn());
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <RunEventTracker />
      </QueryClientProvider>,
      { container: host },
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
      .get('run-event')!
      .callback({ payload: { runId: 'run', event: { type: 'interrupted' } } });
    expect(invalidate).toHaveBeenCalledTimes(4);
    subscriptions
      .get('run-status-changed')!
      .callback({ payload: { runId: 'run' } });
    expect(invalidate).toHaveBeenCalledTimes(6);
    rendered.unmount();
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

it('refreshes an active MCP list from pushed lifecycle events without polling', async () => {
  subscriptions.clear();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let status = 'Running';
  const fetchServers = vi.fn(async () => [{ status }]);
  const observer = new QueryObserver(client, {
    queryKey: ['mcp-servers'],
    queryFn: fetchServers,
  });
  const unsubscribe = observer.subscribe(() => {});
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  const stop = vi.fn();
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <RunEventTracker />
      </QueryClientProvider>,
      { container: host },
    );
    await act(async () =>
      subscriptions.get('mcp-servers-changed')!.resolve(stop),
    );
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual([{ status: 'Running' }]),
    );
    for (const next of ['Restarting', 'Running', 'FailedToStart', 'Stopped']) {
      status = next;
      await act(async () =>
        subscriptions
          .get('mcp-servers-changed')!
          .callback({ payload: { runId: '' } }),
      );
      await vi.waitFor(() =>
        expect(observer.getCurrentResult().data).toEqual([{ status: next }]),
      );
    }
    const requests = fetchServers.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetchServers).toHaveBeenCalledTimes(requests);
  } finally {
    rendered.unmount();
    for (const subscription of subscriptions.values())
      subscription.resolve(() => {});
    unsubscribe();
    client.clear();
    host.remove();
  }
  expect(stop).toHaveBeenCalledOnce();
});

it('reconciles runs and pending actions changed before native listeners were ready', async () => {
  subscriptions.clear();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const activeKey = ['run-history', 'active', 'personal'];
  const actionsKey = ['run-history', 'pending-actions', 'personal'];
  client.setQueryData(activeKey, [{ id: 'app-run', status: 'running' }]);
  client.setQueryData(actionsKey, []);
  const active = new QueryObserver(client, {
    queryKey: activeKey,
    queryFn: async () => [],
  });
  const actions = new QueryObserver(client, {
    queryKey: actionsKey,
    queryFn: async () => [{ id: 'question', runId: 'workflow-run' }],
  });
  const unsubscribeActive = active.subscribe(() => {});
  const unsubscribeActions = actions.subscribe(() => {});
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <RunEventTracker />
      </QueryClientProvider>,
      { container: host },
    );
    // Completion and a new question occurred before either listener was ready;
    // no pushed event will replay them. Subscription must reconcile the snapshot.
    await act(async () => {
      subscriptions.get('run-status-changed')!.resolve(() => {});
      subscriptions.get('pending-action-created')!.resolve(() => {});
    });
    await vi.waitFor(() => {
      expect(active.getCurrentResult().data).toEqual([]);
      expect(actions.getCurrentResult().data).toEqual([
        { id: 'question', runId: 'workflow-run' },
      ]);
    });
  } finally {
    rendered.unmount();
    for (const subscription of subscriptions.values())
      subscription.resolve(() => {});
    unsubscribeActive();
    unsubscribeActions();
    client.clear();
    host.remove();
  }
});

it('removes a completed App after a status event while retaining its older interrupted invocation', async () => {
  subscriptions.clear();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const oldRun = { id: 'old-app-run', targetId: 'app', status: 'interrupted' };
  let runs = [
    oldRun,
    { id: 'new-app-run', targetId: 'app', status: 'running' },
  ];
  const observer = new QueryObserver(client, {
    queryKey: ['run-history', 'active', 'personal'],
    queryFn: async () => runs,
  });
  const unsubscribe = observer.subscribe(() => {});
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <RunEventTracker />
      </QueryClientProvider>,
      { container: host },
    );
    await act(async () =>
      subscriptions.get('run-status-changed')!.resolve(() => {}),
    );
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toHaveLength(2),
    );
    // app_done is emitted before the terminal transaction: an early output
    // refresh can still see running. The later status event must reconcile it.
    await act(async () =>
      subscriptions.get('run-event')!.callback({
        payload: { runId: 'new-app-run', event: { type: 'app_done' } },
      }),
    );
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().isFetching).toBe(false),
    );
    runs = [oldRun];
    await act(async () =>
      subscriptions.get('run-status-changed')!.callback({
        payload: { runId: 'new-app-run' },
      }),
    );
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual([oldRun]),
    );
  } finally {
    rendered.unmount();
    for (const subscription of subscriptions.values())
      subscription.resolve(() => {});
    unsubscribe();
    client.clear();
    host.remove();
  }
});
