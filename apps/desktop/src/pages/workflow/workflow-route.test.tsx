import { act, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router';
import { expect, it, vi } from 'vitest';

import { NewWorkflowRoute, WorkflowRoute } from './workflow-route';

const modules = vi.hoisted(() => {
  let releaseDetail!: () => void;
  let releaseNew!: () => void;
  return {
    detail: new Promise<void>((resolve) => {
      releaseDetail = resolve;
    }),
    create: new Promise<void>((resolve) => {
      releaseNew = resolve;
    }),
    releaseDetail: () => releaseDetail(),
    releaseNew: () => releaseNew(),
  };
});
vi.mock('@/pages/workflow', async () => {
  await modules.detail;
  return { Component: () => <p>Loaded workflow editor</p> };
});
vi.mock('@/pages/workflows/new', async () => {
  await modules.create;
  return { Component: () => <p>Loaded new workflow editor</p> };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

it.each([
  [
    '/workflows/example',
    WorkflowRoute,
    modules.releaseDetail,
    'Loaded workflow editor',
  ],
  [
    '/workflows/new',
    NewWorkflowRoute,
    modules.releaseNew,
    'Loaded new workflow editor',
  ],
] as const)(
  'commits %s and shows feedback before the first editor import resolves',
  async (path, Component, release, content) => {
    const router = createMemoryRouter([
      {
        Component: () => (
          <>
            <Link to={path}>Open workflow</Link>
            <Outlet />
          </>
        ),
        children: [
          { path: '/', element: <p>Previous page</p> },
          { path, Component },
        ],
      },
    ]);
    const view = render(<RouterProvider router={router} />);
    try {
      fireEvent.click(screen.getByRole('link', { name: 'Open workflow' }));
      expect(
        await screen.findByRole('status', { name: 'workflowEditor.loading' }),
      ).toHaveAttribute('aria-busy', 'true');
      expect(router.state.location.pathname).toBe(path);
      expect(screen.queryByText('Previous page')).toBeNull();
      expect(screen.queryByText(content)).toBeNull();
      await act(async () => release());
      expect(await screen.findByText(content)).toBeVisible();
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      view.unmount();
      router.dispose();
    }
  },
);
