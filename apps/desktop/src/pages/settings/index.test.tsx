import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UseFormReturn } from 'react-hook-form';
import { beforeEach, expect, it, vi } from 'vitest';

import type { SettingsForm } from './settings-schema';

const state = vi.hoisted(() => ({
  config: undefined as IWorkrunConfig | undefined,
  teamUser: undefined as { id: string } | undefined,
  updateConfig: vi.fn(async (_patch: Partial<IWorkrunConfig>) => {}),
  confirm: vi.fn(async () => {}),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (value: typeof state) => unknown) => select(state),
}));
vi.mock('@/lib/confirm-context', () => ({ useConfirm: () => state.confirm }));
vi.mock('@/lib/utils', () => ({ applyPendingTheme: vi.fn(async () => {}) }));
vi.mock('@/services/cmd', () => ({ restartApp: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn() },
  }),
}));
vi.mock('./about-settings', () => ({ AboutSettings: () => null }));
vi.mock('./appearance-settings', () => ({ AppearanceSettings: () => null }));
vi.mock('./general-settings', () => ({ GeneralSettings: () => null }));
vi.mock('./workspace-settings', () => ({ WorkspaceSettings: () => null }));
vi.mock('./logger-settings', () => ({
  LoggerSettings: ({ form }: { form: UseFormReturn<SettingsForm> }) => (
    <>
      <input aria-label='OTLP endpoint' {...form.register('otlp_endpoint')} />
      <input
        aria-label='OTLP content'
        type='checkbox'
        {...form.register('otlp_capture_content')}
      />
    </>
  ),
}));
vi.mock('./model-profiles-settings', () => ({
  ModelProfilesSettings: ({ form }: { form: UseFormReturn<SettingsForm> }) => (
    <input
      aria-label='Provider key'
      {...form.register('provider_credentials.0.apiKey')}
    />
  ),
}));

import { Component } from './index';

const config = (key: string): IWorkrunConfig => ({
  workspace_mode: 'personal',
  locale: 'en',
  theme: 'system',
  otlp_endpoint: 'http://127.0.0.1:4317',
  provider_credentials: [{ provider: 'gemini', apiKey: key, headers: [] }],
});

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
  state.config = config('saved-key');
  state.teamUser = undefined;
  vi.clearAllMocks();
});

it('waits for hydration and does not save blank provider defaults', async () => {
  state.config = undefined;
  const view = render(<Component />);
  expect(screen.queryByLabelText('Provider key')).not.toBeInTheDocument();
  state.config = config('hydrated-key');
  view.rerender(<Component />);
  expect(screen.getByLabelText('Provider key')).toHaveValue('hydrated-key');
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), {
    target: { value: 'http://127.0.0.1:4318' },
  });
  await waitFor(() =>
    expect(state.updateConfig).toHaveBeenCalledWith({
      otlp_endpoint: 'http://127.0.0.1:4318',
    }),
  );
  expect(
    state.updateConfig.mock.calls.every(
      ([patch]) => !('provider_credentials' in patch),
    ),
  ).toBe(true);
});

it('a telemetry-only edit never writes credential or unrelated settings', async () => {
  render(<Component />);
  expect(state.updateConfig).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), {
    target: { value: 'http://127.0.0.1:4318' },
  });
  await waitFor(() =>
    expect(state.updateConfig).toHaveBeenCalledWith({
      otlp_endpoint: 'http://127.0.0.1:4318',
    }),
  );
  expect(screen.getByLabelText('Provider key')).toHaveValue('saved-key');
});

it('reloads the form when switching workspace/account instead of saving old credentials', async () => {
  const view = render(<Component />);
  state.config = {
    ...config('team-key'),
    workspace_mode: 'team',
    team: { server_url: 'https://team.example' },
  };
  state.teamUser = { id: 'user-one' };
  view.rerender(<Component />);
  expect(screen.getByLabelText('Provider key')).toHaveValue('team-key');
  state.config = {
    ...state.config,
    provider_credentials: [
      { provider: 'gemini', apiKey: 'other-user-key', headers: [] },
    ],
  };
  state.teamUser = { id: 'user-two' };
  view.rerender(<Component />);
  expect(screen.getByLabelText('Provider key')).toHaveValue('other-user-key');
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), {
    target: { value: 'http://127.0.0.1:4318' },
  });
  await waitFor(() =>
    expect(state.updateConfig).toHaveBeenCalledWith({
      otlp_endpoint: 'http://127.0.0.1:4318',
    }),
  );
});

it('still saves an explicitly edited or cleared key', async () => {
  render(<Component />);
  fireEvent.change(screen.getByLabelText('Provider key'), {
    target: { value: '' },
  });
  await waitFor(() => expect(state.updateConfig).toHaveBeenCalled());
  expect(
    state.updateConfig.mock.calls.at(-1)?.[0].provider_credentials?.[0].apiKey,
  ).toBe('');
});

it('discards pending validation when the workspace changes', async () => {
  const view = render(<Component />);
  fireEvent.change(screen.getByLabelText('Provider key'), {
    target: { value: 'old-scope-edit' },
  });
  state.config = {
    ...config('team-key'),
    workspace_mode: 'team',
    team: { server_url: 'https://team.example' },
  };
  state.teamUser = { id: 'user-one' };
  view.rerender(<Component />);
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), {
    target: { value: 'http://127.0.0.1:4318' },
  });
  await waitFor(() =>
    expect(state.updateConfig).toHaveBeenCalledWith({
      otlp_endpoint: 'http://127.0.0.1:4318',
    }),
  );
  expect(
    state.updateConfig.mock.calls.every(
      ([patch]) => !('provider_credentials' in patch),
    ),
  ).toBe(true);
});

it('content capture changes only the explicit telemetry setting', async () => {
  render(<Component />);
  fireEvent.click(screen.getByLabelText('OTLP content'));
  await waitFor(() =>
    expect(state.updateConfig).toHaveBeenCalledWith({
      otlp_capture_content: true,
    }),
  );
  expect(screen.getByLabelText('Provider key')).toHaveValue('saved-key');
});
