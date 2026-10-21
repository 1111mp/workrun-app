import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@/services/session', () => ({
  getTeamUser: session.getUser,
  normalizeServerUrl: (url: string) => url,
}));
vi.mock('@/lib/auth-client', () => ({ createTeamAuthClient: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', async () => {
  const { create } = await import('zustand');
  const store = create<{
    config: Partial<IWorkrunConfig>;
    setTeamUser: ReturnType<typeof vi.fn>;
    updateConfig: (patch: Partial<IWorkrunConfig>) => Promise<void>;
  }>(() => ({
    config: {
      workspace_mode: 'personal',
      team: { server_url: 'http://localhost:3000' },
    },
    setTeamUser: vi.fn(),
    updateConfig: async (patch) => {
      store.setState((s) => ({ config: { ...s.config, ...patch } }));
      // Let the gate mount its query before the save promise resolves.
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  }));
  return { useWorkrunStore: store };
});

import { WorkspaceSettings } from '@/pages/settings/workspace-settings';
import { useWorkrunStore } from '@/stores';

import { TeamSessionGate } from './team-session-gate';

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
  session.getUser.mockReset();
  useWorkrunStore.setState((state) => ({
    config: { ...state.config!, workspace_mode: 'personal' },
  }));
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route
            path='/settings'
            element={
              <TeamSessionGate>
                <WorkspaceSettings />
              </TeamSessionGate>
            }
          />
          <Route path='/login' element={<p>Team login</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

it('leaves loading after switching to an unreachable team server without refreshing', async () => {
  session.getUser.mockRejectedValue(
    new TypeError('Could not connect to the server'),
  );
  const client = setup();
  const clear = vi.spyOn(client, 'clear');
  fireEvent.click(
    screen.getByRole('button', { name: /settings.workspace.teamDescription/ }),
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'settings.workspace.save' }),
  );
  expect(await screen.findByText('Team login')).toBeVisible();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(session.getUser).toHaveBeenCalledTimes(1);
});

it('does not pause session verification forever when the browser reports offline', async () => {
  onlineManager.setOnline(false);
  session.getUser.mockRejectedValue(new TypeError('offline'));
  useWorkrunStore.setState((state) => ({
    config: { ...state.config!, workspace_mode: 'team' },
  }));
  setup();
  expect(await screen.findByText('Team login')).toBeVisible();
  expect(session.getUser).toHaveBeenCalledTimes(1);
});
