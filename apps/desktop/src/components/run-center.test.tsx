import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  render as renderComponent,
  type RenderResult,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
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
  const box = ({ children, ...props }: { children?: ReactNode }) => (
    <div {...props}>{children}</div>
  );
  const button = ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: {
    children?: ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>;
  return {
    Badge: box,
    Button: button,
    DrawerContent: box,
    DrawerDescription: box,
    DrawerHeader: box,
    DrawerTitle: box,
    ScrollArea: box,
    Drawer: ({ open, children }: { open: boolean; children: ReactNode }) =>
      open ? <div data-test='run-center'>{children}</div> : null,
    Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    TabsList: box,
    TabsTrigger: button,
    TabsContent: ({
      value,
      children,
    }: {
      value: string;
      children: ReactNode;
    }) => (value === 'all' ? <div>{children}</div> : null),
  };
});

function Location() {
  const location = useLocation();
  return <output>{location.pathname + location.search}</output>;
}

function RouteButtons() {
  const navigate = useNavigate();
  return (
    <nav>
      {[
        '/apps',
        '/apps/report',
        '/apps/new',
        '/workflows',
        '/workflows/weather',
        '/workflows/new',
        '/runs',
        '/settings',
        '/profile',
        '/skills',
        '/mcp-servers',
      ].map((path) => (
        <button key={path} onClick={() => void navigate(path)}>
          {path}
        </button>
      ))}
    </nav>
  );
}

it('shows Run Center only on App and Workflow lists and hides its drawer on other pages', async () => {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/apps']}>
          <RunCenter />
          <Location />
          <RouteButtons />
        </MemoryRouter>
      </QueryClientProvider>,
      { container: host },
    );
    for (const path of [
      '/apps',
      '/apps/report',
      '/apps/new',
      '/workflows',
      '/workflows/weather',
      '/workflows/new',
      '/runs',
      '/settings',
      '/profile',
      '/skills',
      '/mcp-servers',
    ]) {
      await act(async () =>
        Array.from(host.querySelectorAll('nav button'))
          .find((button) => button.textContent === path)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true })),
      );
      expect(host.querySelector('output')?.textContent).toBe(path);
      const bar = host.querySelector<HTMLButtonElement>(
        '[aria-label="runCenter.open"]',
      );
      if (['/apps', '/workflows'].includes(path)) {
        expect(bar).not.toBeNull();
        await user.click(bar!);
        expect(host.querySelector('[data-test="run-center"]')).not.toBeNull();
      } else {
        expect(bar).toBeNull();
        expect(host.querySelector('[data-test="run-center"]')).toBeNull();
      }
    }
  } finally {
    rendered.unmount();
    client.clear();
    host.remove();
  }
});

it('shows each task once and opens its existing run in the corresponding detail page', async () => {
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const host = document.createElement('div');
  let rendered!: Pick<RenderResult, 'rerender' | 'unmount'>;
  try {
    rendered = renderComponent(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/workflows']}>
          <RunCenter />
          <Location />
          <RouteButtons />
        </MemoryRouter>
      </QueryClientProvider>,
      { container: host },
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
    await user.click(taskButton('Weather workflow'));
    expect(host.querySelector('output')?.textContent).toBe(
      '/workflows/weather?runId=weather-run&live=true',
    );
    expect(state.requestAction).toHaveBeenCalledWith('weather-question');
    expect(state.openRun).not.toHaveBeenCalled();
    expect(state.setOpen).toHaveBeenCalledWith(false);
    expect(host.querySelector('[data-test="run-center"]')).toBeNull();
    expect(host.querySelector('[aria-label="runCenter.open"]')).toBeNull();
    await user.click(
      Array.from(host.querySelectorAll<HTMLButtonElement>('nav button')).find(
        (button) => button.textContent === '/apps',
      )!,
    );
    await act(async () => open());
    await user.click(taskButton('Report App'));
    expect(host.querySelector('output')?.textContent).toBe(
      '/apps?runId=app-run',
    );
    expect(state.openRun).not.toHaveBeenCalled();
  } finally {
    rendered.unmount();
    client.clear();
    host.remove();
  }
});
