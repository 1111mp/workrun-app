import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import '@/styles/global.css';
import zh from '@/locales/zh_CN.json';
import {
  compareWorkflowRevisions,
  type WorkflowComparison,
} from '@/services/workflow-revision';

import { WorkflowChangeCard } from './workflow-change-card';
const comparison: WorkflowComparison = {
  id: 'change',
  workflowId: 'workflow',
  createdAt: '2026-10-25',
  before: {
    settings: {
      name: '报销审批',
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: { label: '开始' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'review',
        type: 'agent',
        data: {
          name: '核对报销',
          instruction: '读取报销信息\n金额超过 1000 元时升级审批\n输出审核结果',
        },
        position: { x: 300, y: 0 },
      },
      {
        id: 'old',
        type: 'end',
        data: { label: '旧的结束节点' },
        position: { x: 600, y: 0 },
      },
    ],
    edges: [
      { id: '1', source: 'start', target: 'review' },
      { id: '2', source: 'review', target: 'old' },
    ],
  },
  after: {
    settings: {
      name: '报销审批',
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
    nodes: [
      {
        id: 'start',
        type: 'start',
        data: { label: '开始' },
        position: { x: 0, y: 0 },
      },
      {
        id: 'review',
        type: 'agent',
        data: {
          name: '核对报销',
          instruction: '读取报销信息\n金额超过 500 元时升级审批\n输出审核结果',
        },
        position: { x: 300, y: 0 },
      },
      {
        id: 'human',
        type: 'human_review',
        data: {
          title: '人工审批',
          authentication: { token: 'NEVER-RENDER-ME' },
        },
        position: { x: 600, y: 0 },
      },
    ],
    edges: [
      { id: '3', source: 'start', target: 'review' },
      { id: '4', source: 'review', target: 'human' },
    ],
  },
};
vi.mock('@/services/cmd', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/cmd')>()),
  getModelCatalog: vi.fn(async () => []),
}));
vi.mock('@/services/workflow-revision', () => ({
  compareWorkflowRevisions: vi.fn(async () => comparison),
}));
it('reviews saved snapshots, navigates deleted nodes and stays usable in a narrow window', async () => {
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'zh_CN',
    resources: { zh_CN: { translation: zh } },
    interpolation: { escapeValue: false },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <WorkflowChangeCard beforeRevisionId='before' afterRevisionId='after' />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await page.viewport(1280, 900);
  await screen.getByRole('button', { name: '查看变更' }).click();
  const dialog = screen.getByRole('dialog');
  await expect
    .element(dialog.getByText('金额超过 1000 元时升级审批', { exact: true }))
    .toBeVisible();
  await expect
    .element(dialog.getByText('金额超过 500 元时升级审批', { exact: true }))
    .toBeVisible();
  await page.screenshot({
    path: '.vitest/attachments/workflow-diff-desktop.png',
  });
  await dialog.getByRole('tab', { name: '流程对比' }).click();
  await dialog.getByRole('button', { name: /^旧的结束节点/ }).click();
  await expect
    .element(dialog.getByRole('tab', { name: '更新前' }))
    .toHaveAttribute('aria-selected', 'true');
  await dialog.getByRole('button', { name: /^人工审批/ }).click();
  await expect
    .element(dialog.getByRole('tab', { name: '更新后' }))
    .toHaveAttribute('aria-selected', 'true');
  await expect
    .element(dialog.getByText('NEVER-RENDER-ME'))
    .not.toBeInTheDocument();
  await dialog.getByRole('tab', { name: '变更详情' }).click();
  await page.viewport(390, 844);
  await expect
    .element(dialog.getByRole('tab', { name: '变更详情' }))
    .toBeVisible();
  await dialog.getByRole('tab', { name: '流程对比' }).click();
  await expect.element(dialog.getByTestId('rf__node-human')).toBeVisible();
  await expect
    .poll(() => {
      const node = dialog
        .getByTestId('rf__node-human')
        .element()
        .getBoundingClientRect();
      const canvas = dialog
        .element()
        .querySelector('.react-flow')!
        .getBoundingClientRect();
      return (
        node.left >= canvas.left &&
        node.right <= canvas.right &&
        node.top >= canvas.top &&
        node.bottom <= canvas.bottom
      );
    })
    .toBe(true);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '.vitest/attachments/workflow-diff-mobile.png',
  });
  await expect
    .element(dialog.getByRole('button', { name: '上一项变更' }))
    .toBeVisible();
});

it('shows both name changes immediately, with full before/after values in light and dark themes', async () => {
  const renamed: WorkflowComparison = {
    id: 'rename',
    workflowId: 'workflow',
    createdAt: '2026-10-25',
    before: {
      settings: comparison.after.settings,
      edges: [],
      nodes: [
        {
          id: 'code',
          type: 'codeact_agent',
          position: { x: 0, y: 0 },
          data: { name: '', label: '固定口径指标计算' },
        },
        {
          id: 'agent',
          type: 'agent',
          position: { x: 300, y: 0 },
          data: { label: '撰写中文分析报告' },
        },
      ],
    },
    after: {
      settings: comparison.after.settings,
      edges: [],
      nodes: [
        {
          id: 'code',
          type: 'codeact_agent',
          position: { x: 0, y: 0 },
          data: { label: '销售指标计算（CodeAct）' },
        },
        {
          id: 'agent',
          type: 'agent',
          position: { x: 300, y: 0 },
          data: { name: '中文分析报告撰写（Agent）' },
        },
      ],
    },
  };
  vi.mocked(compareWorkflowRevisions).mockResolvedValueOnce(renamed);
  const i18n = i18next.createInstance();
  await i18n.init({
    lng: 'zh_CN',
    resources: { zh_CN: { translation: zh } },
    interpolation: { escapeValue: false },
  });
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <I18nextProvider i18n={i18n}>
        <WorkflowChangeCard
          beforeRevisionId='rename-before'
          afterRevisionId='rename-after'
        />
      </I18nextProvider>
    </QueryClientProvider>,
  );
  await page.viewport(1280, 900);
  await screen.getByRole('button', { name: '查看变更' }).click();
  const dialog = screen.getByRole('dialog');
  const details = dialog.getByRole('region', { name: '变更详情' });
  await expect
    .element(dialog.getByText('本次仅修改节点名称，流程连接与其他配置未变化。'))
    .toBeVisible();
  await expect
    .element(dialog.getByRole('tab', { name: '变更详情' }))
    .toHaveAttribute('aria-selected', 'true');
  for (const name of [
    '固定口径指标计算',
    '销售指标计算（CodeAct）',
    '撰写中文分析报告',
    '中文分析报告撰写（Agent）',
  ])
    expect(details.element().textContent).toContain(name);
  expect(details.element().querySelectorAll(':scope > section')).toHaveLength(
    2,
  );
  expect(
    details.element().querySelector(':scope > section')!.getBoundingClientRect()
      .height,
  ).toBeGreaterThan(150);
  expect(dialog.element().querySelector('.react-flow')).toBeNull();
  for (const theme of ['light', 'dark']) {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    await Promise.all(
      dialog
        .element()
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    await page.screenshot({
      path: `.vitest/attachments/workflow-rename-diff-${theme}.png`,
    });
  }
  await page.viewport(390, 844);
  await expect.element(details).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: '.vitest/attachments/workflow-rename-diff-mobile.png',
  });
  document.documentElement.classList.remove('dark');
});
