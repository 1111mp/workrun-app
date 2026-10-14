import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render as renderComponent } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { inspectRunRecord, type RunRecord } from '@/services/run-history';

import { useWorkflowRunRecord } from './use-workflow-run-record';

vi.mock('@/services/run-history', () => ({ inspectRunRecord: vi.fn() }));

it('retains the current record through delayed, failed and repeated revision refreshes, but never across runs', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const host = document.createElement('div');
  const record = { id: 'run-a', spans: [{ id: 'model-1' }] } as RunRecord;
  const renders: (RunRecord | undefined)[] = [];
  let revision = 0;
  let runId = 'run-a';
  function Harness() {
    const query = useWorkflowRunRecord(runId, revision, true);
    renders.push(query.data);
    return <output>{query.data?.id ?? 'empty'}</output>;
  }
  const render = () =>
    rendered.rerender(
      <QueryClientProvider client={client}>
        <Harness />
      </QueryClientProvider>,
    );
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  vi.mocked(inspectRunRecord).mockResolvedValue(record);
  const rendered = renderComponent(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
    { container: host },
  );
  try {
    await settle();
    expect(host.textContent).toBe('run-a');
    renders.length = 0;
    let reject!: (error: Error) => void;
    vi.mocked(inspectRunRecord).mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    revision++;
    render();
    await settle();
    expect(host.textContent).toBe('run-a');
    await act(async () => reject(new Error('temporary read failure')));
    await settle();
    expect(host.textContent).toBe('run-a');
    let resolve!: (record: RunRecord) => void;
    vi.mocked(inspectRunRecord).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    revision++;
    render();
    revision++;
    render();
    expect(host.textContent).toBe('run-a');
    await act(async () => resolve({ ...record, spans: [] }));
    await settle();
    expect(renders.every((value) => value?.id === 'run-a')).toBe(true);
    expect(
      client.getQueryCache().findAll({ queryKey: ['run-history-inspect'] }),
    ).toHaveLength(1);
    runId = 'run-b';
    render();
    expect(host.textContent).toBe('empty');
    await act(async () => resolve({ ...record, id: 'run-b' }));
    await settle();
    expect(host.textContent).toBe('run-b');
  } finally {
    rendered.unmount();
    client.clear();
    vi.clearAllMocks();
  }
});
