import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  inspectRunRecord,
  type RunRecord,
  type RunRecordSummary,
} from '@/services/run-history';
import { useRunWorkspaceStore } from '@/stores/run-workspace.store';

import { RunEventTracker } from './run-event-tracker';
import { RunWorkspace } from './run-workspace';

const native = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  stop: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, callback: (event: { payload: unknown }) => void) => {
      native.listeners.set(name, callback);
      return native.stop;
    },
  ),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: vi.fn(),
  replayRun: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/app-run-output-panel', () => ({
  AppRunOutputPanel: () => null,
  restoreProcessNodeRun: vi.fn(),
}));
vi.mock('@/components/workflow-output-panel', () => ({
  WorkflowRunOutput: ({ run }: { run: { status: string } }) => (
    <div data-testid='run-output'>{run.status}</div>
  ),
}));
vi.mock('@workspace/ui/components', () => {
  const box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Badge: box,
    Button: box,
    DrawerContent: box,
    DrawerHeader: box,
    DrawerTitle: box,
    ScrollArea: box,
    Drawer: ({ children, open }: { children?: ReactNode; open: boolean }) =>
      open ? <div>{children}</div> : null,
  };
});

const summary: RunRecordSummary = {
  id: 'run-1',
  targetId: 'workflow-1',
  targetType: 'workflow',
  targetName: 'Report',
  status: 'running',
  startedAt: '2026-10-21T00:00:00Z',
};
const record = (status: RunRecord['status']): RunRecord => ({
  ...summary,
  status,
  targetSnapshot: { settings: { mode: 'task' }, nodes: [] },
  events: [],
  spans: [],
  lastSequence: -1,
  lastSpanId: null,
  runtime: {},
  outputView: {},
});
beforeEach(() => {
  vi.clearAllMocks();
  native.listeners.clear();
  useRunWorkspaceStore.setState({
    tabs: [],
    activeRunId: undefined,
    open: false,
  });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <RunEventTracker />
      <RunWorkspace />
    </QueryClientProvider>,
  );
  return { client, view };
}

it('shares global listeners, stops reading when closed, and restores current state on reopening', async () => {
  vi.mocked(inspectRunRecord).mockResolvedValue(record('running'));
  const { client, view } = mount();
  try {
    await act(async () => {});
    expect(native.listeners.size).toBe(5);
    expect(inspectRunRecord).not.toHaveBeenCalled();
    await act(async () => {
      useRunWorkspaceStore.getState().openRun(summary);
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId('run-output').textContent).toBe('running'),
    );
    await act(async () => {
      useRunWorkspaceStore.getState().setOpen(false);
    });
    const reads = vi.mocked(inspectRunRecord).mock.calls.length;
    vi.mocked(inspectRunRecord).mockResolvedValue(record('completed'));
    await act(async () => {
      native.listeners.get('run-event')!({
        payload: { runId: summary.id, event: { type: 'done' } },
      });
      native.listeners.get('run-status-changed')!({
        payload: { runId: summary.id },
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(inspectRunRecord).toHaveBeenCalledTimes(reads);
    await act(async () => {
      useRunWorkspaceStore.getState().setOpen(true);
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId('run-output').textContent).toBe('completed'),
    );
  } finally {
    view.unmount();
    client.clear();
  }
  expect(native.stop).toHaveBeenCalledTimes(5);
});

it('does not let a stale initial response overwrite a pushed terminal outcome', async () => {
  let resolveOld!: (record: RunRecord) => void;
  vi.mocked(inspectRunRecord).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  vi.mocked(inspectRunRecord).mockResolvedValue(record('completed'));
  const { client, view } = mount();
  try {
    await act(async () => {});
    await act(async () => {
      useRunWorkspaceStore.getState().openRun(summary);
    });
    await vi.waitFor(() => expect(inspectRunRecord).toHaveBeenCalledOnce());
    await act(async () => {
      native.listeners.get('run-status-changed')!({
        payload: { runId: summary.id },
      });
    });
    await vi.waitFor(() =>
      expect(screen.getByTestId('run-output').textContent).toBe('completed'),
    );
    await act(async () => {
      resolveOld(record('running'));
    });
    expect(screen.getByTestId('run-output').textContent).toBe('completed');
  } finally {
    view.unmount();
    client.clear();
  }
});
