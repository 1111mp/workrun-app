import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  createTeamProcessNodeDraft,
  deleteProcessNode,
  deletePublishedProcessNode,
  getProcessNode,
  getPublishedProcessNode,
  updatePublishedProcessNode,
  publishProcessNodeVersion,
  updateProcessNode,
  type ProcessNode,
} from '@/services/process-node';
import { teamModelSessionVersion } from '@/services/team-model-session';

import { Component as DetailPage } from './detail';

vi.mock('@/services/team-model-session', () => ({
  teamModelSessionVersion: vi.fn(() => 0),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => true }));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ teamUser: { id: 'alice' } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/app-schedules', () => ({ AppSchedules: () => null }));
vi.mock('@/components/app-share-dialog', () => ({
  AppExportButton: () => null,
}));
vi.mock('@/components/deeplink-dialog', () => ({ DeeplinkDialog: () => null }));
vi.mock('@/components/app-run-output-panel', () => ({
  AppRunOutputPanel: () => null,
  restoreProcessNodeRun: vi.fn(),
}));
vi.mock('@/components/json-editor', () => ({ JsonEditorField: () => null }));
vi.mock('./project-path', () => ({
  copyProjectPath: vi.fn(),
  openProjectDirectory: vi.fn(),
}));
vi.mock('@/components/forms', () => ({
  AppPublishForm: ({
    onSubmit,
    isSubmitting,
  }: {
    onSubmit: (version: string, note: string) => Promise<void>;
    isSubmitting: boolean;
  }) => (
    <button
      disabled={isSubmitting}
      onClick={() => void onSubmit('0.1.0', '').catch(() => {})}
    >
      Publish fixture
    </button>
  ),
}));
vi.mock('@/services/process-node', () => ({
  getProcessNode: vi.fn(),
  getPublishedProcessNode: vi.fn(),
  updatePublishedProcessNode: vi.fn(),
  deleteProcessNode: vi.fn().mockResolvedValue(undefined),
  deletePublishedProcessNode: vi.fn().mockResolvedValue(undefined),
  listProcessNodeWorkflowReferences: vi.fn().mockResolvedValue([]),
  getProcessNodeProjectVersion: vi.fn().mockResolvedValue('0.1.0'),
  setProcessNodeProjectVersion: vi.fn().mockResolvedValue(undefined),
  updateProcessNode: vi.fn(),
  createTeamProcessNodeDraft: vi.fn().mockResolvedValue({ id: 'remote-app' }),
  hasPublishedProcessNodeVersion: vi.fn().mockResolvedValue({ exists: false }),
  publishProcessNodeVersion: vi.fn(),
}));

