import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  workflows: vi.fn(),
  apps: vi.fn(),
  start: vi.fn(),
  prepare: vi.fn(),
  team: false,
  error: vi.fn(),
}));
vi.mock('@/components/app-sidebar', () => ({
  useEntryWorkspace: () => 'personal',
}));
vi.mock('@/services/workflow', () => ({
  getWorkflowCapabilities: mocks.workflows,
}));
vi.mock('@/services/process-node', () => ({
  getProcessNodes: mocks.apps,
  startBackgroundProcessNodeRun: mocks.start,
  ensurePublishedProcessNode: mocks.prepare,
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => mocks.team }));
vi.mock('sonner', () => ({ toast: { error: mocks.error } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { Component as StartPage } from './library';

const app = {
  definition: {
    id: 'invoices',
    name: 'Invoice export',
    description: 'Summarize invoices',
    kind: 'workflow',
  },
  installStatus: 'installed',
  projectPath: '/apps/invoices',
};
function Location() {
  const location = useLocation();
  return (
    <output data-testid='location'>
      {location.pathname}
      {location.search}
    </output>
  );
}
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <StartPage />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.team = false;
  mocks.apps.mockResolvedValue([app]);
  mocks.workflows.mockResolvedValue([
    {
      id: 'report',
      editable: false,
      document: {
        settings: { name: 'Weekly report', description: 'Prepare a report' },
      },
    },
  ]);
  mocks.start.mockResolvedValue(undefined);
});

it('searches real capabilities and preserves selection until submit', async () => {
  const user = setup();
  await screen.findByText('Invoice export');
  await user.type(screen.getByRole('textbox'), 'invoice');
  expect(screen.getByText('Weekly report')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'start.searchLabel' }));
  expect(screen.queryByText('Weekly report')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'start.clearSearch' }));
  expect(screen.getByText('Weekly report')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'start.configureRun' }),
  ).toHaveAttribute('href', '/workflows/report?run=true&catalog=true');
});

it('starts an app once and opens its durable output record', async () => {
  let finish!: () => void;
  mocks.start.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const user = setup();
  const run = await screen.findByRole('button', { name: 'start.run' });
  await user.dblClick(run);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(run).toBeDisabled();
  const request = mocks.start.mock.calls[0]![0];
  expect(request).toMatchObject({
    targetId: 'invoices',
    targetSnapshot: app.definition,
  });
  finish();
  await waitFor(() =>
    expect(screen.getByTestId('location').textContent).toBe(
      `/apps?runId=${request.runId}`,
    ),
  );
});

it('does not submit an IME composition on Enter', async () => {
  setup();
  await screen.findByText('Invoice export');
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'no match' } });
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
  expect(screen.getByText('Invoice export')).toBeInTheDocument();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByText('start.noMatches')).toBeInTheDocument();
});

it('keeps available apps usable when workflows fail and retries the catalog', async () => {
  mocks.workflows.mockRejectedValueOnce(new Error('offline'));
  const user = setup();
  await screen.findByText('start.loadError');
  expect(screen.getByText('Invoice export')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'start.retry' }));
  await screen.findByText('Weekly report');
  expect(screen.queryByText('start.loadError')).not.toBeInTheDocument();
});

it('prepares a team app before starting and allows retry after failure', async () => {
  mocks.team = true;
  mocks.prepare
    .mockRejectedValueOnce(new Error('install failed'))
    .mockResolvedValueOnce(app);
  const user = setup();
  await user.click(await screen.findByRole('button', { name: 'start.run' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(mocks.start).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'start.run' }));
  await waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
});
