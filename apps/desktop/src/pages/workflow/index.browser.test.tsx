import '@/styles/global.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

vi.mock('@/components', async () => import('@/components/workflow-editor'));
vi.mock('@/components/run-center', () => ({ RunCenter: () => null }));
vi.mock('@/components/run-event-tracker', () => ({
  RunEventTracker: () => null,
}));
vi.mock('@/services/assistant', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/assistant')>()),
  getAssistantListSnapshot: async () => ({
    workspaceId: 'personal',
    sessionId: '',
    epoch: 'test',
    sequence: 0,
    type: 'list',
    payload: [],
  }),
}));
vi.mock('@/hooks', () => ({ useUnsavedChangesGuard: () => {} }));
vi.mock('@/lib/auth-client', () => ({ createTeamAuthClient: vi.fn() }));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => false }));
vi.mock('@tauri-apps/api/event', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/event')>()),
  listen: async () => () => {},
}));
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/services/cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/cmd')>()),
  getModelCatalog: async () => [],
}));
vi.mock('@/services/evaluation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/evaluation')>()),
  latestEvaluationRunsForWorkflowSnapshot: async () => [],
  getEvaluationQualityGate: async () => null,
}));
vi.mock('@/services/workflow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/workflow')>();
  return {
    ...actual,
    getWorkflow: async () => ({
      id: 'weather',
      document: actual.createWorkflowDocument(),
    }),
    listChatSessions: async () => [],
    listChatSessionHistory: async () => [],
    listChatSessionTurns: async () => [],
    subscribeWorkflowRun: async () => () => {},
  };
});
vi.mock('@/services/run-history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/run-history')>()),
  listActiveRuns: async () => [],
  listPendingActions: async () => [],
  listRunHistoryPage: async () => ({
    items: [
      {
        id: 'old',
        targetType: 'workflow',
        targetId: 'weather',
        targetName: 'Recent workflow run',
        status: 'completed',
      },
    ],
  }),
  inspectRunRecord: async (id: string) => ({
    id,
    targetType: 'workflow',
    targetId: 'weather',
    runtime: { threadId: 'thread-old' },
    events: [],
    spans: [],
    input: {},
    status: 'completed',
  }),
}));

import { ConfirmProvider } from '@/components/confirm-dialog';
import { WorkspaceFrame } from '@/components/workspace-frame';
import { inspectRunRecord } from '@/services/run-history';
import { getWorkflow } from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores/workflow-run.store';

import { WorkflowRoute as Component } from './workflow-route';

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
  const store = useWorkflowRunStore.getState();
  store.resetRunView();
  store.setRunPanelOpen(false);
  store.setShowRunOutput(false);
});

it.each([
  { previouslyOpen: false, menu: false, cached: false },
  { previouslyOpen: true, menu: false, cached: false },
  { previouslyOpen: false, menu: true, cached: false },
  { previouslyOpen: true, menu: true, cached: false },
  { previouslyOpen: false, menu: false, cached: true },
  { previouslyOpen: true, menu: false, cached: true },
])(
  'opens the output drawer once after navigating from recent runs ($previouslyOpen, menu=$menu, cached=$cached)',
  async ({ previouslyOpen, menu, cached }) => {
    await page.viewport(1280, 900);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cached) {
      client.setQueryData(
        ['workflows', 'weather', 'draft'],
        await getWorkflow('weather'),
      );
      client.setQueryData(
        ['run-history', 'old'],
        await inspectRunRecord('old'),
      );
    }
    const router = createMemoryRouter(
      [
        {
          Component: () => (
            <WorkspaceFrame accountMenu={null}>
              <Outlet />
            </WorkspaceFrame>
          ),
          children: [
            { path: '/start', element: <div>Home</div> },
            { path: '/workflows/:id', Component },
          ],
        },
      ],
      { initialEntries: ['/start'] },
    );
    useWorkflowRunStore.getState().setRunPanelOpen(previouslyOpen);
    const changes: boolean[] = [];
    const openedDuringTransition: boolean[] = [];
    let transitioning = false;
    const startViewTransition = document.startViewTransition.bind(document);
    const transitionSpy = vi
      .spyOn(document, 'startViewTransition')
      .mockImplementation((callback) => {
        transitioning = true;
        const transition = startViewTransition(callback);
        void transition.finished.then(
          () => {
            transitioning = false;
          },
          () => {
            transitioning = false;
          },
        );
        return transition;
      });
    const positions: number[] = [];
    const popups = new Set<Element>();
    const mountedDuringTransition: boolean[] = [];
    let sampling = true;
    const sample = () => {
      if (!sampling) return;
      const popup = document.querySelector('[data-slot="drawer-popup"]');
      if (popup) {
        if (!popups.has(popup)) {
          popups.add(popup);
          mountedDuringTransition.push(transitioning);
        }
        positions.push(popup.getBoundingClientRect().left);
      }
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    const stop = useWorkflowRunStore.subscribe((state, previous) => {
      if (state.runPanelOpen !== previous.runPanelOpen) {
        changes.push(state.runPanelOpen);
        if (state.runPanelOpen) openedDuringTransition.push(transitioning);
      }
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <ConfirmProvider>
          <RouterProvider router={router} />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    try {
      if (menu) {
        await screen.getByRole('button', { name: 'sidebar.more' }).click();
        await screen.getByRole('menuitem', { name: 'sidebar.open' }).click();
      } else {
        await screen.getByRole('link', { name: 'Recent workflow run' }).click();
      }
      await expect.element(screen.getByRole('dialog')).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(changes).toEqual(previouslyOpen ? [] : [true]);
      expect(transitionSpy).toHaveBeenCalledTimes(1);
      expect(openedDuringTransition).not.toContain(true);
      expect(mountedDuringTransition).toEqual([false]);
      expect(popups.size).toBe(1);
      for (let i = 1; i < positions.length; i++) {
        expect(
          positions[i]! - positions[i - 1]!,
          JSON.stringify(positions),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        document.querySelectorAll('[data-slot="drawer-popup"]'),
      ).toHaveLength(1);
    } finally {
      transitionSpy.mockRestore();
      sampling = false;
      stop();
      await screen.unmount();
      router.dispose();
      client.clear();
    }
  },
);
