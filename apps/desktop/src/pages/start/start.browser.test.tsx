import { Button, SidebarProvider } from '@workspace/ui/components';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { WorkflowEditorToolbar } from '@/components/workflow-editor/workflow-editor-toolbar';

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
  deleteAssistantSession: vi.fn(),
}));
vi.mock('@/lib/auth-client', () => ({ createTeamAuthClient: vi.fn() }));
vi.mock('@/stores/workrun.store', () => ({
  useWorkrunStore: {
    getState: () => ({ config: { workspace_mode: 'personal' } }),
  },
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));
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
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { ConfirmProvider } from '@/components/confirm-dialog';
import { WorkspaceFrame } from '@/components/workspace-frame';

beforeEach(() => {
  vi.stubGlobal('OS_PLATFORM', 'darwin');
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
  { open: false, readOnly: false, padding: 0 },
  { open: true, readOnly: true, padding: 0 },
])(
  'keeps toolbar dragging independent of sidebar and read-only state (open=$open, readOnly=$readOnly)',
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
    // The surrounding workspace/editor owns window-control spacing. The
    // toolbar must not duplicate it when the sidebar or access mode changes.
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
