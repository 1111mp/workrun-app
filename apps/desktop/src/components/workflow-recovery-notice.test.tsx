import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  render as renderComponent,
  within,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import {
  dismissRunRecovery,
  inspectRunRecord,
  type RunRecord,
} from '@/services/run-history';
import { recoverInterruptedWorkflowRun } from '@/services/workflow';

import { WorkflowRecoveryNotice } from './workflow-recovery-notice';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: vi.fn(),
  dismissRunRecovery: vi.fn(),
}));
vi.mock('@/services/workflow', () => ({
  recoverInterruptedWorkflowRun: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

async function mount(extra: Partial<RunRecord> = {}) {
  const record: RunRecord = {
    id: 'original',
    targetType: 'workflow',
    targetId: 'workflow',
    targetName: 'Workflow',
    status: 'interrupted',
    startedAt: '2026-10-11',
    error: 'Previous execution stopped',
    runtime: {},
    targetSnapshot: {},
    outputView: {},
    events: [],
    spans: [],
    ...extra,
  };
  vi.mocked(inspectRunRecord).mockResolvedValue(record);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    ['run-history', 'recovery-state', 'personal', 'original'],
    record,
  );
  const user = userEvent.setup();
  const rendered = renderComponent(
    <QueryClientProvider client={client}>
      <WorkflowRecoveryNotice runId='original' />
    </QueryClientProvider>,
  );
  return {
    host: rendered.container,
    user,
    close: async () => {
      rendered.unmount();
      client.clear();
    },
  };
}

function button(host: HTMLElement, label: string) {
  return within(host).getByRole('button', {
    name: (name) => name.includes(label),
  });
}

it('retains recovery errors and retries the original run without replaying it', async () => {
  const recover = vi
    .mocked(recoverInterruptedWorkflowRun)
    .mockRejectedValueOnce(new Error('Original result is unknown'))
    .mockResolvedValueOnce({} as never);
  const view = await mount();
  try {
    await view.user.click(button(view.host, 'executionRecovery.tryRecover'));
    await waitFor(() =>
      expect(view.host).toHaveTextContent('Original result is unknown'),
    );
    expect(recover).toHaveBeenLastCalledWith('original');
    expect(button(view.host, 'executionRecovery.tryRecover')).toBeEnabled();
    await view.user.click(button(view.host, 'executionRecovery.tryRecover'));
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2));
    expect(view.host.textContent).not.toContain('Original result is unknown');
  } finally {
    await view.close();
  }
});

it('shows remote reconciliation progress and prevents concurrent manual recovery', async () => {
  const view = await mount({
    executionHistory: {
      attempts: [],
      operations: [],
      recovery: { status: 'running', attempts: 1, nextCheckAt: '2026-10-11' },
    },
  });
  try {
    expect(view.host.textContent).toContain(
      'executionRecovery.confirmingRemote',
    );
    expect(button(view.host, 'executionRecovery.tryRecover')).toBeDisabled();
    await view.user.click(button(view.host, 'executionRecovery.tryRecover'));
    expect(recoverInterruptedWorkflowRun).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('stops tracking only the selected run and never invokes recovery', async () => {
  vi.mocked(dismissRunRecovery).mockResolvedValue(undefined);
  const view = await mount();
  try {
    await view.user.click(button(view.host, 'executionRecovery.dismiss'));
    expect(dismissRunRecovery).toHaveBeenCalledExactlyOnceWith('original');
    expect(recoverInterruptedWorkflowRun).not.toHaveBeenCalled();
  } finally {
    await view.close();
  }
});

it('shows durable recovery failure after reopening and hides actions on dismissed runs', async () => {
  const view = await mount({
    runtime: { recoveryDismissed: true },
    executionHistory: {
      attempts: [],
      operations: [],
      recovery: {
        status: 'blocked',
        lastError: 'Missing checkpoint',
        attempts: 1,
        nextCheckAt: '2026-10-11',
      },
    },
  });
  try {
    expect(view.host.textContent).toContain('Missing checkpoint');
    expect(view.host.textContent).toContain('executionRecovery.dismissed');
    expect(view.host.querySelector('button')).toBeNull();
  } finally {
    await view.close();
  }
});
