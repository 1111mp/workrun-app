import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  render as renderComponent,
  waitFor,
  type RenderResult,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';

import { inspectRunRecord, listActiveRuns } from '@/services/run-history';
import { getWorkflow } from '@/services/workflow';

import { Component } from './index';

vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock('@/components', () => ({
  WorkflowEditor: ({
    historicalRun,
    liveRun,
    workflow,
    readOnly,
    allowRun,
    assistantDraft,
  }: {
    historicalRun?: {
      id: string;
    };
    liveRun?: boolean;
    workflow?: unknown;
    readOnly?: boolean;
    allowRun?: boolean;
    assistantDraft?: boolean;
  }) => (
    <output
      data-document={JSON.stringify(workflow)}
      data-read-only={String(readOnly)}
      data-allow-run={String(allowRun)}
      data-assistant-draft={String(assistantDraft)}
    >{`${historicalRun?.id ?? 'none'}:${liveRun}`}</output>
  ),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
  useWorkflowRunStore: {
    getState: () => ({ setShowRunOutput: vi.fn(), setRunPanelOpen: vi.fn() }),
  },
}));
vi.mock('@/services/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflow')>()),
  getWorkflow: vi.fn(async () => ({ id: 'weather' })),
  getPublishedWorkflow: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  listActiveRuns: vi.fn(),
  inspectRunRecord: vi.fn(),
}));

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
    let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
    try {
      rendered = renderComponent(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path='/workflows/:id' element={<Component />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
        { container: host },
      );
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
      rendered.unmount();
      client.clear();
      host.remove();
    }
  },
);

it.each(['valid', 'missing', 'mismatch', 'error'] as const)(
  'opens assistant drafts in the regular editable workflow editor: %s',
  async (mode) => {
    vi.clearAllMocks();
    const id = '4ca4b5ba-8598-4a86-8235-bd104d64d0d5';
    const document = {
      settings: {
        name: 'Sales analysis',
        mode: 'task' as const,
        description: '',
        inputSchema: { fields: [] },
      },
      nodes: [
        {
          id: 'calc',
          type: 'codeact_agent',
          data: { modelProfileId: 'openai-gpt-5.6' },
          position: { x: 0, y: 0 },
        },
      ],
      edges: [],
    };
    vi.mocked(getWorkflow).mockResolvedValue({
      id: id,
      document,
      createdAt: '2026-10-18T00:00:00Z',
      updatedAt: '2026-10-18T00:00:00Z',
    } as Awaited<ReturnType<typeof getWorkflow>>);
    vi.mocked(inspectRunRecord).mockImplementation(async () => {
      if (mode === 'error') throw new Error('Snapshot read failed');
      return {
        id: 'sales-run',
        targetType: 'workflow',
        targetId: mode === 'mismatch' ? 'another-workflow' : id,
        startedAt: '2026-10-18T00:00:00Z',
        status: 'failed',
        targetSnapshot: mode === 'missing' ? null : document,
      } as Awaited<ReturnType<typeof inspectRunRecord>>;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const rendered = renderComponent(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            `/workflows/${encodeURIComponent(id)}?runId=sales-run`,
          ]}
        >
          <Routes>
            <Route path='/workflows/:id' element={<Component />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    try {
      await waitFor(() =>
        expect(rendered.container.querySelector('output')).not.toBeNull(),
      );
      const output = rendered.container.querySelector('output')!;
      if (mode === 'valid' || mode === 'missing') {
        await waitFor(() => expect(output.textContent).toBe('sales-run:false'));
      } else {
        expect(output.textContent).toBe('none:false');
      }
      expect(output.dataset.readOnly).toBe('false');
      expect(output.dataset.assistantDraft).toBe('undefined');
      expect(JSON.parse(output.dataset.document!).document).toEqual(document);
      expect(JSON.parse(output.dataset.document!).id).toBe(id);
      expect(getWorkflow).toHaveBeenCalledWith(id);
      expect(listActiveRuns).not.toHaveBeenCalled();
    } finally {
      rendered.unmount();
      client.clear();
    }
  },
);
