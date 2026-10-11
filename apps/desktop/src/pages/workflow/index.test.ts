// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';

import { inspectRunRecord, listActiveRuns } from '@/services/run-history';

import { Component } from './index';

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components', () => ({
  WorkflowEditor: ({
    historicalRun,
    liveRun,
  }: {
    historicalRun?: { id: string };
    liveRun?: boolean;
  }) =>
    createElement('output', null, `${historicalRun?.id ?? 'none'}:${liveRun}`),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
  useWorkflowRunStore: {
    getState: () => ({ setShowRunOutput: vi.fn(), setRunPanelOpen: vi.fn() }),
  },
}));
vi.mock('@/services/workflow', () => ({
  getWorkflow: async () => ({ id: 'weather' }),
  getPublishedWorkflow: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  listActiveRuns: vi.fn(),
  inspectRunRecord: vi.fn(),
}));
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  ['/workflows/weather', 'waiting:true', true],
  ['/workflows/weather?runId=old', 'old:false', false],
])(
  'restores the appropriate run when entering %s',
  async (path, expected, discover) => {
    vi.clearAllMocks();
    vi.mocked(listActiveRuns).mockResolvedValue([
      {
        id: 'other',
        targetType: 'workflow',
        targetId: 'other',
        targetName: 'Other',
        status: 'running',
        startedAt: '2026-10-11T03:00:00Z',
      },
      {
        id: 'running',
        targetType: 'workflow',
        targetId: 'weather',
        targetName: 'Weather',
        status: 'running',
        startedAt: '2026-10-11T02:00:00Z',
      },
      {
        id: 'waiting',
        targetType: 'workflow',
        targetId: 'weather',
        targetName: 'Weather',
        status: 'waiting_for_input',
        startedAt: '2026-10-11T01:00:00Z',
      },
    ]);
    vi.mocked(inspectRunRecord).mockImplementation(
      async (id) =>
        ({ id, targetType: 'workflow', targetId: 'weather' }) as Awaited<
          ReturnType<typeof inspectRunRecord>
        >,
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              MemoryRouter,
              { initialEntries: [path] },
              createElement(
                Routes,
                null,
                createElement(Route, {
                  path: '/workflows/:id',
                  element: createElement(Component),
                }),
              ),
            ),
          ),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.querySelector('output')?.textContent).toBe(expected);
      expect(listActiveRuns).toHaveBeenCalledTimes(discover ? 1 : 0);
      expect(inspectRunRecord).toHaveBeenCalledWith(
        discover ? 'waiting' : 'old',
      );
      const output = host.querySelector('output');
      let fail!: (error: Error) => void;
      vi.mocked(inspectRunRecord).mockImplementation(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      );
      await act(async () => {
        void client.invalidateQueries({
          queryKey: discover ? ['workflow-entry-active-run'] : ['run-history'],
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.querySelector('output')).toBe(output);
      expect(output?.textContent).toBe(expected);
      await act(async () => {
        fail(new Error('temporary snapshot read failure'));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(host.querySelector('output')).toBe(output);
      expect(output?.textContent).toBe(expected);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    }
  },
);
