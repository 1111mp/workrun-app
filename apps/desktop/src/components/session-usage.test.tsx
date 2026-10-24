import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  getSessionUsage,
  type SessionUsage as Usage,
} from '@/services/model-usage';

import { SessionUsage } from './session-usage';

vi.mock('@/services/model-usage', () => ({ getSessionUsage: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it('loads on demand, separates execution, and keeps missing usage distinct from zero', async () => {
  const totals = {
    calls: 1,
    missingUsageCalls: 0,
    unfinishedCalls: 0,
    estimatedCalls: 0,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
  const data: Usage = {
    recordingDegraded: true,
    conversation: totals,
    byPurpose: [],
    byTurn: [
      {
        turnId: 'latest',
        startedAt: '2026-10-22T00:01:00Z',
        endedAt: null,
        calls: 1,
        conversationTokens: 7,
        executionTokens: 0,
        modelDurationMs: 1,
        missingUsageCalls: 0,
        unfinishedCalls: 0,
      },
      {
        turnId: 'old',
        startedAt: '2026-10-22T00:00:00Z',
        endedAt: null,
        calls: 1,
        conversationTokens: 8,
        executionTokens: 0,
        modelDurationMs: 1,
        missingUsageCalls: 0,
        unfinishedCalls: 0,
      },
      {
        turnId: null,
        startedAt: '2026-10-22T00:02:00Z',
        endedAt: null,
        calls: 0,
        conversationTokens: 0,
        executionTokens: 0,
        modelDurationMs: 0,
        missingUsageCalls: 0,
        unfinishedCalls: 0,
      },
    ],
    execution: {
      ...totals,
      calls: 1,
      missingUsageCalls: 1,
      unfinishedCalls: 1,
      totalTokens: 0,
    },
    calls: [
      {
        id: 'known',
        model: 'test',
        startedAt: '2026-10-22T00:00:00Z',
        status: 'completed',
        context: { purpose: 'intent' },
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      {
        id: 'missing',
        model: 'test',
        startedAt: '2026-10-22T00:00:01Z',
        status: 'failed',
        context: { purpose: 'workflow', runId: 'run' },
        usage: null,
      },
    ],
  };
  vi.mocked(getSessionUsage).mockResolvedValue(data);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionUsage kind='assistant' sessionId='session' />
    </QueryClientProvider>,
  );
  expect(getSessionUsage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'usage.title' }));
  await waitFor(() =>
    expect(getSessionUsage).toHaveBeenCalledWith('assistant', 'session'),
  );
  expect(await screen.findByText('usage.recordedTotal')).toBeTruthy();
  expect(screen.getByText(/usage.latestTurn/).textContent).toContain('7');
  expect(screen.queryByText('usage.purposes.intent')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'usage.calls' }));
  expect(await screen.findByText('usage.purposes.intent')).toBeTruthy();
  expect(screen.getByText('usage.purposes.workflow')).toBeTruthy();
  expect(screen.getAllByText('—')).toHaveLength(3);
  expect(screen.getByText('usage.statuses.failed')).toBeTruthy();
  expect(screen.getByText('usage.recordingDegraded')).toBeTruthy();
});

it('does not present an empty ledger as confirmed zero usage', async () => {
  const totals = {
    calls: 0,
    missingUsageCalls: 0,
    unfinishedCalls: 0,
    estimatedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
  };
  vi.mocked(getSessionUsage).mockResolvedValue({
    conversation: totals,
    execution: totals,
    byPurpose: [],
    calls: [],
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SessionUsage kind='assistant' sessionId='empty' />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'usage.title' }));
  expect(await screen.findByText('usage.empty')).toBeTruthy();
  expect(screen.queryByText('usage.recordedTotal')).toBeNull();
  expect(screen.queryByRole('button', { name: 'usage.calls' })).toBeNull();
  client.clear();
});
