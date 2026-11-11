import { fireEvent, render, screen } from '@testing-library/react';
import { useForm } from 'react-hook-form';
import { beforeEach, expect, it, vi } from 'vitest';

import en from '@/locales/en.json';

import { ModelProfilesSettings } from './model-profiles-settings';
import type { SettingsForm } from './settings-schema';

const state = vi.hoisted(() => ({
  config: {
    workspace_mode: 'team' as WorkspaceMode,
    team: { server_url: 'https://team.example' },
  },
  serverError: null as string | null,
  isFetching: false,
  refresh: vi.fn(async () => {}),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) => select(state),
}));
vi.mock('@/hooks/use-model-catalog', () => ({
  useModelCatalog: () => ({
    serverError: state.serverError,
    isFetching: state.isFetching,
    refresh: state.refresh,
    data: [
      { id: 'team-model', name: 'Team model', model: 'fast', provider: 'team' },
    ],
  }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)[part],
          en,
        ),
  }),
}));
function Settings() {
  const form = useForm<SettingsForm>({
    defaultValues: {
      provider_credentials: [
        {
          provider: 'open_ai',
          apiKey: 'personal-key',
          baseUrl: '',
          headers: [],
        },
      ],
      summary_model_profile_id: '',
    },
  });
  return <ModelProfilesSettings form={form} />;
}
beforeEach(() => {
  state.config.workspace_mode = 'team';
  state.serverError = null;
  state.isFetching = false;
  vi.clearAllMocks();
});
it('allows direct provider credentials in Team mode while retaining summary selection', () => {
  render(<Settings />);
  expect(
    screen.getByText(en.settings.models.teamDescription),
  ).toBeInTheDocument();
  expect(screen.getByDisplayValue('personal-key')).toBeInTheDocument();
  expect(screen.getByText(en.settings.models.summaryModel)).toBeInTheDocument();
});
it('keeps personal provider credentials available in Personal mode', () => {
  state.config.workspace_mode = 'personal';
  render(<Settings />);
  expect(screen.getByDisplayValue('personal-key')).toBeInTheDocument();
});

it('shows Server address and models, and refreshes on demand', () => {
  render(<Settings />);
  expect(screen.getByText('https://team.example')).toBeInTheDocument();
  expect(screen.getByText('Team model · fast')).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: en.settings.models.serverRefresh }),
  );
  expect(state.refresh).toHaveBeenCalledTimes(1);
});
it('shows Server failure without hiding direct credentials', () => {
  state.serverError = 'HTTP 503';
  render(<Settings />);
  expect(screen.getByText('HTTP 503')).toBeInTheDocument();
  expect(
    screen.getByText(en.settings.models.serverUnavailable),
  ).toBeInTheDocument();
  expect(screen.getByDisplayValue('personal-key')).toBeInTheDocument();
});
it('disables refresh during an active request', () => {
  state.isFetching = true;
  render(<Settings />);
  expect(
    screen.getByRole('button', { name: en.settings.models.serverLoading }),
  ).toBeDisabled();
});
