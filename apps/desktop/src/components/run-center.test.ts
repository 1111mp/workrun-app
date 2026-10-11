// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router';
import { expect, it, vi } from 'vitest';

import { RunCenter } from './run-center';

const state = vi.hoisted(() => ({
  requestAction: vi.fn(),
  openRun: vi.fn(),
  setOpen: vi.fn(),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
  useRunWorkspaceStore: Object.assign(
    (select: (value: unknown) => unknown) => select(state),
    { getState: () => state },
  ),
}));
vi.mock('@/services/run-history', () => ({
  listActiveRuns: async () => [
    {
      id: 'weather-run',
      targetId: 'weather',
      targetType: 'workflow',
      targetName: 'Weather workflow',
      status: 'waiting_for_input',
      startedAt: '2026-10-11T00:00:00Z',
    },
    {
      id: 'app-run',
      targetId: 'report',
      targetType: 'app',
      targetName: 'Report App',
      status: 'running',
      startedAt: '2026-10-11T00:00:00Z',
    },
  ],
  listPendingActions: async () => [
    {
      id: 'weather-question',
      runId: 'weather-run',
      kind: 'ask_user_question',
      status: 'pending',
      payload: {},
      createdAt: '2026-10-11T00:01:00Z',
    },
  ],
}));
vi.mock('@/services/process-node', () => ({
  cancelBackgroundProcessNodeRun: vi.fn(),
}));
vi.mock('@/services/workflow', () => ({
  cancelBackgroundWorkflowRun: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// Keep this a navigation test: overlay animations and tab primitives have
// separate ownership, while the actual Run Center event handlers stay intact.
vi.mock('@workspace/ui/components', () => {
  const box = ({ children, ...props }: { children?: ReactNode }) =>
    createElement('div', props, children);
  const button = ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    variant?: string;
    size?: string;
  }) => createElement('button', props, children);
  return {
    Badge: box,
    Button: button,
    DrawerContent: box,
    DrawerDescription: box,
    DrawerHeader: box,
    DrawerTitle: box,
    ScrollArea: box,
    Drawer: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open
        ? createElement('div', { 'data-test': 'run-center' }, children)
        : null,
    Tabs: ({ children }: { children: ReactNode }) =>
      createElement('div', null, children),
    TabsList: box,
    TabsTrigger: button,
    TabsContent: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => (value === 'all' ? createElement('div', null, children) : null),
  };
});
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
function Location() {
  const location = useLocation();
  return createElement('output', null, location.pathname + location.search);
}

it('shows each task once and opens its existing run in the corresponding detail page', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: ['/workflows'] },
            createElement(RunCenter),
            createElement(Location),
          ),
        ),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const open = () =>
      (
        host.querySelector('[aria-label="runCenter.open"]') as HTMLButtonElement
      ).click();
    await act(async () => open());
    const taskButton = (name: string) =>
      Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes(name),
      )!;
    expect(
      Array.from(host.querySelectorAll('button')).filter((button) =>
        button.textContent?.includes('Weather workflow'),
      ),
    ).toHaveLength(1);
    await act(async () => taskButton('Weather workflow').click());
    expect(host.querySelector('output')?.textContent).toBe(
      '/workflows/weather?runId=weather-run&live=true',
    );
    expect(state.requestAction).toHaveBeenCalledWith('weather-question');
    expect(state.openRun).not.toHaveBeenCalled();
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(host.querySelector('[data-test="run-center"]')).toBeNull();
    await act(async () => open());
    await act(async () => taskButton('Report App').click());
    expect(host.querySelector('output')?.textContent).toBe(
      '/apps?runId=app-run',
    );
    expect(state.openRun).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
  }
});
