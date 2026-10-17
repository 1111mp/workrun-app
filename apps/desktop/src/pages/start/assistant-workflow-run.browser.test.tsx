import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';

const host = vi.hoisted(() => ({
  record: {} as Record<string, unknown>,
  listener: undefined as (() => void) | undefined,
  cancel: vi.fn(),
  unlisten: vi.fn(),
}));
vi.mock('@/components/workflow-output-panel', () => ({
  WorkflowExecutionDetails: ({
    entry,
  }: {
    entry: { messages?: { content?: string }[] };
  }) => (
    <>
      {entry.messages?.map((message, index) => (
        <p key={index}>{message.content}</p>
      ))}
    </>
  ),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: async () => structuredClone(host.record),
}));
vi.mock('@/services/workflow', () => ({
  cancelBackgroundWorkflowRun: host.cancel,
  subscribeWorkflowRun: async (_id: string, listener: () => void) => {
    host.listener = listener;
    return host.unlisten;
  },
}));
vi.mock('@/components/workflow-actions', () => ({
  WorkflowActionCards: () => <button>确认取消订单 43</button>,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const text = key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        );
      return typeof text === 'string'
        ? text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => {
            const value = values?.[name];
            return typeof value === 'number' || typeof value === 'string'
              ? `${value}`
              : name;
          })
        : key;
    },
  }),
}));

import { AssistantWorkflowRun } from './assistant-workflow-run';

const event = (sequence: number, value: unknown) => ({
  sequence,
  event: value,
  createdAt: '2026-10-17T00:00:00Z',
});
beforeEach(() => {
  vi.clearAllMocks();
  host.listener = undefined;
  host.record = {
    id: 'order-43',
    targetName: '订单取消：风险路由与回归评测',
    status: 'running',
    startedAt: '2026-10-17T00:00:00Z',
    spans: [],
    targetSnapshot: {
      settings: { mode: 'task' },
      nodes: [
        { id: 'risk', type: 'agent', data: { name: '风险检查' } },
        { id: 'cancel', type: 'agent', data: { name: '取消订单' } },
      ],
    },
    events: [
      event(0, { type: 'node_start', node: 'risk', step: 1 }),
      event(1, {
        type: 'message',
        node: 'risk',
        content: '正在检查订单 43 的取消条件。',
        is_final: false,
      }),
    ],
  };
});

it('shows the latest node while collapsed, streams full node receipts inline, and keeps requests visible', async () => {
  await page.viewport(1280, 900);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const tree = (status = 'running') => (
    <QueryClientProvider client={client}>
      <div className='mx-auto max-w-3xl p-6'>
        <AssistantWorkflowRun
          runId='order-43'
          name='订单取消：风险路由与回归评测'
          status={status}
          scope='personal'
        />
      </div>
    </QueryClientProvider>
  );
  const screen = await render(tree());
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('风险检查');
  await expect
    .element(screen.getByRole('button', { name: '确认取消订单 43' }))
    .toBeVisible();
  expect(
    document.querySelector('[data-testid="workflow-run-timeline"]'),
  ).toBeNull();
  const trigger = screen.getByRole('button', { expanded: false });
  await trigger.click();
  await expect
    .element(screen.getByTestId('workflow-run-timeline'))
    .toBeVisible();
  await expect
    .element(screen.getByText('正在检查订单 43 的取消条件。', { exact: true }))
    .toBeVisible();

  host.record.events = [
    ...(host.record.events as unknown[]),
    event(2, { type: 'node_end', node: 'risk', step: 1, duration_ms: 120 }),
    event(3, { type: 'node_start', node: 'cancel', step: 2 }),
    event(4, {
      type: 'message',
      node: 'cancel',
      content: '订单 43 已取消，正在确认结果。',
      is_final: true,
    }),
  ];
  host.listener?.();
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('取消订单');
  await expect
    .element(
      screen.getByText('订单 43 已取消，正在确认结果。', { exact: true }),
    )
    .toBeVisible();

  host.record.status = 'completed';
  host.record.durationMs = 480;
  host.record.events = [
    ...(host.record.events as unknown[]),
    event(5, { type: 'node_end', node: 'cancel', step: 2, duration_ms: 200 }),
    event(6, {
      type: 'done',
      state: { global: {}, nodes: {}, workflow: {} },
      total_steps: 2,
    }),
  ];
  await client.invalidateQueries({ queryKey: ['run-history'] });
  await screen.rerender(tree('completed'));
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('已完成');
  await expect
    .element(screen.getByTestId('workflow-run-timeline'))
    .toBeVisible();
  const timeline = screen.getByTestId('workflow-run-timeline').element();
  expect(getComputedStyle(timeline).maxHeight).toBe('none');
  expect(getComputedStyle(timeline).overflowY).toBe('visible');
  expect(document.querySelector('[data-slot="message-scroller"]')).toBeNull();
  const collapsible = document.querySelector('[data-slot="collapsible"]')!;
  expect(getComputedStyle(collapsible).borderTopWidth).toBe('0px');
  await screen.getByRole('button', { expanded: true }).click();
  await expect
    .poll(() => document.querySelector('[data-testid="workflow-run-timeline"]'))
    .toBeNull();
  expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
});

it('keeps progress and failures readable at a narrow width without opening a drawer', async () => {
  await page.viewport(390, 844);
  host.record.status = 'failed';
  host.record.error = '订单状态已变化，未执行取消。';
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <div className='p-4'>
        <AssistantWorkflowRun
          runId='order-43'
          name='订单取消：风险路由与回归评测'
          status='failed'
          scope='personal'
        />
      </div>
    </QueryClientProvider>,
  );
  await expect
    .element(screen.getByText('订单状态已变化，未执行取消。', { exact: true }))
    .toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});

it('lets long execution output grow naturally with the conversation', async () => {
  await page.viewport(390, 844);
  host.record.events = [
    event(0, { type: 'node_start', node: 'risk', step: 1 }),
    event(1, {
      type: 'message',
      node: 'risk',
      content: '这是需要完整阅读的执行输出。'.repeat(180),
      is_final: true,
    }),
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <div className='p-4'>
        <AssistantWorkflowRun
          runId='long-output'
          status='running'
          scope='personal'
        />
      </div>
    </QueryClientProvider>,
  );
  await screen.getByRole('button', { expanded: false }).click();
  const timeline = screen.getByTestId('workflow-run-timeline');
  await expect
    .poll(() => timeline.element().getBoundingClientRect().height)
    .toBeGreaterThan(320);
  expect(getComputedStyle(timeline.element()).maxHeight).toBe('none');
  expect(getComputedStyle(timeline.element()).overflowY).toBe('visible');
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
});
