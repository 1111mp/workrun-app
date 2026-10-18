import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Button, SidebarProvider } from '@workspace/ui/components';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { WorkflowEditorToolbar } from '@/components/workflow-editor/workflow-editor-toolbar';
import zh from '@/locales/zh_CN.json';

vi.mock('@/services/assistant', () => ({
  listAssistantSessions: async () => [],
  deleteAssistantSession: vi.fn(),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (state: unknown) => unknown) =>
    select({ config: { workspace_mode: 'personal' } }),
}));
vi.mock('@/services/workflow', () => ({
  getWorkflowCapabilities: async () => [
    {
      id: 'report',
      document: {
        settings: {
          name: '每周工作报告',
          description: '汇总本周工作进展，生成一份可分享的周报。',
        },
      },
    },
  ],
}));
vi.mock('@/services/process-node', () => ({
  getProcessNodes: async () => [
    {
      definition: {
        id: 'invoice',
        name: '发票汇总',
        description: '整理发票目录，导出 Excel 汇总表。',
        kind: 'workflow',
      },
      installStatus: 'installed',
    },
  ],
  startBackgroundProcessNodeRun: vi.fn(),
  ensurePublishedProcessNode: vi.fn(),
}));
vi.mock('@/services/run-history', () => ({
  deleteRunRecord: vi.fn(),
  listRunHistoryPage: async () => ({
    items: [
      {
        id: 'r1',
        targetId: 'report',
        targetType: 'workflow',
        targetName: '上周工作报告',
        status: 'completed',
      },
    ],
  }),
}));
vi.mock('@/components/run-center', () => ({ RunCenter: () => null }));
vi.mock('@/components/run-event-tracker', () => ({
  RunEventTracker: () => null,
}));
vi.mock('@/lib/constant', () => ({ isTeamMode: () => false }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        ) ?? key,
  }),
}));

import { ConfirmProvider } from '@/components/confirm-dialog';
import { WorkspaceFrame } from '@/components/workspace-frame';

import { Component as StartPage } from './library';

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
});

async function renderEntry() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <ConfirmProvider>
          <WorkspaceFrame accountMenu={<span>个人账户 · 设置</span>}>
            <StartPage />
          </WorkspaceFrame>
        </ConfirmProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('renders the inset shell and collapses the navigation without losing the entry', async () => {
  await page.viewport(1280, 900);
  const screen = await renderEntry();
  await expect
    .element(screen.getByText('发票汇总', { exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
  await screen
    .getByRole('main')
    .getByRole('button', { name: 'Toggle Sidebar', exact: true })
    .click();
  await expect
    .element(screen.getByRole('heading', { name: '今天想完成什么？' }))
    .toBeVisible();
  await expect
    .element(screen.getByText('个人工作区', { exact: true }))
    .not.toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: 'Workrun', exact: true }))
    .toBeVisible();
  await expect
    .poll(() => {
      const frame = document
        .querySelector('[data-slot="sidebar-wrapper"]')!
        .getBoundingClientRect();
      const content = document
        .querySelector('[data-slot="sidebar-inset"]')!
        .getBoundingClientRect();
      // The visible rail includes the gap before the inset, not just the fixed sidebar container.
      const visibleCenter = (frame.left + content.left) / 2;
      const buttons = [
        ...document.querySelectorAll('[data-slot="sidebar-menu-button"]'),
      ].filter((button) => button.getBoundingClientRect().width > 0);
      return Math.max(
        ...buttons.map((button) => {
          const icon = button.querySelector('svg')!.getBoundingClientRect();
          return Math.abs(icon.left + icon.width / 2 - visibleCenter);
        }),
      );
    })
    .toBeLessThanOrEqual(1);
  await screen
    .getByRole('main')
    .getByRole('button', { name: 'Toggle Sidebar', exact: true })
    .click();
  await expect
    .element(screen.getByText('个人工作区', { exact: true }))
    .toBeVisible();
});

it('keeps the composer and capability actions usable on a narrow window', async () => {
  await page.viewport(390, 844);
  const screen = await renderEntry();
  await expect
    .element(screen.getByText('发票汇总', { exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it('gives the workflow editor the full viewport without an empty title strip', async () => {
  await page.viewport(1280, 900);
  const screen = await render(
    <MemoryRouter initialEntries={['/workflows/report']}>
      <ConfirmProvider>
        <WorkspaceFrame accountMenu={null}>
          <div data-testid='editor-surface' className='size-full'>
            Workflow editor
          </div>
        </WorkspaceFrame>
      </ConfirmProvider>
    </MemoryRouter>,
  );
  const rect = screen
    .getByTestId('editor-surface')
    .element()
    .getBoundingClientRect();
  expect(rect.width).toBe(1280);
  expect(rect.top).toBe(0);
  expect(rect.bottom).toBe(900);
  expect(document.querySelector('[data-slot="sidebar-wrapper"]')).toBeNull();
});

it.each([
  { open: true, readOnly: false, padding: 0 },
  { open: false, readOnly: false, padding: 80 },
  { open: true, readOnly: true, padding: 80 },
])(
  'integrates dragging and macOS controls into the toolbar (open=$open, readOnly=$readOnly)',
  async ({ open, readOnly, padding }) => {
    await page.viewport(1280, 900);
    const action = vi.fn();
    const screen = await render(
      <SidebarProvider defaultOpen={open} className='h-dvh min-h-0'>
        <div className='flex-1'>
          <WorkflowEditorToolbar readOnly={readOnly}>
            <Button onClick={action}>Save workflow</Button>
            <input aria-label='Workflow name' />
          </WorkflowEditorToolbar>
        </div>
      </SidebarProvider>,
    );
    const toolbar = document.querySelector(
      '[data-slot="workflow-editor-toolbar"]',
    )!;
    const rect = toolbar.getBoundingClientRect();
    expect(rect.top).toBe(0);
    expect(rect.height).toBe(56);
    expect(toolbar.hasAttribute('data-tauri-drag-region')).toBe(true);
    expect(parseFloat(getComputedStyle(toolbar).paddingLeft)).toBe(padding);
    expect(
      screen
        .getByRole('button', { name: 'Save workflow' })
        .element()
        .hasAttribute('data-tauri-drag-region'),
    ).toBe(false);
    await screen.getByRole('button', { name: 'Save workflow' }).click();
    expect(action).toHaveBeenCalledTimes(1);
    await screen
      .getByRole('textbox', { name: 'Workflow name' })
      .fill('File analysis');
    await expect
      .element(screen.getByRole('textbox', { name: 'Workflow name' }))
      .toHaveValue('File analysis');
  },
);
