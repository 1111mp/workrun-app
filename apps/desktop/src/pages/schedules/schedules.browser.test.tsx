import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { WorkspaceFrame } from '@/components/workspace-frame';
import zh from '@/locales/zh_CN.json';
vi.stubGlobal('OS_PLATFORM', 'darwin');
vi.mock('@/components/conversation-title', () => ({
  ConversationTitle: () => null,
}));
vi.mock('@/components/run-center', () => ({ RunCenter: () => null }));
vi.mock('@/components/run-event-tracker', () => ({
  RunEventTracker: () => null,
}));

import '@/styles/global.css';
import type { ScheduledTask, SchedulingSession } from '@/services/schedules';
import {
  changeScheduledTask,
  sendSchedulingMessage,
} from '@/services/schedules';

import { Component } from './index';

const fixtures = vi.hoisted(() => ({
  snapshot: undefined as SchedulingSession | undefined,
  readGate: undefined as Promise<SchedulingSession> | undefined,
  readError: undefined as Error | undefined,
  receipt: undefined as SchedulingSession | undefined,
  taskGate: undefined as Promise<ScheduledTask> | undefined,
  taskSnapshot: undefined as ScheduledTask | undefined,
  decisionGate: undefined as Promise<SchedulingSession> | undefined,
  replyGate: undefined as Promise<SchedulingSession> | undefined,
  listeners: new Map<string, (event: unknown) => void>(),
  empty: false,
  questions: false,
  pending: false,
  once: false,
  receive: undefined as
    | undefined
    | ((event: import('@/services/schedules').SchedulingStream) => void),
  finish: undefined as undefined | (() => void),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, receive: (event: unknown) => void) => {
    fixtures.listeners.set(name, receive);
    return () => {
      fixtures.listeners.delete(name);
    };
  },
}));
vi.mock('@/components/app-sidebar', () => ({
  useEntryWorkspace: () => 'personal',
  AppSidebar: () => (
    <aside
      className='bg-sidebar hidden w-60 shrink-0 flex-col gap-8 p-5 md:flex'
      aria-label='Workrun navigation'
    >
      <strong>Workrun</strong>
      <nav>首页 · 工作流 · 应用 · 定时任务</nav>
    </aside>
  ),
}));
vi.mock('@/components/message-markdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (selector: (s: unknown) => unknown) =>
    selector({ config: { summary_model_profile_id: 'model-1' } }),
}));
vi.mock('@/services/cmd', () => ({
  getModelCatalogStatus: async () => ({
    models: await (await import('@/services/cmd')).getModelCatalog(),
    serverError: null,
  }),
  getModelCatalog: async () => [
    { id: 'model-1', name: '已配置的模型', provider: 'ollama' },
  ],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          zh,
        ) || key,
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/services/schedules', () => {
  const task: ScheduledTask = {
    id: 'task-1',
    name: 'Workrun 项目周报',
    targetId: 'wf-1',
    targetType: 'workflow',
    targetName: '项目进展汇总',
    enabled: true,
    cronExpression: '0 17 * * 5',
    timezone: 'Asia/Shanghai',
    nextRunAt: '2026-11-06T09:00:00Z',
    version: 'v1',
    input: { project: 'Workrun' },
    occurrences: [
      {
        id: 'run-1',
        scheduledFor: '2026-10-30T09:00:00Z',
        status: 'completed',
        runId: 'execution-1',
      },
    ],
  };
  const onceTask: ScheduledTask = {
    ...task,
    name: '上海天气行程规划',
    scheduleKind: 'once',
    cronExpression: '',
    runAt: '2026-11-05T02:00:00Z',
    nextRunAt: '2026-11-05T02:00:00Z',
  };
  const session: SchedulingSession = {
    id: 'session-1',
    title: '安排项目周报',
    scheduleId: task.id,
    messages: [
      { id: 'm1', role: 'user', text: '把项目周报改到每周一上午九点' },
    ],
    proposals: [
      {
        id: 'p1',
        operation: 'update',
        status: 'waiting',
        before: task,
        after: {
          ...task,
          cronExpression: '0 9 * * 1',
          nextRunAt: '2026-11-09T01:00:00Z',
        },
        messageIndex: 1,
      },
    ],
    questions: [],
    status: 'idle',
  };
  return {
    listSchedules: async () =>
      fixtures.empty
        ? []
        : [
            fixtures.taskSnapshot ?? task,
            {
              ...task,
              id: 'task-2',
              name: '每日数据备份',
              targetType: 'app',
              targetName: '数据备份',
              enabled: false,
            },
          ],
    getSchedule: async () =>
      fixtures.taskGate ??
      fixtures.taskSnapshot ??
      (fixtures.once ? onceTask : task),
    listSchedulingSessions: async () =>
      fixtures.empty
        ? []
        : [{ id: session.id, title: session.title, scheduleId: task.id }],
    getSchedulingSession: async () => {
      if (fixtures.readError) throw fixtures.readError;
      if (fixtures.readGate) return fixtures.readGate;
      if (fixtures.snapshot) return fixtures.snapshot;
      return fixtures.once
        ? {
            ...session,
            messages: [
              {
                id: 'once-user',
                role: 'user',
                text: '明天上午十点运行上海天气行程规划',
              },
            ],
            proposals: [
              {
                id: 'once-card',
                operation: 'create',
                status: 'waiting',
                before: null,
                after: onceTask,
                messageIndex: 1,
              },
            ],
          }
        : fixtures.pending
          ? {
              ...session,
              scheduleId: null,
              messages: [],
              proposals: [],
              questions: [],
            }
          : fixtures.questions
            ? {
                ...session,
                proposals: [],
                questions: [
                  {
                    title: '需要统计哪个项目？',
                    options: ['Workrun', '其他项目'],
                  },
                  {
                    title: '希望在什么时间收到结果？',
                    options: ['每周五 17:00', '每周一 09:00'],
                  },
                ],
              }
            : session;
    },
    setSchedulingModel: vi.fn(),
    createSchedulingSession: async () => ({
      ...session,
      scheduleId: null,
      messages: [],
      proposals: [],
      questions: [],
    }),
    deleteSchedulingSession: vi.fn(),
    sendSchedulingMessage: vi.fn(
      (
        _id: string,
        _model: string,
        text: string,
        onStream: (
          event: import('@/services/schedules').SchedulingStream,
        ) => void,
      ) =>
        new Promise<SchedulingSession>((resolve) => {
          fixtures.receive = onStream;
          fixtures.finish = () =>
            resolve(
              fixtures.receipt ?? {
                ...session,
                scheduleId: null,
                proposals: [],
                questions: [],
                messages: [
                  { id: 'native-user', role: 'user', text },
                  {
                    id: 'native-answer',
                    role: 'assistant',
                    text: '已找到 Weather workflow。请确认运行时间。',
                  },
                ],
              },
            );
        }),
    ),
    proposeScheduleChange: vi.fn(),
    changeScheduledTask: vi.fn(),
    decideScheduleChange: async () => fixtures.decisionGate,
    replySchedulingReceipt: async (
      _id: string,
      receive: (event: import('@/services/schedules').SchedulingStream) => void,
    ) => {
      fixtures.receive = receive;
      return (
        (await (fixtures.replyGate ?? fixtures.decisionGate)) ||
        fixtures.snapshot ||
        session
      );
    },
    stopSchedulingResponse: vi.fn(),
  };
});

