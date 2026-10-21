import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';
import type { WorkflowPlan } from '@/services/assistant';

import { AssistantWorkflowPlan } from './assistant-workflow-plan';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: { version?: number }) => {
      const value = key
        .split('.')
        .reduce<unknown>(
          (object, part) => (object as Record<string, unknown>)?.[part],
          zh,
        );
      return typeof value === 'string'
        ? value.replace('{{version}}', String(params?.version ?? ''))
        : key;
    },
  }),
}));
it('keeps the proposal readable at desktop and narrow widths and exposes details on demand', async () => {
  const plan: WorkflowPlan = {
    id: 'plan',
    sessionId: 'session',
    version: 2,
    status: 'needs_clarification',
    dependencyIssues: [],
    document: {
      goal: '把资料整理过程变成可复用工作流',
      summary: '先核对资料，再处理内容，最后检查结果并输出。',
      inputs: [{ name: '输入资料', description: '用户已提供的附件' }],
      outputs: ['经过校验的报告'],
      steps: [
        {
          title: '核对输入',
          description: '读取资料的实际结构，确认必要字段和处理范围。',
          node_types: ['agent'],
          configuration_notes:
            '使用当前会话选择的模型，缺失必需信息时先向用户澄清。',
          dependencies: [],
        },
      ],
      constraints: ['创建阶段不执行外部操作'],
      assumptions: [],
      questions: ['最终报告需要覆盖哪些范围？'],
      acceptance_criteria: ['输出覆盖用户确定的处理范围'],
    },
  };
  const decide = vi.fn();
  const discuss = vi.fn();
  const screen = await render(
    <MemoryRouter>
      <main style={{ padding: 24, maxWidth: 840, margin: '0 auto' }}>
        <AssistantWorkflowPlan
          plan={plan}
          busy={false}
          onDecide={decide}
          onDiscuss={discuss}
        />
      </main>
    </MemoryRouter>,
  );
  for (const width of [1280, 390]) {
    await page.viewport(width, 900);
    await expect.element(screen.getByText('工作流规划 · 版本 2')).toBeVisible();
    await expect
      .element(screen.getByRole('button', { name: '确认方案并创建' }))
      .toBeDisabled();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  }
  await screen.getByRole('button', { name: '回答此问题' }).click();
  expect(discuss).toHaveBeenCalledWith('最终报告需要覆盖哪些范围？');
  await screen.getByRole('button', { name: '查看节点选择与配置' }).click();
  await expect
    .element(
      screen.getByText('使用当前会话选择的模型，缺失必需信息时先向用户澄清。'),
    )
    .toBeVisible();
  expect(decide).not.toHaveBeenCalled();
});
