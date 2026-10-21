import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), getUser: vi.fn() }));
vi.mock('@/routes', () => ({ router: { navigate: navigation.navigate } }));
vi.mock('@/services/session', () => ({
  getTeamUser: navigation.getUser,
  normalizeServerUrl: (url: string) => url,
}));
vi.mock('@/lib/avatar', () => ({ localProfileAvatarUrl: (id: string) => id }));
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
    config: {},
    setTeamUser: vi.fn(),
    updateConfig: async (patch) => {
      store.setState((s) => ({ config: { ...s.config, ...patch } }));
    },
  }));
  return { useWorkrunStore: store };
});

import { useWorkrunStore } from '@/stores';

import { OnboardingPage } from './onboarding';

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
  vi.clearAllMocks();
  useWorkrunStore.setState({
    config: {
      workspace_mode: 'team',
      onboarding_completed: false,
      team: { server_url: 'http://localhost:3000' },
    } as IWorkrunConfig,
  });
});

afterEach(() => vi.unstubAllGlobals());

function Entry() {
  const completed = useWorkrunStore((s) => s.config?.onboarding_completed);
  return completed ? <p>Routed workspace</p> : <OnboardingPage />;
}

it.each(['personal', 'team'] as const)(
  'keeps %s onboarding visible until its destination is ready',
  async (mode) => {
    let finishNavigation!: () => void;
    navigation.navigate.mockReturnValue(
      new Promise<void>((resolve) => {
        finishNavigation = resolve;
      }),
    );
    navigation.getUser.mockResolvedValue(null);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Entry />
      </QueryClientProvider>,
    );
    fireEvent.click(
      screen.getByRole('button', { name: `onboarding.${mode}.action` }),
    );
    if (mode === 'personal') {
      fireEvent.change(screen.getByLabelText('onboarding.profile.name'), {
        target: { value: 'Yifan' },
      });
      fireEvent.click(
        screen.getAllByRole('button', {
          name: 'onboarding.profile.avatarOption',
        })[1]!,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding.profile.continue' }),
      );
    } else {
      fireEvent.click(
        screen.getByRole('button', { name: 'onboarding.team.connect' }),
      );
    }
    await waitFor(() =>
      expect(navigation.navigate).toHaveBeenCalledWith(
        mode === 'personal' ? '/start' : '/login',
        { replace: true },
      ),
    );
    // The App must not reveal its previous login route during lazy navigation.
    expect(useWorkrunStore.getState().config?.onboarding_completed).toBe(false);
    expect(screen.queryByText('Routed workspace')).not.toBeInTheDocument();
    expect(useWorkrunStore.getState().config?.workspace_mode).toBe(mode);
    if (mode === 'personal') {
      expect(useWorkrunStore.getState().config?.local_profile).toEqual({
        display_name: 'Yifan',
        avatar_id: 'workrun-02',
      });
    }
    await act(async () => {
      finishNavigation();
    });
    expect(await screen.findByText('Routed workspace')).toBeVisible();
  },
);
