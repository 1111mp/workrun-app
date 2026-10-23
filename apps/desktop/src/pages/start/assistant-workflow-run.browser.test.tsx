import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { RunEventTracker } from '@/components/run-event-tracker';
import zh from '@/locales/zh_CN.json';

const host = vi.hoisted(() => ({
  record: {} as Record<string, unknown>,
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
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
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (
    name: string,
    callback: (event: { payload: unknown }) => void,
  ) => {
    host.listeners.set(name, callback);
    return () => {
      host.listeners.delete(name);
      host.unlisten();
    };
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
  host.listeners.clear();
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
      <RunEventTracker />
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

  const spinner = document.querySelector('[data-slot=spinner]')!;
  const rotation = spinner.getAnimations()[0];
  expect(rotation).toBeDefined();
  const startedAt = rotation.startTime;

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
  host.listeners.get('run-event')?.({
    payload: { runId: 'order-43', event: { type: 'message' } },
  });
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

  // Event refreshes must update the receipt without remounting its spinner
  // or restarting the CSS animation at the beginning of every chunk.
  expect(document.querySelector('[data-slot=spinner]')).toBe(spinner);
  expect(spinner.getAnimations()[0]).toBe(rotation);
  expect(rotation.startTime).toBe(startedAt);

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
  host.listeners.get('run-status-changed')?.({
    payload: { runId: 'order-43', status: 'completed' },
  });
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
      <RunEventTracker />
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
      <RunEventTracker />
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

it('shows real model stages and elapsed time without polling or restarting the spinner', async () => {
  await page.viewport(1280, 900);
  host.record.startedAt = new Date(Date.now() - 5000).toISOString();
  host.record.events = [
    event(0, { type: 'node_start', node: 'risk', step: 0 }),
    event(1, {
      type: 'custom',
      node: 'risk',
      event_type: 'agent.model_started',
      data: {},
    }),
  ];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = ['run-history', 'assistant-inline', 'personal', 'order-43'];
  const screen = await render(
    <QueryClientProvider client={client}>
      <AssistantWorkflowRun
        runId='order-43'
        status='running'
        scope='personal'
      />
    </QueryClientProvider>,
  );
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('等待模型响应');
  await expect
    .element(screen.getByText('已完成 0 步 · 1 步执行中'))
    .toBeVisible();
  const elapsed = screen.getByTestId('workflow-run-elapsed').element();
  const before = elapsed.textContent;
  const updatedAt = client.getQueryState(queryKey)!.dataUpdatedAt;
  const spinner = document.querySelector('[data-slot=spinner]')!;
  const rotation = spinner.getAnimations()[0];
  await expect
    .poll(() => elapsed.textContent, { timeout: 3000 })
    .not.toBe(before);
  expect(client.getQueryState(queryKey)!.dataUpdatedAt).toBe(updatedAt);
  expect(document.querySelector('[data-slot=spinner]')).toBe(spinner);
  expect(spinner.getAnimations()[0]).toBe(rotation);
  const push = (sequence: number, value: unknown) => {
    host.record.events = [
      ...(host.record.events as unknown[]),
      event(sequence, value),
    ];
    client.setQueryData(queryKey, structuredClone(host.record));
  };
  push(2, {
    type: 'custom',
    node: 'risk',
    event_type: 'agent.model_responding',
    data: {},
  });
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('正在接收模型输出');
  push(3, {
    type: 'custom',
    node: 'risk',
    event_type: 'agent.model_call',
    data: {},
  });
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .toContain('正在处理结果');
  // A loop entering the same node must not retain the previous model phase.
  push(4, { type: 'node_end', node: 'risk', step: 0, duration_ms: 100 });
  push(5, { type: 'node_start', node: 'risk', step: 1 });
  await expect
    .poll(
      () => screen.getByTestId('workflow-run-summary').element().textContent,
    )
    .not.toContain('正在处理结果');
  await expect
    .element(screen.getByText('已完成 1 步 · 1 步执行中'))
    .toBeVisible();
});