for (const [theme, width, mode] of [
  ['light', 1280, 'task'],
  ['light', 1920, 'task'],
  ['dark', 1280, 'empty'],
  ['light', 1280, 'list'],
  ['dark', 390, 'empty'],
  ['light', 390, 'questions'],
  ['light', 1280, 'once'],
  ['dark', 390, 'once'],
] as const) {
  it(`task center fits ${theme} ${width} ${mode}`, async () => {
    fixtures.pending = false;
    fixtures.once = mode === 'once';
    fixtures.empty = mode === 'empty';
    fixtures.questions = mode === 'questions';
    document.documentElement.classList.toggle('dark', theme === 'dark');
    await page.viewport(width, 900);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={client}>
        <MemoryRouter
          initialEntries={[
            mode === 'empty' || mode === 'list'
              ? mode === 'list'
                ? '/schedules?view=tasks'
                : '/schedules'
              : '/schedules?conversation=session-1',
          ]}
        >
          <WorkspaceFrame accountMenu={null}>
            <Component />
          </WorkspaceFrame>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await expect
      .element(
        page.getByRole('button', { name: zh.schedules.new, exact: true }),
      )
      .toBeVisible();
    if (mode !== 'list')
      await expect
        .element(page.getByRole('textbox', { name: zh.schedules.composer }))
        .toBeVisible();
    if (mode === 'task')
      await expect
        .element(
          page.getByRole('button', { name: zh.schedules.confirm.update }),
        )
        .toBeVisible();
    if (mode === 'empty')
      await expect
        .element(page.getByRole('heading', { name: zh.schedules.hero }))
        .toBeVisible();
    if (mode === 'once')
      await expect
        .element(
          page.getByRole('button', { name: zh.schedules.confirm.create }),
        )
        .toBeVisible();
    if (mode === 'questions') {
      await expect
        .element(page.getByRole('button', { name: zh.schedules.continue }))
        .toBeVisible();
      await expect
        .element(page.getByText(zh.schedules.answerHint))
        .toBeVisible();
      await expect
        .element(page.getByPlaceholder(zh.schedules.answerPlaceholder))
        .toBeVisible();
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    const header = document.querySelector('header')!.getBoundingClientRect();
    const toolbar = document
      .querySelector('[data-schedule-toolbar]')!
      .getBoundingClientRect();
    const content = document
      .querySelector('[data-workspace-header-slot]')!
      .closest('header')!
      .nextElementSibling!.getBoundingClientRect();
    expect(toolbar.top).toBeGreaterThanOrEqual(header.top);
    expect(toolbar.bottom).toBeLessThanOrEqual(header.bottom);
    expect(content.top).toBe(header.bottom);
    const viewport = document.querySelector(
      '[data-conversation-scroll-viewport]',
    );
    if (!['empty', 'list'].includes(mode) && viewport)
      expect(viewport.getBoundingClientRect().top).toBe(header.bottom);
    expect(
      document.querySelector('[data-slot="tabs"] > [data-schedule-toolbar]'),
    ).toBeNull();

    const composer = document.querySelector('textarea');
    if (composer) {
      expect(composer.getBoundingClientRect().bottom).toBeLessThanOrEqual(900);
      const group = composer.closest('[data-slot="input-group"]')!;
      expect(group.getBoundingClientRect().height).toBeLessThan(160);
      expect(composer.getBoundingClientRect().height).toBeLessThan(90);
    }
    if (mode === 'empty') {
      expect(document.querySelector('main aside')).toBeNull();
      const hero = document
        .querySelector('[data-schedule-landing] h2')!
        .getBoundingClientRect();
      const group = composer!
        .closest('[data-slot="input-group"]')!
        .getBoundingClientRect();
      expect(group.top - hero.bottom).toBeLessThan(130);
      expect(group.width).toBeLessThanOrEqual(848);
    }
    if (!['empty', 'list'].includes(mode)) {
      const content = document
        .querySelector('[data-slot="message-scroller-content"]')!
        .getBoundingClientRect();
      const composerBox = document
        .querySelector('textarea')!
        .closest('[data-slot="input-group"]')!
        .getBoundingClientRect();
      expect(Math.abs(content.left + 24 - composerBox.left)).toBeLessThan(2);
      expect(Math.abs(content.right - 24 - composerBox.right)).toBeLessThan(2);
      if (width === 1920) expect(content.width).toBeGreaterThan(1000);
    }
    await page.screenshot({
      path: `.vitest/attachments/schedules-${theme}-${width}-${mode}.png`,
    });
    if (mode === 'task') {
      await page.getByRole('tab', { name: zh.schedules.list }).click();
      await expect
        .element(
          page.getByRole('heading', {
            name: zh.schedules.scheduled,
            exact: true,
          }),
        )
        .toBeVisible();
      await page
        .getByRole('button', { name: zh.schedules.conversations })
        .click();
      await expect
        .element(page.getByRole('menuitemradio', { name: '安排项目周报' }))
        .toHaveAttribute('aria-checked', 'true');
      await page.screenshot({
        path: `.vitest/attachments/schedule-history-${width}.png`,
      });
      await page.getByRole('menuitemradio', { name: '安排项目周报' }).click();
      await expect
        .element(page.getByRole('tab', { name: zh.schedules.chat }))
        .toHaveAttribute('aria-selected', 'true');
    }

    client.clear();
  });
}

for (const width of [1280, 390]) {
  it(`shows the sent Weather request and live response before completion at ${width}px`, async () => {
    fixtures.once = false;
    fixtures.empty = true;
    fixtures.questions = false;
    fixtures.pending = true;
    fixtures.receive = undefined;
    fixtures.finish = undefined;
    document.documentElement.classList.add('dark');
    await page.viewport(width, 900);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    await render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/schedules?view=new']}>
          <WorkspaceFrame accountMenu={null}>
            <Component />
          </WorkspaceFrame>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const text =
      '明天上午十点整运行 Weather workflow，根据上海的天气给出行程规划';
    await page.getByRole('textbox', { name: zh.schedules.composer }).fill(text);
    await page
      .getByRole('button', { name: zh.schedules.send, exact: true })
      .click();
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    await expect.poll(() => Boolean(fixtures.receive)).toBe(true);
    const outgoing = document
      .querySelector('[data-slot="message"][data-align="end"]')!
      .closest('[data-message-id]')!;
    const outgoingId = outgoing.getAttribute('data-message-id');
    client.setQueryData(['scheduling-session', 'personal', 'session-1'], {
      id: 'session-1',
      title: 'Weather',
      messages: [{ id: 'native-acknowledged-user', role: 'user', text }],
      proposals: [],
      questions: [],
      status: 'running',
    });
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(outgoing.isConnected).toBe(true);
    expect(outgoing.getAttribute('data-message-id')).toBe(outgoingId);

    client.setQueryData(['scheduling-session', 'personal', 'session-1'], {
      id: 'session-1',
      title: '',
      messages: [],
      proposals: [],
      questions: [],
      status: 'idle',
    });
    fixtures.receive!({ type: 'phase_start', phaseId: 'lookup' });
    fixtures.receive!({
      type: 'tool_start',
      phaseId: 'lookup',
      name: 'list_targets',
    });
    await expect
      .element(
        page.getByText(zh.schedules.progress.list_targets, { exact: true }),
      )
      .toBeVisible();
    await expect.element(page.getByText(text, { exact: true })).toBeVisible();
    expect(
      document.querySelector('[data-slot="message"][data-align="end"]'),
    ).not.toBeNull();
    await page.screenshot({
      path: `.vitest/attachments/schedules-live-${width}-waiting.png`,
    });
    fixtures.receive!({ type: 'phase_start', phaseId: 'answer' });
    fixtures.receive!({
      type: 'text_delta',
      phaseId: 'answer',
      text: '已找到 Weather workflow。',
    });
    await expect
      .element(page.getByText('已找到 Weather workflow。', { exact: true }))
      .toBeVisible();
    await expect
      .element(
        page.getByRole('button', { name: zh.schedules.stop, exact: true }),
      )
      .toBeVisible();
    const draft = page.getByRole('textbox', { name: zh.schedules.composer });
    await expect.element(draft).toBeEnabled();
    const sends = vi.mocked(sendSchedulingMessage).mock.calls.length;
    await draft.fill('接下来改成每周执行');
    draft
      .element()
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
    expect(vi.mocked(sendSchedulingMessage).mock.calls.length).toBe(sends);
    await expect.element(draft).toHaveValue('接下来改成每周执行');
    const composer = document
      .querySelector('textarea')!
      .getBoundingClientRect();
    expect(composer.bottom).toBeLessThanOrEqual(900);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `.vitest/attachments/schedules-live-${width}-streaming.png`,
    });
    fixtures.receive!({
      type: 'text_delta',
      phaseId: 'answer',
      text: '请确认运行时间。',
    });
    await expect
      .element(
        page.getByText('已找到 Weather workflow。请确认运行时间。', {
          exact: true,
        }),
      )
      .toBeVisible();
    fixtures.finish!();
    await expect
      .element(page.getByRole('textbox', { name: zh.schedules.composer }))
      .toBeEnabled();
    await expect.element(draft).toHaveValue('接下来改成每周执行');
    expect(
      document.querySelectorAll('[data-slot="message"][data-align="end"]'),
    ).toHaveLength(1);
    client.clear();
  });
}

