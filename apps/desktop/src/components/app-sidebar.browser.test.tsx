import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@workspace/ui/components';
import {
  MemoryRouter,
  Outlet,
  RouterProvider,
  createMemoryRouter,
  useLocation,
} from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page, userEvent } from 'vitest/browser';

import { ConfirmProvider } from '@/components/confirm-dialog';
import zh from '@/locales/zh_CN.json';

const api = vi.hoisted(() => ({
  deleteSession: vi.fn(),
  deleteRun: vi.fn(),
  sessions: true,
  longHistory: false,
  receive: undefined as
    | ((event: import('@/services/assistant').AssistantEvent) => void)
    | undefined,
}));
vi.mock('@/services/assistant', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/assistant')>();
  const list = () =>
    api.sessions
      ? [
          { id: 's1', title: '测试对话', updatedAt: '2026-10-21T00:00:00Z' },
          ...(api.longHistory
            ? Array.from({ length: 49 }, (_, i) => ({
                id: `history-${i}`,
                title: `历史对话 ${i}`,
                updatedAt: '2026-10-20T00:00:00Z',
              }))
            : []),
        ]
      : [];
  return {
    ...actual,
    getAssistantListSnapshot: async () => ({
      workspaceId: 'personal',
      sessionId: '',
      epoch: 'test',
      sequence: 0,
      type: 'list',
      payload: list(),
    }),
    deleteAssistantSession: async (id: string) => {
      await api.deleteSession(id);
      api.sessions = false;
      api.receive?.({
        workspaceId: 'personal',
        sessionId: id,
        epoch: 'test',
        sequence: 1,
        type: 'summary',
        payload: null,
      });
    },
  };
});
vi.mock('@/services/run-history', () => ({
  listRunHistoryPage: async () => ({
    items: [
      {
        id: 'r1',
        targetName: '已完成任务',
        targetType: 'app',
        status: 'completed',
      },
      {
        id: 'r2',
        targetName: '运行中任务',
        targetType: 'app',
        status: 'running',
      },
    ],
  }),
  deleteRunRecord: (id: string) => api.deleteRun(id),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/lib/auth-client', () => ({ createTeamAuthClient: vi.fn() }));
vi.mock('@/stores/workrun.store', () => ({
  useWorkrunStore: {
    getState: () => ({ config: { workspace_mode: 'personal' } }),
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, receive: (event: unknown) => void) => {
    const dispatch: NonNullable<typeof api.receive> = (event) =>
      receive({ payload: event });
    api.receive = dispatch;
    return () => {
      if (api.receive === dispatch) api.receive = undefined;
    };
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        );
      return typeof value === 'string'
        ? value.replace('{{name}}', params?.name ?? '')
        : key;
    },
  }),
}));

import { useAssistantStore } from '@/stores/assistant.store';
const { disposeAssistantEvents } = useAssistantStore.getState();

import { AppSidebar } from './app-sidebar';

beforeEach(() => {
  disposeAssistantEvents();
  useAssistantStore.setState({
    summaries: {},
    listErrors: {},
    sessions: {},
    scopes: {},
    streams: {},
    syncErrors: {},
  });
  vi.stubGlobal('OS_PLATFORM', 'linux');
  api.sessions = true;
  api.longHistory = false;
  api.deleteSession.mockReset();
  api.deleteRun.mockReset();
});

