import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'alice',
  userId: 'alice',
  sync: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(undefined),
  resetRun: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@daveyplate/better-auth-tauri/react', () => ({
  useBetterAuthTauri: vi.fn(),
}));
vi.mock('@/lib/auth-client', () => ({
  createTeamAuthClient: () => ({
    useSession: () => ({
      data: { session: { token: mocks.token }, user: { id: mocks.userId } },
    }),
  }),
}));
vi.mock('@/routes', () => ({ router: { navigate: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/team-model-session', () => ({
  syncTeamModelSession: mocks.sync,
  clearTeamModelSession: mocks.clear,
}));
vi.mock('@/stores', async () => {
  const { create } = await import('zustand');
  return {
    useWorkrunStore: create(() => ({
      config: {
        workspace_mode: 'team',
        team: { server_url: 'https://team.example' },
      },
      setTeamUser: vi.fn(),
    })),
    useRunWorkspaceStore: create(() => ({
      tabs: ['alice'],
      activeRunId: 'alice',
      open: true,
    })),
    useWorkflowRunStore: create(() => ({
      resetRunView: mocks.resetRun,
      activeChatSession: 'alice',
      lastRunInput: { secret: 'alice' },
    })),
  };
});
vi.mock('@/stores/assistant.store', async () => {
  const { create } = await import('zustand');
  return {
    useAssistantStore: create(() => ({
      disposeAssistantEvents: mocks.dispose,
      sessions: { alice: {} },
      scopes: {},
      summaries: {},
      streams: {},
      syncErrors: {},
      listErrors: {},
    })),
  };
});

import { useRunWorkspaceStore, useWorkflowRunStore } from '@/stores';
import { useAssistantStore } from '@/stores/assistant.store';

import { TeamAuthTauriHandler } from './team-auth-tauri-handler';

it('clears account caches and visible sessions before synchronizing the next login', async () => {
  const client = new QueryClient();
  const view = () => (
    <QueryClientProvider client={client}>
      <TeamAuthTauriHandler />
    </QueryClientProvider>
  );
  const ui = render(view());
  await act(async () => {});
  client.setQueryData(['recent-conversations'], ['alice']);
  client.setQueryData(['team-user', 'https://team.example', 'alice'], {
    id: 'alice',
  });
  client.setQueryData(['team-user', 'https://team.example', 'bob'], {
    id: 'bob',
  });
  useRunWorkspaceStore.setState({ tabs: ['alice'] } as never);
  useWorkflowRunStore.setState({ activeChatSession: 'alice' } as never);
  useAssistantStore.setState({ sessions: { alice: {} } } as never);
  mocks.sync.mockClear();
  mocks.clear.mockClear();
  mocks.token = 'bob';
  mocks.userId = 'bob';
  mocks.sync.mockImplementationOnce(() => {
    expect(client.getQueryData(['recent-conversations'])).toBeUndefined();
    expect(
      client.getQueryData(['team-user', 'https://team.example', 'alice']),
    ).toBeUndefined();
    expect(
      client.getQueryData(['team-user', 'https://team.example', 'bob']),
    ).toEqual({ id: 'bob' });
    expect(useRunWorkspaceStore.getState().tabs).toEqual([]);
    expect(useWorkflowRunStore.getState().activeChatSession).toBeUndefined();
    expect(useAssistantStore.getState().sessions).toEqual({});
    return Promise.resolve();
  });
  ui.rerender(view());
  await act(async () => {});
  expect(mocks.sync).toHaveBeenCalledWith('https://team.example', 'bob');
  expect(mocks.clear).not.toHaveBeenCalled();
  expect(mocks.dispose).toHaveBeenCalled();
  client.setQueryData(['recent-conversations'], ['bob']);
  mocks.dispose.mockClear();
  mocks.token = 'bob-refreshed';
  ui.rerender(view());
  await act(async () => {});
  expect(mocks.sync).toHaveBeenLastCalledWith(
    'https://team.example',
    'bob-refreshed',
  );
  expect(client.getQueryData(['recent-conversations'])).toEqual(['bob']);
  expect(mocks.dispose).not.toHaveBeenCalled();
  ui.unmount();
  expect(mocks.clear).toHaveBeenCalledWith('https://team.example');
});
