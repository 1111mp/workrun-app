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
    outcome: {
      summary:
        '### 创建结果\n\n已保存，**未执行**。\n\n- 输入：`sales_csv`\n- 待验证：实际运行结果',
    },
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
    await expect
      .element(screen.getByRole('heading', { name: '创建结果' }))
      .toBeVisible();
    const outcome = screen.getByRole('status').element();
    expect(outcome.querySelectorAll('li')).toHaveLength(2);
    expect(outcome.querySelector('code')?.textContent).toBe('sales_csv');
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

it('keeps legacy creation receipts compact and readable on desktop and narrow screens', async () => {
  const { AssistantPlanOutcome } = await import('./assistant-plan-outcome');
  const summary = `已保存工作流草稿 4b542b45-2e80-1857-c8c5-b75e817c3714。结构：start → codeact_agent「固定口径指标计算」→ agent「撰写中文分析报告」→ end。计算节点：通过 /artifacts/manifest.json 读取 sales.csv，settings.outputSchema 声明 report，state.globalKeys=["report"]。${'固定口径计算销售额、订单数和平均客单价；缺失必需列时 status=blocked，数值字段置 null。'.repeat(10)}节点契约通过原生校验；未运行任何节点。`;
  const screen = await render(
    <main className='p-6'>
      <AssistantPlanOutcome summary={summary} />
    </main>,
  );
  for (const width of [1280, 390]) {
    await page.viewport(width, 900);
    const preview = screen.getByText(summary, { exact: true }).element();
    expect(preview.getBoundingClientRect().height).toBeLessThanOrEqual(84);
    await screen.getByRole('button', { name: '查看保存详情' }).click();
    const details = screen.getByTestId('plan-outcome-details').element();
    expect(details.textContent).toBe(summary);
    expect(details.querySelectorAll('p').length).toBeGreaterThan(10);
    expect(getComputedStyle(details).maxWidth).not.toBe('none');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await screen.getByRole('button', { name: '收起保存详情' }).click();
    await expect
      .element(screen.getByTestId('plan-outcome-details'))
      .not.toBeInTheDocument();
  }
});

it('presents a node naming request as an update to the existing workflow', async () => {
  const decide = vi.fn();
  const plan: WorkflowPlan = {
    id: 'rename-plan',
    sessionId: 'session',
    version: 1,
    status: 'ready',
    dependencyIssues: [],
    interaction: {
      id: 'review',
      taskId: 'task',
      threadId: 'thread',
      checkpointId: 'checkpoint',
      kind: 'plan_confirmation',
      version: 1,
      status: 'waiting',
    },
    document: {
      goal: '给现有工作流的 CodeAct 和 Agent 节点添加合适的名称',
      summary: '仅修改两个节点的名称',
      target_id: 'existing-workflow',
      inputs: [],
      outputs: [],
      steps: [],
      constraints: [],
      assumptions: [],
      questions: [],
      acceptance_criteria: [],
    },
  };
  const screen = await render(
    <MemoryRouter>
      <AssistantWorkflowPlan
        plan={plan}
        busy={false}
        onDecide={decide}
        onDiscuss={vi.fn()}
      />
    </MemoryRouter>,
  );
  await expect
    .element(screen.getByText('工作流修改方案 · 版本 1'))
    .toBeVisible();
  await expect
    .element(screen.getByText('任务已暂停，等待你的反馈。本次修改尚未保存。'))
    .toBeVisible();
  await expect
    .element(screen.getByRole('link', { name: '此方案将修改现有工作流' }))
    .toHaveAttribute('href', '/workflows/existing-workflow');
  await expect
    .element(screen.getByRole('button', { name: '确认方案并创建' }))
    .not.toBeInTheDocument();
  await screen.getByRole('button', { name: '确认修改并保存' }).click();
  expect(decide).toHaveBeenCalledExactlyOnceWith('approve');
});