function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function frames(count = 3) {
  for (let index = 0; index < count; index++)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
}
function auditSnapshot(): SchedulingSession {
  return {
    id: 'audit-session',
    revision: 1,
    title: '状态稳定性验证',
    modelId: 'model-1',
    status: 'idle',
    proposals: [],
    questions: [],
    messages: Array.from({ length: 14 }, (_, index) => [
      { id: `u-${index}`, role: 'user' as const, text: `历史请求 ${index}` },
      {
        id: `a-${index}`,
        role: 'assistant' as const,
        text: `历史答复 ${index}\n${'上海天气和出行建议。'.repeat(25)}`,
      },
    ]).flat(),
  };
}
function pushSession() {
  fixtures.listeners.get('schedule-session-changed')!({
    payload: { workspaceId: 'personal', sessionId: 'audit-session' },
  });
}
async function captureFrames<T>(sample: () => T, work: () => Promise<void>) {
  const samples: T[] = [];
  let active = true;
  let frame = 0;
  const record = () => samples.push(sample());
  // Sample before paints, rather than treating intermediate DOM mutations as visible frames.
  const tick = () => {
    record();
    if (active) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  try {
    await work();
    await frames();
  } finally {
    active = false;
    cancelAnimationFrame(frame);
  }
  return samples;
}
async function mountAudit(width: number) {
  fixtures.empty = false;
  fixtures.once = false;
  fixtures.pending = false;
  fixtures.questions = false;
  fixtures.snapshot = auditSnapshot();
  fixtures.readGate = undefined;
  fixtures.readError = undefined;
  fixtures.receipt = undefined;
  fixtures.taskGate = undefined;
  fixtures.taskSnapshot = {
    id: 'task-1',
    name: '天气定时任务',
    targetId: 'weather',
    targetType: 'workflow',
    targetName: 'Weather',
    enabled: true,
    cronExpression: '0 10 * * *',
    timezone: 'Asia/Shanghai',
    nextRunAt: '2026-11-06T02:00:00Z',
    version: 'v1',
    occurrences: [
      {
        id: 'run-one',
        status: 'completed',
        scheduledFor: '2026-11-03T02:00:00Z',
      },
    ],
  };
  document.documentElement.classList.add('dark');
  await page.viewport(width, 900);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/schedules?conversation=audit-session']}>
        <WorkspaceFrame accountMenu={null}>
          <Component />
        </WorkspaceFrame>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .poll(
      () => document.querySelectorAll('[data-message-id^="message-"]').length,
    )
    .toBe(28);
  await expect.poll(() => client.isFetching()).toBe(0);
  await frames();
  const viewport = document.querySelector<HTMLDivElement>(
    '[data-conversation-scroll-viewport]',
  )!;
  return { client, view, viewport };
}
function clearAudit(client: QueryClient) {
  client.clear();
  fixtures.snapshot = undefined;
  fixtures.readGate = undefined;
  fixtures.readError = undefined;
  fixtures.receipt = undefined;
  fixtures.taskSnapshot = undefined;
  fixtures.taskGate = undefined;
  fixtures.decisionGate = undefined;
  fixtures.replyGate = undefined;
  fixtures.receive = undefined;
}

for (const width of [1280, 390]) {
  it(`audits unchanged, stale and failed useQuery refreshes without moving the reading position at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -100 }),
      );
      viewport.scrollTop = 700;
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      await frames();
      const originalTop = viewport.scrollTop;
      const row = document.querySelector<HTMLElement>(
        '[data-message-id="message-8"]',
      )!;
      const originalY =
        row.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      let metadataChanged = false;
      const read = gate<SchedulingSession>();
      fixtures.readGate = read.promise;
      const samples = await captureFrames(
        () => ({
          metadataChanged,
          mounted: viewport.isConnected && row.isConnected,
          y:
            row.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top,
          top: viewport.scrollTop,
        }),
        async () => {
          pushSession();
          await expect
            .poll(() =>
              client.isFetching({
                queryKey: ['scheduling-session', 'personal', 'audit-session'],
              }),
            )
            .toBe(1);
          await frames(4);
          read.resolve(structuredClone(fixtures.snapshot!));
          fixtures.readGate = undefined;
          await expect.poll(() => client.isFetching()).toBe(0);
          fixtures.readError = new Error('Read temporarily unavailable');
          pushSession();
          await expect
            .poll(
              () =>
                client.getQueryState([
                  'scheduling-session',
                  'personal',
                  'audit-session',
                ])?.status,
            )
            .toBe('error');
          await frames(3);
          fixtures.readError = undefined;
          fixtures.snapshot = { ...fixtures.snapshot!, revision: 3 };
          pushSession();
          await expect
            .poll(
              () =>
                client.getQueryData<SchedulingSession>([
                  'scheduling-session',
                  'personal',
                  'audit-session',
                ])?.revision,
            )
            .toBe(3);
          metadataChanged = true;
          fixtures.listeners.get('run-status-changed')!({
            payload: { runId: 'updated-run' },
          });
          await expect.poll(() => client.isFetching()).toBe(0);
          fixtures.readGate = Promise.resolve({
            ...fixtures.snapshot!,
            revision: 2,
            messages: [],
          });
          pushSession();
          await expect.poll(() => client.isFetching()).toBe(0);
        },
      );
      expect(samples.length).toBeGreaterThan(5);
      expect(samples.every((sample) => sample.mounted)).toBe(true);
      expect(
        Math.max(...samples.map((sample) => Math.abs(sample.y - originalY))),
      ).toBeLessThan(1);
      expect(
        Math.max(
          ...samples
            .filter((sample) => !sample.metadataChanged)
            .map((sample) => Math.abs(sample.top - originalTop)),
        ),
      ).toBeLessThan(1);
      const readingTop = viewport.scrollTop;
      await page.getByRole('tab', { name: zh.schedules.list }).click();
      await expect
        .element(
          page.getByRole('heading', {
            name: zh.schedules.scheduled,
            exact: true,
          }),
        )
        .toBeVisible();
      await page.getByRole('tab', { name: zh.schedules.chat }).click();
      await frames(4);
      expect(viewport.isConnected).toBe(true);
      expect(Math.abs(viewport.scrollTop - readingTop)).toBeLessThan(1);
      expect(
        client.getQueryData<SchedulingSession>([
          'scheduling-session',
          'personal',
          'audit-session',
        ])?.revision,
      ).toBe(3);
    } finally {
      clearAudit(client);
    }
  });

  it(`audits send, native ack, streaming, completion-before-receipt and task refresh at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const historical = document.querySelector(
        '[data-message-id="message-0"]',
      )!;
      const text = '明天十点运行天气工作流';
      await page
        .getByRole('textbox', { name: zh.schedules.composer })
        .fill(text);
      await page
        .getByRole('button', { name: zh.schedules.send, exact: true })
        .click();
      await expect.poll(() => Boolean(fixtures.receive)).toBe(true);
      const optimistic = document.querySelector(
        '[data-message-id="message-28"]',
      )!;
      const sample = () => ({
        mounted:
          viewport.isConnected &&
          historical.isConnected &&
          optimistic.isConnected,
        rows: document.querySelectorAll('[data-message-id^="message-"]').length,
        duplicates: Array.from(
          document.querySelectorAll('[data-slot="bubble-content"]'),
        ).filter((node) => node.textContent === '完成的天气结果').length,
      });
      const samples = await captureFrames(sample, async () => {
        fixtures.snapshot = {
          ...fixtures.snapshot!,
          revision: 2,
          status: 'running',
          messages: [
            ...fixtures.snapshot!.messages,
            { id: 'native-u', role: 'user', text },
          ],
        };
        pushSession();
        await expect
          .poll(
            () =>
              client.getQueryData<SchedulingSession>([
                'scheduling-session',
                'personal',
                'audit-session',
              ])?.revision,
          )
          .toBe(2);
        fixtures.receive!({ type: 'phase_start', phaseId: 'answer' });
        fixtures.receive!({
          type: 'text_delta',
          phaseId: 'answer',
          text: '完成的天气结果',
        });
        await expect
          .element(page.getByText('完成的天气结果', { exact: true }))
          .toBeVisible();
        fixtures.snapshot = {
          ...fixtures.snapshot!,
          revision: 3,
          status: 'idle',
          messages: [
            ...fixtures.snapshot!.messages,
            { id: 'native-a', role: 'assistant', text: '完成的天气结果' },
          ],
        };
        pushSession();
        await expect
          .poll(
            () =>
              client.getQueryData<SchedulingSession>([
                'scheduling-session',
                'personal',
                'audit-session',
              ])?.revision,
          )
          .toBe(3);
        await frames(4);
        fixtures.listeners.get('run-status-changed')!({
          payload: { runId: 'run-two' },
        });
        await frames(3);
        fixtures.receipt = fixtures.snapshot;
        fixtures.finish!();
        await expect
          .element(
            page.getByRole('button', { name: zh.schedules.send, exact: true }),
          )
          .toBeVisible();
      });
      expect(
        samples.every(
          (value) => value.mounted && value.rows >= 29 && value.duplicates <= 1,
        ),
      ).toBe(true);
      expect(
        document.querySelectorAll('[data-message-id^="message-"]'),
      ).toHaveLength(30);
      await expect
        .element(page.getByText('完成的天气结果', { exact: true }))
        .toBeVisible();
    } finally {
      clearAudit(client);
    }
  });

  it(`audits task confirmation and slow detail loading without remounting the conversation at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const task = fixtures.taskSnapshot!;
      const proposal = {
        id: 'audit-card',
        operation: 'create' as const,
        status: 'waiting' as const,
        before: null,
        after: task,
        messageIndex: 28,
      };
      fixtures.snapshot = {
        ...fixtures.snapshot!,
        revision: 2,
        proposals: [proposal],
        pending: proposal.id,
      };
      pushSession();
      await expect
        .element(
          page.getByRole('button', { name: zh.schedules.confirm.create }),
        )
        .toBeVisible();
      await page
        .getByRole('textbox', { name: zh.schedules.composer })
        .fill('保留这条未发送的输入');
      const preview = page
        .getByRole('region', { name: zh.schedules.taskCard })
        .element();
      expect(
        preview.closest('[data-message-id]')?.getAttribute('data-message-id'),
      ).toBe('message-27');
      const decision = gate<SchedulingSession>();
      fixtures.decisionGate = decision.promise;
      const detail = gate<ScheduledTask>();
      fixtures.taskGate = detail.promise;
      const row = document.querySelector('[data-message-id="message-0"]')!;
      const samples = await captureFrames(
        () => viewport.isConnected && row.isConnected,
        async () => {
          await page
            .getByRole('button', { name: zh.schedules.confirm.create })
            .click();
          await frames(4);
          const saved = {
            ...fixtures.snapshot!,
            revision: 3,
            scheduleId: task.id,
            pending: null,
            proposals: [{ ...proposal, status: 'saved' as const }],
          };
          fixtures.snapshot = saved;
          decision.resolve(saved);
          await expect
            .element(page.getByRole('link', { name: zh.schedules.viewTask }))
            .toBeVisible();
          await frames(4);
          fixtures.snapshot = {
            ...saved,
            revision: 4,
            messages: [
              ...saved.messages,
              {
                id: 'receipt',
                role: 'assistant' as const,
                text: '定时任务已按你的要求创建。',
                proposalId: proposal.id,
              },
            ],
          };
          pushSession();
          await expect
            .element(
              page.getByText('定时任务已按你的要求创建。', { exact: true }),
            )
            .toBeVisible();
          const result = page
            .getByRole('region', { name: task.name, exact: true })
            .element();
          expect(result.closest('[data-slot="message"]')).toBe(
            page
              .getByText('定时任务已按你的要求创建。', { exact: true })
              .element()
              .closest('[data-slot="message"]'),
          );
          await page.screenshot({
            path: `.vitest/attachments/schedules-confirmed-reply-${width}.png`,
          });
          detail.resolve(task);
        },
      );
      expect(samples.every(Boolean)).toBe(true);
      await expect
        .element(page.getByRole('textbox', { name: zh.schedules.composer }))
        .toHaveValue('保留这条未发送的输入');
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`audits cached history switching without displaying a wrong reading position at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      viewport.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -100 }),
      );
      viewport.scrollTop = 700;
      viewport.dispatchEvent(new Event('scroll', { bubbles: true }));
      await frames(4);
      const marker = document.querySelector<HTMLElement>(
        '[data-message-id="message-8"]',
      )!;
      const originalY =
        marker.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top;
      const first = fixtures.snapshot!;
      client.setQueryData(
        ['scheduling-sessions', 'personal'],
        [
          { id: first.id, title: '正在阅读的会话' },
          { id: 'second-session', title: '另一个会话' },
        ],
      );
      fixtures.snapshot = {
        ...first,
        id: 'second-session',
        title: '另一个会话',
        messages: [
          { id: 'second', role: 'assistant', text: '另一个会话的内容' },
        ],
      };
      await page
        .getByRole('button', { name: zh.schedules.conversations })
        .click();
      await page
        .getByRole('menuitemradio', { name: '另一个会话', exact: true })
        .click();
      await expect
        .element(page.getByText('另一个会话的内容', { exact: true }))
        .toBeVisible();
      fixtures.snapshot = first;
      const positions = await captureFrames(
        () => {
          const marker = document.querySelector<HTMLElement>(
            '[data-message-id="message-8"]',
          );
          const current = document.querySelector<HTMLElement>(
            '[data-conversation-scroll-viewport]',
          );
          return marker && current
            ? marker.getBoundingClientRect().top -
                current.getBoundingClientRect().top
            : undefined;
        },
        async () => {
          await page
            .getByRole('button', { name: zh.schedules.conversations })
            .click();
          await page
            .getByRole('menuitemradio', { name: '正在阅读的会话', exact: true })
            .click();
          await expect
            .poll(
              () =>
                document.querySelectorAll('[data-message-id^="message-"]')
                  .length,
            )
            .toBe(28);
          await frames(5);
        },
      );
      const shown = positions.filter(
        (value): value is number => value !== undefined,
      );
      expect(shown.length).toBeGreaterThan(2);
      expect(
        Math.max(...shown.map((value) => Math.abs(value - originalY))),
      ).toBeLessThan(1);
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`opens a task dialog over a multi-task chat and preserves the draft at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const proposals = [
        fixtures.taskSnapshot!,
        { ...fixtures.taskSnapshot!, id: 'task-2', name: '另一个任务' },
      ].map((after, index) => ({
        id: `saved-${index}`,
        operation: 'create' as const,
        status: 'saved' as const,
        before: null,
        after,
        messageIndex: 28,
      }));
      fixtures.snapshot = { ...fixtures.snapshot!, proposals };
      client.setQueryData(
        ['scheduling-session', 'personal', 'audit-session'],
        fixtures.snapshot,
      );
      await page
        .getByRole('textbox', { name: zh.schedules.composer })
        .fill('保留这条草稿');
      const original = document.querySelector('[data-message-id="message-0"]');
      for (let index = 0; index < 2; index++) {
        fixtures.taskSnapshot = proposals[index]!.after;
        await page
          .getByRole('link', { name: zh.schedules.viewTask })
          .nth(index)
          .click();
        await expect.element(page.getByRole('dialog')).toBeVisible();
        await expect
          .element(
            page.getByRole('heading', {
              name: proposals[index]!.after.name,
              exact: true,
            }),
          )
          .toBeVisible();
        expect(viewport.isConnected && original!.isConnected).toBe(true);
        expect(
          document.querySelector('[data-message-id="task-details"]'),
        ).toBeNull();
        if (index === 0)
          await page.screenshot({
            path: `.vitest/attachments/schedules-task-dialog-${width}.png`,
          });
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
        await expect
          .element(page.getByRole('textbox', { name: zh.schedules.composer }))
          .toHaveValue('保留这条草稿');
      }
      await page.screenshot({
        path: `.vitest/attachments/schedules-multi-task-${width}.png`,
      });
    } finally {
      clearAudit(client);
    }
  });
}

it('continues the homepage typewriter through the stream-to-history handoff without replacing the answer node', async () => {
  const { client } = await mountAudit(1280);
  try {
    const text = '已根据你的要求保存任务。'.repeat(80);
    const base = fixtures.snapshot!;
    client.setQueryData(['scheduling-session', 'personal', 'audit-session'], {
      ...base,
      status: 'running',
    });
    client.setQueryData(['scheduling-stream', 'personal', 'audit-session'], {
      text,
      activities: [],
      pending: true,
      baseMessageCount: 28,
    });
    await frames(3);
    const row = document.querySelector('[data-message-id="message-28"]')!;
    const answer = row.querySelector('[aria-busy]')!;
    expect(answer.getAttribute('aria-busy')).toBe('true');
    const before = answer.textContent!.length;
    expect(before).toBeGreaterThan(0);
    expect(before).toBeLessThan(text.length);
    fixtures.snapshot = {
      ...base,
      revision: 2,
      messages: [
        ...base.messages,
        { id: 'final-answer', role: 'assistant', text },
      ],
    };
    client.setQueryData(
      ['scheduling-session', 'personal', 'audit-session'],
      fixtures.snapshot,
    );
    client.setQueryData(['scheduling-stream', 'personal', 'audit-session'], {
      text: '',
      activities: [],
      pending: false,
    });
    await frames(2);
    expect(document.querySelector('[data-message-id="message-28"]')).toBe(row);
    expect(row.querySelector('[aria-busy]')).toBe(answer);
    expect(answer.textContent!.length).toBeGreaterThanOrEqual(before);
    await expect.poll(() => answer.textContent, { timeout: 5000 }).toBe(text);
    expect(answer.getAttribute('aria-busy')).toBe('false');
  } finally {
    clearAudit(client);
  }
});

for (const width of [1280, 390]) {
  it(`opens the first task dialog at its final layout size after a delayed detail read at ${width}px`, async () => {
    const { client } = await mountAudit(width);
    try {
      const task = fixtures.taskSnapshot!;
      fixtures.snapshot = {
        ...fixtures.snapshot!,
        messages: [
          ...fixtures.snapshot!.messages,
          {
            id: 'task-result',
            role: 'assistant',
            text: '任务已保存。',
            proposalId: 'result-card',
          },
        ],
        proposals: [
          {
            id: 'result-card',
            operation: 'create',
            status: 'saved',
            before: null,
            after: task,
            messageIndex: 0,
          },
        ],
      };
      client.setQueryData(
        ['scheduling-session', 'personal', 'audit-session'],
        fixtures.snapshot,
      );
      const detail = gate<ScheduledTask>();
      fixtures.taskGate = detail.promise;
      await page.getByRole('link', { name: zh.schedules.viewTask }).click();
      await frames(5);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      const samples = await captureFrames(
        () => {
          const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
          return dialog
            ? {
                width: dialog.offsetWidth,
                height: dialog.offsetHeight,
                ready:
                  dialog.textContent!.includes(task.name) &&
                  !dialog.textContent!.includes(zh.schedules.loading),
              }
            : undefined;
        },
        async () => {
          detail.resolve(task);
          await expect.element(page.getByRole('dialog')).toBeVisible();
          await frames(15);
        },
      );
      const visible = samples.filter((sample) => sample !== undefined);
      expect(visible.length).toBeGreaterThan(3);
      expect(visible.every((sample) => sample.ready)).toBe(true);
      expect(
        Math.max(...visible.map((sample) => sample.width)) -
          Math.min(...visible.map((sample) => sample.width)),
      ).toBeLessThan(1);
      expect(
        Math.max(...visible.map((sample) => sample.height)) -
          Math.min(...visible.map((sample) => sample.height)),
      ).toBeLessThan(1);
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`keeps the background composer stable and updates the task card through pause/resume at ${width}px`, async () => {
    const { client } = await mountAudit(width);
    try {
      const task = fixtures.taskSnapshot!;
      fixtures.snapshot = {
        ...fixtures.snapshot!,
        messages: [
          ...fixtures.snapshot!.messages,
          {
            id: 'result',
            role: 'assistant',
            text: '天气任务已创建。',
            proposalId: 'create-card',
          },
        ],
        proposals: [
          {
            id: 'create-card',
            operation: 'create',
            status: 'saved',
            before: null,
            after: task,
            messageIndex: 28,
          },
        ],
      };
      client.setQueryData(
        ['scheduling-session', 'personal', 'audit-session'],
        fixtures.snapshot,
      );
      const before = JSON.stringify(fixtures.snapshot);
      await page
        .getByRole('textbox', { name: zh.schedules.composer })
        .fill('保留草稿');
      const textarea = document.querySelector('textarea')!;
      const composer = textarea.closest('[data-slot="input-group"]')!;
      const box = composer.getBoundingClientRect();
      const row = document.querySelector('[data-message-id="message-28"]')!;
      await page.getByRole('link', { name: zh.schedules.viewTask }).click();
      await expect.element(page.getByRole('dialog')).toBeVisible();
      for (const enabled of [false, true]) {
        const result = gate<ScheduledTask>();
        const updated = { ...task, enabled, version: enabled ? 'v3' : 'v2' };
        vi.mocked(changeScheduledTask).mockImplementation(async () => {
          await result.promise;
          fixtures.taskSnapshot = updated;
          return updated;
        });
        const samples = await captureFrames(
          () => ({
            mounted:
              textarea.isConnected &&
              row.isConnected &&
              composer ===
                document
                  .querySelector('textarea')
                  ?.closest('[data-slot="input-group"]'),
            disabled: textarea.disabled,
            value: textarea.value,
            top: composer.getBoundingClientRect().top,
            height: composer.getBoundingClientRect().height,
            stopping: Boolean(
              composer.querySelector(`[aria-label="${zh.schedules.stop}"]`),
            ),
          }),
          async () => {
            await page
              .getByRole('dialog')
              .getByRole('button', {
                name: enabled ? zh.schedules.resume : zh.schedules.pause,
                exact: true,
              })
              .click();
            await frames(5);
            result.resolve(updated);
            await expect
              .element(
                page.getByRole('dialog').getByRole('button', {
                  name: enabled ? zh.schedules.pause : zh.schedules.resume,
                  exact: true,
                }),
              )
              .toBeVisible();
            fixtures.listeners.get('schedules-changed')!({
              payload: { workspaceId: 'personal' },
            });
            await expect.poll(() => client.isFetching()).toBe(0);
            await frames(5);
          },
        );
        expect(samples.length).toBeGreaterThan(4);
        expect(
          samples.every(
            (sample) =>
              sample.mounted &&
              !sample.disabled &&
              !sample.stopping &&
              sample.value === '保留草稿',
          ),
        ).toBe(true);
        expect(
          Math.max(...samples.map((sample) => Math.abs(sample.top - box.top))),
        ).toBeLessThan(1);
        expect(
          Math.max(
            ...samples.map((sample) => Math.abs(sample.height - box.height)),
          ),
        ).toBeLessThan(1);
        const card = Array.from(
          document.querySelectorAll('[role="region"]'),
        ).find((element) => element.getAttribute('aria-label') === task.name)!;
        expect(card.querySelector('[data-slot="badge"]')!.textContent).toBe(
          enabled ? zh.schedules.active : zh.schedules.paused,
        );
        expect(
          JSON.stringify(
            client.getQueryData([
              'scheduling-session',
              'personal',
              'audit-session',
            ]),
          ),
        ).toBe(before);
      }
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await expect
        .element(page.getByRole('textbox', { name: zh.schedules.composer }))
        .toHaveValue('保留草稿');
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`keeps saved-task recovery readable and separate from the task action at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const saved: SchedulingSession = {
        ...auditSnapshot(),
        revision: 2,
        receiptPending: true,
        error: '模型服务暂时不可用，请稍后重试。',
        proposals: [
          {
            id: 'recovery',
            operation: 'create',
            status: 'saved',
            before: null,
            after: fixtures.taskSnapshot!,
            messageIndex: 28,
          },
        ],
      };
      fixtures.snapshot = saved;
      client.setQueryData(['scheduling-session', 'personal', saved.id], saved);
      await frames();
      viewport.scrollTop = viewport.scrollHeight;
      await frames();
      await expect
        .element(page.getByText(zh.schedules.savedReplyFailed))
        .toBeVisible();
      await expect
        .element(page.getByRole('button', { name: zh.schedules.retryReply }))
        .toBeEnabled();
      await expect
        .element(page.getByText(zh.schedules.savedReplyHint))
        .toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `.vitest/attachments/schedules-recovery-${width}.png`,
      });
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`updates deleted task result cards without reviving stale details at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const saved: SchedulingSession = {
        ...auditSnapshot(),
        revision: 2,
        proposals: [
          {
            id: 'deleted-result',
            operation: 'create',
            status: 'saved',
            before: null,
            after: fixtures.taskSnapshot!,
            messageIndex: 28,
          },
        ],
      };
      fixtures.snapshot = saved;
      client.setQueryData(['scheduling-session', 'personal', saved.id], saved);
      client.setQueryData(
        ['schedule', 'personal', 'task-1'],
        fixtures.taskSnapshot,
      );
      await expect
        .element(page.getByRole('link', { name: zh.schedules.viewTask }))
        .toBeVisible();
      client.setQueryData(['schedules', 'personal'], []);
      const card = page.getByRole('region', {
        name: fixtures.taskSnapshot!.name,
      });
      await expect
        .element(card.getByRole('status'))
        .toHaveTextContent(zh.apps.schedules.deleted);
      await expect.element(card.getByRole('link')).not.toBeInTheDocument();
      await expect
        .element(card.getByText(zh.schedules.active, { exact: true }))
        .not.toBeInTheDocument();
      expect(card.element().textContent).not.toContain(zh.schedules.next);
      await frames();
      viewport.scrollTop = viewport.scrollHeight;
      await frames();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: `.vitest/attachments/schedules-deleted-${width}.png`,
      });
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`keeps confirmation reply text and its DOM stable through native finalization at ${width}px`, async () => {
    const { client, viewport } = await mountAudit(width);
    try {
      const proposal = {
        id: 'stable-receipt',
        operation: 'create' as const,
        status: 'waiting' as const,
        before: null,
        after: fixtures.taskSnapshot!,
        messageIndex: 28,
      };
      const pending: SchedulingSession = {
        ...fixtures.snapshot!,
        revision: 2,
        proposals: [proposal],
        pending: proposal.id,
      };
      fixtures.snapshot = pending;
      pushSession();
      const decision = gate<SchedulingSession>();
      const reply = gate<SchedulingSession>();
      fixtures.decisionGate = decision.promise;
      fixtures.replyGate = reply.promise;
      await page
        .getByRole('button', { name: zh.schedules.confirm.create })
        .click();
      const saved: SchedulingSession = {
        ...pending,
        revision: 3,
        pending: null,
        receiptPending: true,
        proposals: [{ ...proposal, status: 'saved' }],
      };
      fixtures.snapshot = saved;
      decision.resolve(saved);
      await expect.poll(() => Boolean(fixtures.receive)).toBe(true);
      const answer = '日程已保存：User Info App 将在每天上午十点自动运行。';
      fixtures.receive!({ type: 'phase_start', phaseId: 'receipt-stable' });
      fixtures.receive!({
        type: 'reasoning',
        phaseId: 'receipt-stable',
        id: 'receipt-thought',
        text: '确认任务保存结果',
        complete: true,
        durationMs: 1000,
      });
      fixtures.receive!({
        type: 'text_delta',
        phaseId: 'receipt-stable',
        text: answer,
      });
      await expect
        .element(page.getByText(answer, { exact: true }))
        .toBeVisible();
      const text = page.getByText(answer, { exact: true }).element();
      const result = page
        .getByRole('region', { name: fixtures.taskSnapshot!.name, exact: true })
        .element();
      const message = text.closest('[data-message-id]');
      const resultOffset =
        result.getBoundingClientRect().top + viewport.scrollTop;
      const samples = await captureFrames(
        () => ({
          textMounted: text.isConnected,
          resultMounted: result.isConnected,
          replyVisible: document.body.textContent!.includes(answer),
          resultOffset: result.getBoundingClientRect().top + viewport.scrollTop,
        }),
        async () => {
          // A status read can arrive before the final answer transaction and before the IPC return.
          fixtures.snapshot = {
            ...saved,
            revision: 4,
            status: 'interrupted',
            receiptPending: true,
          };
          pushSession();
          await expect
            .poll(
              () =>
                client.getQueryData<SchedulingSession>([
                  'scheduling-session',
                  'personal',
                  'audit-session',
                ])?.revision,
            )
            .toBe(4);
          await frames(4);
          await expect
            .element(page.getByText(zh.schedules.interrupted, { exact: true }))
            .not.toBeInTheDocument();
          const complete: SchedulingSession = {
            ...saved,
            revision: 5,
            receiptPending: false,
            messages: [
              ...saved.messages,
              {
                id: 'final-receipt',
                role: 'assistant',
                text: answer,
                proposalId: proposal.id,
                reasoning: [
                  {
                    id: 'receipt-thought',
                    phaseId: 'receipt-stable',
                    turnId: 'receipt-stable',
                    text: '确认任务保存结果',
                    complete: true,
                    durationMs: 1000,
                  },
                ],
              },
            ],
          };
          fixtures.snapshot = complete;
          pushSession();
          await expect
            .poll(
              () =>
                client.getQueryData<SchedulingSession>([
                  'scheduling-session',
                  'personal',
                  'audit-session',
                ])?.revision,
            )
            .toBe(5);
          await frames(4);
          reply.resolve(complete);
          await expect
            .element(
              page.getByRole('button', {
                name: zh.schedules.send,
                exact: true,
              }),
            )
            .toBeVisible();
          await frames(4);
        },
      );
      expect(
        samples.every(
          (frame) =>
            frame.textMounted &&
            frame.resultMounted &&
            frame.replyVisible &&
            Math.abs(frame.resultOffset - resultOffset) < 1,
        ),
      ).toBe(true);
      expect(page.getByText(answer, { exact: true }).element()).toBe(text);
      expect(text.closest('[data-message-id]')).toBe(message);
      expect(result.closest('[data-message-id]')).toBe(message);
    } finally {
      clearAudit(client);
    }
  });
}

for (const width of [1280, 390]) {
  it(`covers task details with the nested deletion confirmation backdrop at ${width}px`, async () => {
    const { client } = await mountAudit(width);
    try {
      const task = fixtures.taskSnapshot!;
      const saved: SchedulingSession = {
        ...auditSnapshot(),
        revision: 2,
        proposals: [
          {
            id: 'delete-overlay',
            operation: 'create',
            status: 'saved',
            before: null,
            after: task,
            messageIndex: 28,
          },
        ],
      };
      fixtures.snapshot = saved;
      client.setQueryData(['scheduling-session', 'personal', saved.id], saved);
      await page.getByRole('link', { name: zh.schedules.viewTask }).click();
      const details = page.getByRole('dialog');
      await expect.element(details).toBeVisible();
      await details
        .getByRole('button', { name: zh.schedules.delete, exact: true })
        .click();
      const confirmation = page.getByRole('alertdialog');
      await expect.element(confirmation).toBeVisible();
      const overlay = document.querySelector<HTMLElement>(
        '[data-slot="alert-dialog-overlay"]',
      );
      expect(overlay).not.toBeNull();
      await expect
        .poll(() => Number(getComputedStyle(overlay!).opacity))
        .toBe(1);
      const bounds = overlay!.getBoundingClientRect();
      expect(bounds.left).toBe(0);
      expect(bounds.top).toBe(0);
      expect(bounds.width).toBe(width);
      expect(bounds.height).toBe(900);
      const behind = document.querySelector<HTMLElement>(
        '[data-slot="dialog-content"]',
      )!;
      const rectangle = behind.getBoundingClientRect();
      // Hit-test the detail header outside the centered confirmation, not merely z-index values.
      const hit = document.elementFromPoint(
        rectangle.left + 8,
        rectangle.top + 8,
      );
      expect(hit).toBe(overlay);
      expect(behind.contains(hit)).toBe(false);
      await page.screenshot({
        path: `.vitest/attachments/schedules-delete-overlay-${width}.png`,
      });
      await confirmation
        .getByRole('button', { name: zh.common.cancel, exact: true })
        .click();
      await expect.element(confirmation).not.toBeInTheDocument();
      await expect.element(details).toBeVisible();
      await expect
        .element(
          details.getByRole('button', {
            name: zh.schedules.delete,
            exact: true,
          }),
        )
        .toBeEnabled();
      vi.mocked(changeScheduledTask).mockClear();
      vi.mocked(changeScheduledTask).mockResolvedValue(null);
      await details
        .getByRole('button', { name: zh.schedules.delete, exact: true })
        .click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: zh.schedules.delete, exact: true })
        .click();
      await expect
        .poll(() => vi.mocked(changeScheduledTask).mock.calls.length)
        .toBe(1);
      await expect.element(details).not.toBeInTheDocument();
    } finally {
      clearAudit(client);
    }
  });
}
