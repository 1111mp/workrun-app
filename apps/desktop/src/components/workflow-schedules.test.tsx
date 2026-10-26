import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  listWorkflowReleases,
  listWorkflowSchedules,
  saveWorkflowSchedule,
  type WorkflowDocument,
  type WorkflowRelease,
  type WorkflowSchedule,
} from '@/services/workflow';

import { WorkflowSchedules } from './workflow-schedules';

const mode = vi.hoisted(() => ({ team: true }));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => mode.team }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/services/workflow', () => ({
  listWorkflowReleases: vi.fn(),
  listWorkflowSchedules: vi.fn(),
  saveWorkflowSchedule: vi.fn(),
  deleteWorkflowSchedule: vi.fn(),
  setWorkflowScheduleEnabled: vi.fn(),
  toWorkflowDsl: vi.fn(() => ({})),
}));

const document: WorkflowDocument = {
  settings: {
    name: 'Published',
    description: '',
    mode: 'task',
    inputSchema: { fields: [] },
    outputSchema: { fields: [] },
  },
  nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 }, data: {} }],
  edges: [],
};
const release: WorkflowRelease = {
  id: 'release-1',
  workflowId: 'workflow-1',
  version: '1.0.0',
  releaseNote: 'First',
  publishedAt: '2026-10-26',
  document,
};

beforeEach(() => {
  vi.clearAllMocks();
  mode.team = true;
  vi.mocked(listWorkflowReleases).mockResolvedValue([release]);
  vi.mocked(listWorkflowSchedules).mockResolvedValue([]);
  vi.mocked(saveWorkflowSchedule).mockResolvedValue({} as WorkflowSchedule);
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <WorkflowSchedules
        workflowId='workflow-1'
        document={{
          ...document,
          settings: { ...document.settings, name: 'Unpublished edits' },
        }}
        dsl={{}}
        release={release}
      />
    </QueryClientProvider>,
  );
}

it('offers following latest only in Team mode and saves that policy', async () => {
  const user = userEvent.setup();
  const view = mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'workflowEditor.schedules.new' }),
  );
  const dialog = await screen.findByRole('dialog');
  await user.click(
    within(dialog).getByRole('combobox', {
      name: 'workflowEditor.schedules.release',
    }),
  );
  await user.click(
    await screen.findByRole('option', {
      name: 'workflowEditor.schedules.latestPublished',
    }),
  );
  fireEvent.click(
    within(dialog).getByRole('button', {
      name: 'workflowEditor.schedules.save',
    }),
  );
  await waitFor(() =>
    expect(saveWorkflowSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'latest_published' },
        targetSnapshot: document,
      }),
    ),
  );
  view.unmount();

  mode.team = false;
  mount();
  fireEvent.click(
    screen.getByRole('button', { name: 'workflowEditor.schedules.new' }),
  );
  expect(
    within(await screen.findByRole('dialog')).queryByRole('combobox', {
      name: 'workflowEditor.schedules.release',
    }),
  ).toBeNull();
});

it.each(['latest_published', 'published_release'] as const)(
  'retains %s when editing a saved schedule',
  async (kind) => {
    vi.mocked(listWorkflowSchedules).mockResolvedValue([
      {
        id: 'schedule-1',
        name: 'Daily',
        targetType: 'workflow',
        targetId: 'workflow-1',
        targetName: 'Published',
        cronExpression: '0 9 * * *',
        timezone: 'UTC',
        enabled: true,
        nextRunAt: '2026-10-27T09:00:00Z',
        source:
          kind === 'latest_published'
            ? { kind }
            : {
                kind,
                releaseId: release.id,
                releaseVersion: release.version,
                dsl: {},
              },
      },
    ]);
    mount();
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'workflowEditor.schedules.edit',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(
      within(dialog).getByRole('button', {
        name: 'workflowEditor.schedules.save',
      }),
    );
    await waitFor(() =>
      expect(saveWorkflowSchedule).toHaveBeenCalledWith(
        expect.objectContaining({ source: expect.objectContaining({ kind }) }),
      ),
    );
  },
);
