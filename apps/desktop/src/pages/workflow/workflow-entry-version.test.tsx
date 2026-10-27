import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { getPublishedWorkflow, getWorkflow } from '@/services/workflow';

import { Component } from './index';

const state = vi.hoisted(() => ({ workspace: 'team' }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components', () => ({
  WorkflowEditor: ({ workflow, readOnly }: any) => (
    <p>
      {workflow.document.settings.name}:{String(readOnly)}
    </p>
  ),
}));
vi.mock('@xyflow/react', () => ({
  ReactFlowProvider: ({ children }: any) => children,
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (selector: any) =>
    selector({ config: { workspace_mode: state.workspace } }),
  useWorkflowRunStore: { getState: vi.fn() },
}));
vi.mock('@/services/workflow', () => ({
  getWorkflow: vi.fn(),
  getPublishedWorkflow: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  listActiveRuns: vi.fn().mockResolvedValue([]),
  inspectRunRecord: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getWorkflow).mockResolvedValue({
    id: 'one',
    document: { settings: { name: 'Draft' } },
  } as any);
  vi.mocked(getPublishedWorkflow).mockResolvedValue({
    id: 'one',
    document: { settings: { name: 'Release' } },
  } as any);
});

it.each([
  ['team', '?run=true', 'Release:true'],
  ['team', '?live=true', 'Release:true'],
  ['team', '', 'Draft:false'],
  ['personal', '?run=true', 'Draft:false'],
  ['team', '?catalog=true', 'Release:true'],
])('resolves %s workflow entry %s', async (workspace, query, expected) => {
  state.workspace = workspace;
  const router = createMemoryRouter([{ path: '/workflows/:id', Component }], {
    initialEntries: [`/workflows/one${query}`],
  });
  const view = render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  try {
    expect(await screen.findByText(expected)).toBeInTheDocument();
    if (expected.startsWith('Release')) {
      expect(getWorkflow).not.toHaveBeenCalled();
    } else {
      expect(getPublishedWorkflow).not.toHaveBeenCalled();
    }
  } finally {
    view.unmount();
  }
});