it('keeps creation and saving local and reuses the remote identity after a failed first publication', async () => {
  let node: ProcessNode = {
    definition: {
      id: 'local-app',
      createdAt: '2026-11-11T00:00:00Z',
      updatedAt: '2026-11-11T00:00:00Z',
      name: '订单查询',
      description: '',
      version: '0.1.0',
      entry: 'main.py',
      kind: 'tool',
      toolExecutionPolicy: 'ask_every_time',
      toolRiskLevel: 'low',
      toolPermissions: [],
      inputs: {},
      outputs: {},
      publicationStatus: 'draft',
    },
    installStatus: 'installed',
    projectPath: '/account/process-nodes/local-app',
  };
  vi.mocked(getProcessNode).mockImplementation(async () => node);
  vi.mocked(updateProcessNode).mockImplementation(async (definition) => {
    node = { ...node, definition };
    return node;
  });
  vi.mocked(publishProcessNodeVersion)
    .mockRejectedValueOnce(new Error('Upload failed'))
    .mockResolvedValueOnce(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/apps/local-app']}>
        <Routes>
          <Route path='/apps/:id' element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    fireEvent.click(
      await screen.findByRole('button', { name: 'apps.detail.save' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(createTeamProcessNodeDraft).not.toHaveBeenCalled();
    expect(publishProcessNodeVersion).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'apps.detail.publish' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Publish fixture' }),
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(node.definition.remoteAppId).toBe('remote-app');
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Publish fixture' }),
      ).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Publish fixture' }));
    await waitFor(() =>
      expect(node.definition.publicationStatus).toBe('published'),
    );
    expect(createTeamProcessNodeDraft).toHaveBeenCalledTimes(1);
    expect(publishProcessNodeVersion).toHaveBeenCalledTimes(2);
    expect(node.definition.remoteAppId).toBe('remote-app');
  } finally {
    ui.unmount();
    client.clear();
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(teamModelSessionVersion).mockReturnValue(0);
});

it.each([
  [{ remoteAppId: 'remote-app' }, true, false],
  [{ remoteAppId: 'remote-app' }, true, true],
  [{}, false, false],
  [{ remoteAppId: 'remote-app', remoteReleaseId: 'release-1' }, false, false],
])(
  'deletes the server App only for its local authoring project (%j)',
  async (association, removeServer, failServer) => {
    const node: ProcessNode = {
      definition: {
        id: 'local-app',
        name: 'Delete app',
        description: '',
        version: '0.1.0',
        createdAt: '',
        updatedAt: '',
        entry: 'main.py',
        kind: 'tool',
        toolExecutionPolicy: 'ask_every_time',
        inputs: {},
        outputs: {},
        ...association,
      },
      installStatus: 'installed',
      projectPath: '/account/process-nodes/local-app',
    };
    vi.mocked(getProcessNode).mockResolvedValue(node);
    if (failServer)
      vi.mocked(deletePublishedProcessNode).mockRejectedValueOnce(
        new Error('Server deletion failed'),
      );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/apps/local-app']}>
          <Routes>
            <Route path='/apps/:id' element={<DetailPage />} />
            <Route path='/apps' element={<p>App list</p>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    try {
      fireEvent.click(
        await screen.findByRole('button', { name: 'apps.detail.delete' }),
      );
      const confirm = await screen.findByRole('alertdialog');
      const button = [...confirm.querySelectorAll('button')].find(
        (item) => item.textContent === 'apps.detail.delete',
      )!;
      await waitFor(() => expect(button).not.toBeDisabled());
      fireEvent.click(button);
      if (failServer) {
        await waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(deleteProcessNode).not.toHaveBeenCalled();
        expect(screen.queryByText('App list')).toBeNull();
        return;
      }
      await screen.findByText('App list');
      expect(deleteProcessNode).toHaveBeenCalledWith('local-app', false);
      if (removeServer) {
        expect(deletePublishedProcessNode).toHaveBeenCalledWith('remote-app');
        expect(
          vi.mocked(deletePublishedProcessNode).mock.invocationCallOrder[0],
        ).toBeLessThan(
          vi.mocked(deleteProcessNode).mock.invocationCallOrder[0]!,
        );
      } else expect(deletePublishedProcessNode).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      client.clear();
    }
  },
);

it('saves an associated local App without a server write and publishes through the existing ID', async () => {
  let node: ProcessNode = {
    definition: {
      id: 'local-app',
      name: 'Local edits',
      description: '',
      version: '0.1.0',
      createdAt: '',
      updatedAt: '',
      entry: 'main.py',
      kind: 'tool',
      toolExecutionPolicy: 'ask_every_time',
      inputs: {},
      outputs: {},
      remoteAppId: 'existing-remote',
    },
    installStatus: 'installed',
    projectPath: '/account/process-nodes/local-app',
  };
  vi.mocked(getProcessNode).mockImplementation(async () => node);
  vi.mocked(updateProcessNode).mockImplementation(async (definition) => {
    node = { ...node, definition };
    return node;
  });
  vi.mocked(publishProcessNodeVersion).mockResolvedValue(undefined);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/apps/local-app']}>
        <Routes>
          <Route path='/apps/:id' element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    fireEvent.click(
      await screen.findByRole('button', { name: 'apps.detail.save' }),
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(updateProcessNode).toHaveBeenCalled();
    expect(node.definition.remoteAppId).toBe('existing-remote');
    expect(updatePublishedProcessNode).not.toHaveBeenCalled();
    expect(createTeamProcessNodeDraft).not.toHaveBeenCalled();
    expect(publishProcessNodeVersion).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'apps.detail.publish' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Publish fixture' }),
    );
    await waitFor(() =>
      expect(node.definition.publicationStatus).toBe('published'),
    );
    expect(createTeamProcessNodeDraft).not.toHaveBeenCalled();
    expect(publishProcessNodeVersion).toHaveBeenCalledWith(
      'existing-remote',
      'local-app',
      '0.1.0',
      '',
      expect.objectContaining({ remoteAppId: 'existing-remote' }),
    );
  } finally {
    ui.unmount();
    client.clear();
  }
});

it.each(['alice', 'bob'])(
  'keeps catalog details read-only, including the owner %s',
  async (ownerId) => {
    vi.mocked(getPublishedProcessNode).mockResolvedValue({
      definition: {
        id: 'catalog-app',
        name: 'Catalog details',
        description: '',
        version: '0.1.0',
        createdAt: '',
        updatedAt: '',
        entry: 'main.py',
        kind: 'tool',
        toolExecutionPolicy: 'ask_every_time',
        inputs: {},
        outputs: {},
        ownerId,
      },
      installStatus: 'notInstalled',
      projectPath: '',
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const ui = render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/apps/catalog-app?catalog=true']}>
          <Routes>
            <Route path='/apps/:id' element={<DetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    try {
      await screen.findByDisplayValue('Catalog details');
      expect(
        screen.queryByRole('button', { name: 'apps.detail.save' }),
      ).toBeNull();
      expect(
        screen.queryByRole('button', { name: 'apps.detail.publish' }),
      ).toBeNull();
      expect(
        Boolean(screen.queryByRole('button', { name: 'apps.detail.delete' })),
      ).toBe(ownerId === 'alice');
      expect(updatePublishedProcessNode).not.toHaveBeenCalled();
      expect(updateProcessNode).not.toHaveBeenCalled();
    } finally {
      ui.unmount();
      client.clear();
    }
  },
);

it('does not resume publication or repopulate caches after an account switch', async () => {
  const node: ProcessNode = {
    definition: {
      id: 'local-app',
      name: 'Alice app',
      description: '',
      version: '0.1.0',
      createdAt: '',
      updatedAt: '',
      entry: 'main.py',
      kind: 'tool',
      toolExecutionPolicy: 'ask_every_time',
      inputs: {},
      outputs: {},
      remoteAppId: 'alice-remote',
    },
    installStatus: 'installed',
    projectPath: '/alice/process-nodes/local-app',
  };
  vi.mocked(getProcessNode).mockResolvedValue(node);
  vi.mocked(updateProcessNode).mockImplementation(async (definition) => ({
    ...node,
    definition,
  }));
  let finish!: () => void;
  vi.mocked(publishProcessNodeVersion).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = () => resolve();
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const ui = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/apps/local-app']}>
        <Routes>
          <Route path='/apps/:id' element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  try {
    fireEvent.click(
      await screen.findByRole('button', { name: 'apps.detail.publish' }),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Publish fixture' }),
    );
    await waitFor(() => expect(publishProcessNodeVersion).toHaveBeenCalled());
    const updatesBeforeSwitch = vi.mocked(updateProcessNode).mock.calls.length;
    vi.mocked(teamModelSessionVersion).mockReturnValue(1);
    ui.unmount();
    client.clear();
    finish();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(updateProcessNode).toHaveBeenCalledTimes(updatesBeforeSwitch);
    expect(client.getQueryData(['apps', 'local-app', 'local'])).toBeUndefined();
    expect(toast.success).not.toHaveBeenCalled();
  } finally {
    ui.unmount();
    client.clear();
  }
});
