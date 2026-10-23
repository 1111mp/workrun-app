import '@/styles/global.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, Outlet, RouterProvider, createMemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { runDetailsPath } from '@/services/run-center';
import { inspectRunRecord, type RunRecord } from '@/services/run-history';

import { Component as AppsPage } from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => false }));
vi.mock('@/services/process-node', () => ({
  getProcessNodes: async () => [],
  startBackgroundProcessNodeRun: vi.fn(),
  ensurePublishedProcessNode: vi.fn(),
  subscribeProcessNodeRun: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: vi.fn(),
  listRunHistoryPage: vi.fn(),
}));
vi.mock('./project-path', () => ({
  copyProjectPath: vi.fn(),
  openProjectDirectory: vi.fn(),
}));
vi.mock('@/components/app-share-dialog', () => ({
  AppExportButton: () => null,
  AppImportButton: () => null,
}));
vi.mock('@/components/workflow-recovery-notice', () => ({
  WorkflowRecoveryNotice: () => null,
}));

const record: RunRecord = {
  id: 'saved-app-run',
  targetType: 'app',
  targetId: 'report',
  targetName: 'Sales report',
  status: 'completed',
  startedAt: '2026-10-23T01:00:00Z',
  input: {},
  outputView: {
    output: { stdout: '', stderr: '' },
    execution: { exitCode: 0 },
  },
  targetSnapshot: {
    id: 'report',
    name: 'Sales report',
    version: '1',
    inputs: {},
    outputs: {},
  },
  runtime: {},
  events: [],
  spans: [],
};

it.each([false, true])(
  'opens a recent App run only after navigation, including reopening it (cached: %s)',
  async (cached) => {
    await page.viewport(1280, 900);
    vi.mocked(inspectRunRecord).mockResolvedValue(record);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    if (cached) client.setQueryData(['run-history', record.id], record);
    const router = createMemoryRouter(
      [
        {
          element: (
            <>
              <Link to={runDetailsPath(record)} viewTransition>
                Recent App run
              </Link>
              <div
                style={{ viewTransitionName: 'page-content', height: '100vh' }}
              >
                <Outlet />
              </div>
            </>
          ),
          children: [
            { path: '/start', element: <div>Home</div> },
            { path: '/apps', Component: AppsPage },
          ],
        },
      ],
      { initialEntries: ['/start'] },
    );
    const start = document.startViewTransition.bind(document);
    let transitioning = false;
    let finished: Promise<void> | undefined;
    const spy = vi
      .spyOn(document, 'startViewTransition')
      .mockImplementation((callback) => {
        transitioning = true;
        const transition = start(callback);
        finished = transition.finished.then(() => {
          transitioning = false;
        });
        return transition;
      });
    const screen = await render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    let sampling = true;
    const mounts: boolean[] = [];
    const popups = new Set<Element>();
    const positions: number[] = [];
    const sample = () => {
      if (!sampling) return;
      const popup = document.querySelector('[data-slot="drawer-popup"]');
      if (popup) {
        if (!popups.has(popup)) {
          popups.add(popup);
          mounts.push(transitioning);
        }
        positions.push(popup.getBoundingClientRect().top);
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        popups.clear();
        mounts.length = 0;
        positions.length = 0;
        await screen.getByRole('link', { name: 'Recent App run' }).click();
        await expect.element(screen.getByRole('dialog')).toBeVisible();
        await finished;
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(mounts).toEqual([false]);
        expect(popups.size).toBe(1);
        for (let i = 1; i < positions.length; i++)
          expect(
            positions[i]! - positions[i - 1]!,
            JSON.stringify(positions),
          ).toBeLessThanOrEqual(1);
        const closeButton = screen
          .getByRole('button', { name: 'apps.close', exact: true })
          .element() as HTMLButtonElement;
        closeButton.click();
        await expect
          .element(screen.getByRole('dialog'))
          .not.toBeInTheDocument();
        await client.invalidateQueries({
          queryKey: ['run-history', record.id],
        });
        expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull();
      }
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      sampling = false;
      spy.mockRestore();
      await screen.unmount();
      router.dispose();
      client.clear();
    }
  },
);
