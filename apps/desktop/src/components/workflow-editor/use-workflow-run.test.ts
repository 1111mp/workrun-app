// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { listActiveRuns, type RunRecordSummary } from '@/services/run-history';
import {
  startBackgroundWorkflowRun,
  subscribeWorkflowRun,
  type WorkflowRunEventEnvelope,
} from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores/workflow-run.store';

import { useWorkflowRun } from './use-workflow-run';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', async () => ({
  ...(await import('@/stores/workflow-run.store')),
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/services/run-history', () => ({
  listActiveRuns: vi.fn(),
  inspectRunRecord: vi.fn(),
  resolvePendingAction: vi.fn(),
}));
vi.mock('@/services/workflow', () => ({
  startBackgroundWorkflowRun: vi.fn(),
  subscribeWorkflowRun: vi.fn(async () => vi.fn()),
  toWorkflowDocument: vi.fn(() => ({ nodes: [], edges: [] })),
  toWorkflowDsl: vi.fn(() => ({ nodes: [], edges: [] })),
}));
vi.mock('@/services/process-node', () => ({
  prepareWorkflowProcessApps: vi.fn(async (dsl: unknown) => dsl),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function active(status: RunRecordSummary['status']): RunRecordSummary {
  return {
    id: 'existing',
    targetType: 'workflow',
    targetId: 'weather',
    targetName: 'Weather',
    status,
    startedAt: '2026-10-11T00:00:00Z',
  };
}
async function mount(runs: RunRecordSummary[]) {
  vi.clearAllMocks();
  useWorkflowRunStore.getState().resetRunView();
  vi.mocked(listActiveRuns).mockResolvedValue(runs);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(['run-history', 'active', 'personal'], runs);
  let hook: ReturnType<typeof useWorkflowRun>;
  function Harness() {
    const current = useWorkflowRun('weather', [], [], {
      mode: 'task',
      inputSchema: { fields: [] },
    } as unknown as WorkflowSettings);
    useEffect(() => {
      hook = current;
    });
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Harness)),
    ),
  );
  return {
    get hook() {
      return hook!;
    },
    close: async () => {
      await act(async () => root.unmount());
      client.clear();
    },
  };
}

it.each(['queued', 'running', 'waiting_for_input'] as const)(
  'blocks both launch paths while a workflow is %s',
  async (status) => {
    const view = await mount([active(status)]);
    try {
      expect(view.hook.hasActiveRun).toBe(true);
      expect(view.hook.runStartDisabled).toBe(true);
      await act(async () => {
        view.hook.startRun();
        view.hook.startWorkflowRun({});
      });
      expect(startBackgroundWorkflowRun).not.toHaveBeenCalled();
      expect(useWorkflowRunStore.getState().projection.runId).toBeUndefined();
    } finally {
      await view.close();
    }
  },
);

it('rechecks durable runs before replacing output when the cached list is empty', async () => {
  const view = await mount([]);
  try {
    expect(view.hook.runStartDisabled).toBe(false);
    vi.mocked(listActiveRuns).mockResolvedValue([active('waiting_for_input')]);
    await act(async () => view.hook.startWorkflowRun({}));
    expect(listActiveRuns).toHaveBeenCalled();
    expect(startBackgroundWorkflowRun).not.toHaveBeenCalled();
    expect(useWorkflowRunStore.getState().projection.runId).toBeUndefined();
  } finally {
    await view.close();
  }
});

it('allows launching again after the previous run completed', async () => {
  const view = await mount([active('completed')]);
  try {
    expect(view.hook.runStartDisabled).toBe(false);
  } finally {
    await view.close();
  }
});

it('keeps a waiting projection blocked before the active-run list catches up', async () => {
  const view = await mount([]);
  try {
    await act(async () => {
      useWorkflowRunStore.setState((state) => ({
        projection: {
          ...state.projection,
          status: 'interrupted',
          awaitingInput: true,
        },
      }));
    });
    expect(view.hook.hasActiveRun).toBe(true);
    expect(view.hook.runStartDisabled).toBe(true);
    await act(async () => view.hook.startWorkflowRun({}));
    expect(startBackgroundWorkflowRun).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('does not block a workflow because another workflow is running', async () => {
  const view = await mount([
    { ...active('running'), targetId: 'other-workflow' },
  ]);
  try {
    expect(view.hook.runStartDisabled).toBe(false);
  } finally {
    await view.close();
  }
});

it('preserves entered input in both the persisted input and execution initial state', async () => {
  const view = await mount([]);
  try {
    await act(async () => {
      view.hook.startWorkflowRun({ input: '查询上海天气' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(startBackgroundWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { input: '查询上海天气' },
        initialState: { input: '查询上海天气' },
      }),
    );
  } finally {
    await view.close();
  }
});

it('publishes a burst of tool-approval events in one frame without flashing a completed node', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const view = await mount([]);
  let stop = () => {};
  try {
    await act(async () => {
      view.hook.startWorkflowRun({ input: 'Cancel order' });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const [id, onEvent] = vi.mocked(subscribeWorkflowRun).mock.calls.at(-1)!;
    const observations: string[] = [];
    stop = useWorkflowRunStore.subscribe((state) =>
      observations.push(state.projection.status),
    );
    const events: WorkflowRunEventEnvelope['event'][] = [
      { type: 'node_start', node: 'cancel-order', step: 3 },
      { type: 'node_end', node: 'cancel-order', step: 3, duration_ms: 1 },
      {
        type: 'custom',
        node: 'cancel-order',
        event_type: 'agent.tool_approval_required',
        data: { nodeId: 'cancel-order', runActionId: 'approval' },
      },
      {
        type: 'interrupted',
        node: 'unknown',
        message: 'Dynamic interrupt: tool_confirmation',
      },
    ];
    await act(async () =>
      events.forEach((event, sequence) =>
        onEvent({ runId: id, sequence, event }),
      ),
    );
    expect(observations).toEqual([]);
    await act(async () => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    });
    expect(frames.size).toBe(0);
    expect(observations).toEqual(['interrupted']);
    const projection = useWorkflowRunStore.getState().projection;
    expect(projection.eventSequence).toBe(3);
    expect(projection.executionIds).toHaveLength(1);
    expect(
      projection.executionsById[projection.executionIds[0]].actionIds,
    ).toEqual(['approval']);
  } finally {
    stop();
    await view.close();
    vi.unstubAllGlobals();
  }
});