function Location() {
  const location = useLocation();
  return (
    <output data-testid='location' data-location-key={location.key}>
      {location.pathname}
      {location.search}
    </output>
  );
}
async function setup(width = 1100) {
  await page.viewport(width, 800);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start?session=s1']}>
        <ConfirmProvider>
          <SidebarProvider>
            <AppSidebar accountMenu={null} />
            <SidebarInset>
              <SidebarTrigger />
              <Location />
            </SidebarInset>
          </SidebarProvider>
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('keeps icon anchors and row heights stable throughout repeated collapse and expansion', async () => {
  api.longHistory = true;
  const screen = await setup();
  await expect
    .element(screen.getByRole('link', { name: '测试对话', exact: true }))
    .toBeVisible();
  const icon =
    document.querySelector('[aria-label="工作流"] svg') ??
    document.querySelectorAll('[data-slot="sidebar-menu-button"] svg')[3]!;
  const nav = icon.closest('[data-slot="sidebar-menu-button"]')!;
  const origin = icon.getBoundingClientRect();
  const brand = document.querySelector('[aria-label="Workrun"] svg')!;
  const brandOrigin = brand.getBoundingClientRect();
  const brandSamples: { x: number; y: number }[] = [];
  const samples: { x: number; y: number; height: number; left: number }[] = [];
  for (let cycle = 0; cycle < 4; cycle++) {
    const history = document.querySelector('[data-slot="sidebar-content"]')!;
    if (cycle % 2 === 0) {
      history.scrollTop = history.scrollHeight;
      expect(history.scrollTop).toBeGreaterThan(0);
    }
    // Browser automation can delay the click under load. Record through the
    // completed transition before beginning the next collapse/expand cycle.
    let clickedAt = Infinity;
    const recording = new Promise<void>((resolve) => {
      const sample = () => {
        const rect = icon.getBoundingClientRect();
        brandSamples.push(brand.getBoundingClientRect());
        samples.push({
          x: rect.x,
          y: rect.y,
          height: nav.getBoundingClientRect().height,
          left: document.querySelector('main')!.getBoundingClientRect().left,
        });
        if (performance.now() - clickedAt < 280) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    const sampleStart = samples.length;
    await screen
      .getByRole('main')
      .getByRole('button', { name: 'Toggle Sidebar' })
      .click();
    clickedAt = performance.now();
    await recording;
    const positions = samples.slice(sampleStart).map((s) => s.left);
    for (let index = 1; index < positions.length; index++) {
      const delta = positions[index]! - positions[index - 1]!;
      expect(cycle % 2 === 0 ? delta : -delta).toBeLessThanOrEqual(0.5);
    }
  }
  expect(
    Math.max(...samples.map((s) => Math.abs(s.x - origin.x))),
  ).toBeLessThan(1);
  expect(
    Math.max(...samples.map((s) => Math.abs(s.y - origin.y))),
  ).toBeLessThan(1);
  expect(new Set(samples.map((s) => s.height)).size).toBe(1);
  expect(
    Math.max(...brandSamples.map((s) => Math.abs(s.x - brandOrigin.x))),
  ).toBeLessThan(1);
  expect(
    Math.max(...brandSamples.map((s) => Math.abs(s.y - brandOrigin.y))),
  ).toBeLessThan(1);
  expect(samples.every((s) => Number.isFinite(s.left))).toBe(true);
});

it('updates conversation titles and removes deleted rows from native notifications', async () => {
  const screen = await setup();
  await expect
    .element(screen.getByRole('link', { name: '测试对话', exact: true }))
    .toBeVisible();
  api.receive?.({
    workspaceId: 'personal',
    sessionId: 's1',
    epoch: 'test',
    sequence: 1,
    type: 'summary',
    payload: {
      id: 's1',
      title: '推送后的标题',
      updatedAt: '2026-10-21T01:00:00Z',
    },
  });
  await expect
    .element(screen.getByRole('link', { name: '推送后的标题', exact: true }))
    .toBeVisible();
  api.receive?.({
    workspaceId: 'personal',
    sessionId: 's1',
    epoch: 'test',
    sequence: 2,
    type: 'summary',
    payload: null,
  });
  await expect
    .element(screen.getByRole('link', { name: '推送后的标题', exact: true }))
    .not.toBeInTheDocument();
});

it('opens row actions without navigating and confirms deletion of the selected conversation', async () => {
  const screen = await setup();
  await screen
    .getByRole('button', { name: '测试对话的更多操作', exact: true })
    .click();
  expect(document.querySelector('output')!.textContent).toBe(
    '/start?session=s1',
  );
  await screen.getByRole('menuitem', { name: '删除', exact: true }).click();
  expect(api.deleteSession).not.toHaveBeenCalled();
  await screen.getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(() => api.deleteSession.mock.calls).toEqual([['s1']]);
  await expect
    .element(screen.getByRole('link', { name: '测试对话', exact: true }))
    .not.toBeInTheDocument();
  await expect
    .poll(() => document.querySelector('output')!.textContent)
    .toBe('/start');
});

it('disables deletion for active runs and keeps failed deletion available for retry', async () => {
  const screen = await setup();
  await screen
    .getByRole('button', { name: '运行中任务的更多操作', exact: true })
    .click();
  await expect
    .element(screen.getByRole('menuitem', { name: '删除', exact: true }))
    .toHaveAttribute('aria-disabled', 'true');
  await userEvent.keyboard('{Escape}');
  api.deleteRun
    .mockRejectedValueOnce(new Error('删除失败'))
    .mockResolvedValue(undefined);
  await screen
    .getByRole('button', { name: '已完成任务的更多操作', exact: true })
    .click();
  await screen
    .getByRole('menu', { name: '已完成任务的更多操作' })
    .getByRole('menuitem', { name: '删除', exact: true })
    .click();
  await screen.getByRole('button', { name: '删除', exact: true }).click();
  await expect
    .element(screen.getByText('删除失败', { exact: true }))
    .toBeVisible();
  await screen.getByRole('button', { name: '删除', exact: true }).click();
  await expect.poll(() => api.deleteRun.mock.calls.length).toBe(2);
});

it('opens row actions on mobile and closes the drawer after navigation', async () => {
  const screen = await setup(420);
  await screen
    .getByRole('main')
    .getByRole('button', { name: 'Toggle Sidebar' })
    .click();
  await screen
    .getByRole('button', { name: '测试对话的更多操作', exact: true })
    .click();
  await screen.getByRole('menuitem', { name: '打开', exact: true }).click();
  await expect
    .poll(() =>
      document.querySelector('[data-slot="sheet-content"][data-open]'),
    )
    .toBeNull();
});

it('leaves history untouched when deletion is cancelled', async () => {
  const screen = await setup();
  await screen
    .getByRole('button', { name: '测试对话的更多操作', exact: true })
    .click();
  await screen.getByRole('menuitem', { name: '删除', exact: true }).click();
  await screen.getByRole('button', { name: '取消', exact: true }).click();
  await expect
    .element(screen.getByRole('link', { name: '测试对话', exact: true }))
    .toBeVisible();
  expect(api.deleteSession).not.toHaveBeenCalled();
});

it('selects a conversation without also selecting home, and restores home on navigation', async () => {
  const screen = await setup();
  const home = screen.getByRole('link', { name: '首页', exact: true });
  const conversation = screen.getByRole('link', {
    name: '测试对话',
    exact: true,
  });
  await expect.element(conversation).toHaveAttribute('data-active');
  await expect.element(home).not.toHaveAttribute('data-active');
  await home.click();
  await expect.element(home).toHaveAttribute('data-active');
  await expect.element(conversation).not.toHaveAttribute('data-active');
  await conversation.click();
  await expect.element(conversation).toHaveAttribute('data-active');
  await expect.element(home).not.toHaveAttribute('data-active');
});

it('keeps the current conversation mounted when its sidebar link is clicked again', async () => {
  const screen = await setup();
  const location = screen.getByTestId('location');
  const initialKey = location.element().getAttribute('data-location-key');
  const conversation = screen.getByRole('link', {
    name: '测试对话',
    exact: true,
  });
  await expect.element(conversation).toBeVisible();
  await conversation.click();
  await conversation.click();
  await expect
    .element(location)
    .toHaveAttribute('data-location-key', initialKey!);
  await expect.element(location).toHaveTextContent('/start?session=s1');
});

it.each(['row', 'menu'] as const)(
  'opens same-page App history without replaying the page transition (%s)',
  async (entry) => {
    await page.viewport(1280, 900);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        {
          element: (
            <ConfirmProvider>
              <SidebarProvider>
                <AppSidebar accountMenu={null} />
                <SidebarInset>
                  <Outlet />
                  <Location />
                </SidebarInset>
              </SidebarProvider>
            </ConfirmProvider>
          ),
          children: [
            {
              path: '/apps',
              element: <main data-testid='apps-surface'>App library</main>,
            },
          ],
        },
      ],
      { initialEntries: ['/apps'] },
    );
    const transition = vi.spyOn(document, 'startViewTransition');
    const screen = await render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    try {
      const surface = screen.getByTestId('apps-surface').element();
      for (const [name, id] of [
        ['已完成任务', 'r1'],
        ['运行中任务', 'r2'],
      ] as const) {
        if (entry === 'row')
          await screen.getByRole('link', { name, exact: true }).click();
        else {
          await screen
            .getByRole('button', { name: `${name}的更多操作`, exact: true })
            .click();
          await screen
            .getByRole('menu', { name: `${name}的更多操作`, exact: true })
            .getByRole('menuitem', { name: '打开', exact: true })
            .click();
        }
        await expect
          .poll(() => document.querySelector('output')?.textContent)
          .toBe(`/apps?runId=${id}`);
        expect(screen.getByTestId('apps-surface').element()).toBe(surface);
        expect(transition).not.toHaveBeenCalled();
      }
    } finally {
      transition.mockRestore();
      await screen.unmount();
      router.dispose();
      client.clear();
    }
  },
);
