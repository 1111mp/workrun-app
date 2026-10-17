import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import zh from '@/locales/zh_CN.json';

const host = vi.hoisted(() => ({
  reply: vi.fn(),
  start: vi.fn(),
  inspect: vi.fn(),
  saved: new Map(),
  compactCatalog: false,
  scope: JSON.stringify(['personal', '', '']),
}));
const state = vi.hoisted(() => ({
  config: { workspace_mode: 'personal', summary_model_profile_id: 'model' },
  teamUser: undefined,
}));
vi.mock('@/components/app-sidebar', () => ({
  useEntryWorkspace: () => host.scope,
}));
vi.mock('@/stores/workrun.store', () => ({
  useWorkrunStore: Object.assign(
    (select: (value: unknown) => unknown) => select(state),
    { getState: () => state },
  ),
}));
vi.mock('@/stores', () => ({
  useWorkrunStore: (select: (value: unknown) => unknown) => select(state),
  useRunWorkspaceStore: { getState: () => ({ openRun: vi.fn() }) },
}));
vi.mock('@/services/cmd', () => ({
  getModelCatalog: async () =>
    host.compactCatalog
      ? [
          { id: 'model', name: 'Gemini 3.5 Flash Lite', provider: 'gemini' },
          { id: 'other', name: 'GPT-5.6', provider: 'open_ai' },
        ]
      : [
          { id: 'model', name: 'Test model', provider: 'ollama' },
          {
            id: 'long',
            name: 'Gemini 3.5 Flash Lite Preview with extended reasoning and a very long model name',
            provider: 'gemini',
          },
          {
            id: 'chinese',
            name: '支持长上下文与复杂推理任务的工作助手模型预览版本',
            provider: 'open_ai',
          },
        ],
}));
vi.mock('@/services/process-node', () => ({
  prepareWorkflowProcessApps: async (dsl: unknown) => dsl,
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: (...args: unknown[]) => host.inspect(...args),
}));
vi.mock('@/services/deeplink', () => ({ validateDeeplinkInput: () => {} }));
vi.mock('@/components/workflow-actions', () => ({
  WorkflowActionCards: () => null,
}));
vi.mock('@/components/workflow-run-panel', () => ({
  WorkflowRunForm: () => <div>参数表单</div>,
}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === 'assistant_reply')
      return host.reply(args.request, args.onEvent);
    if (command === 'assistant_session_save') {
      const session = args.session as { id: string };
      host.saved.set(session.id, structuredClone(session));
      return;
    }
    if (command === 'assistant_session_get') return host.saved.get(args.id);
    throw new Error(`Unexpected command ${command}`);
  },
}));
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
vi.mock('@/services/workflow', () => {
  const workflow = {
    id: 'report',
    document: {
      nodes: [],
      edges: [],
      settings: {
        name: '报告生成',
        description: '生成销售报告',
        mode: 'task',
        inputSchema: { fields: [] },
      },
    },
  };
  return {
    getWorkflowCapabilities: async () => [workflow],
    getWorkflow: async () => workflow,
    getPublishedWorkflow: async () => workflow,
    compileWorkflow: async () => ({}),
    toWorkflowDsl: (id: string) => ({ id }),
    startBackgroundWorkflowRun: (...args: unknown[]) => host.start(...args),
    cancelBackgroundWorkflowRun: vi.fn(),
  };
});

import { useAssistantStore } from '@/stores/assistant.store';

import { Component as StartPage } from './index';

beforeEach(() => {
  vi.resetAllMocks();
  host.saved.clear();
  host.compactCatalog = false;
  useAssistantStore.setState({ sessions: {}, scopes: {}, streams: {} });
  host.start.mockResolvedValue(undefined);
  host.inspect.mockResolvedValue({
    id: 'run',
    targetName: '报告生成',
    status: 'completed',
    events: [
      {
        event: {
          type: 'done',
          state: { global: { summary: '销售额增长 10%' } },
        },
      },
    ],
  });
});

it('keeps typing focus, lets the model dispatch a workflow, and returns its result into the same conversation', async () => {
  await page.viewport(1280, 900);
  host.reply
    .mockResolvedValueOnce({
      text: '我会调用报告生成工作流。',
      content: {
        role: 'model',
        parts: [{ name: 'workflow_report', args: {}, id: 'call' }],
      },
      call: {
        workflowId: 'report',
        input: {},
        toolName: 'workflow_report',
        callId: 'call',
      },
    })
    .mockResolvedValueOnce({
      text: '报告已完成，销售额增长 10%。',
      content: {
        role: 'model',
        parts: [{ text: '报告已完成，销售额增长 10%。' }],
      },
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await screen.getByRole('textbox').fill('帮我生成销售报告');
  await expect
    .element(screen.getByRole('textbox'))
    .toHaveValue('帮我生成销售报告');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .element(screen.getByText('报告已完成，销售额增长 10%。', { exact: true }))
    .toBeVisible();
  expect(host.start).toHaveBeenCalledTimes(1);
  expect(host.reply).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(host.reply.mock.calls[1]![0])).toContain(
    '销售额增长 10%',
  );
  await screen.getByRole('textbox').fill('谢谢');
  await expect.element(screen.getByRole('textbox')).toHaveValue('谢谢');
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
  await page.screenshot({ path: '.vitest/workrun-assistant-conversation.png' });
});

it.each([1280, 390])(
  'keeps long model names readable inside the %i px viewport',
  async (width) => {
    await page.viewport(width, 900);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/start']}>
          <div className='h-dvh'>
            <StartPage />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await screen.getByRole('combobox', { name: '主控模型' }).click();
    await expect
      .element(
        screen.getByRole('option', { name: /Gemini 3.5 Flash Lite Preview/ }),
      )
      .toBeVisible();
    const option = screen
      .getByRole('option', { name: /Gemini 3.5 Flash Lite Preview/ })
      .element();
    const popupElement = option.closest('[data-slot="select-content"]')!;
    await expect
      .poll(() => popupElement.getBoundingClientRect().width)
      .toBeGreaterThanOrEqual(Math.min(351, width - 33));
    const popup = popupElement.getBoundingClientRect();
    expect(popup.width).toBeLessThanOrEqual(Math.min(352, width - 32) + 1);
    expect(popup.left).toBeGreaterThanOrEqual(0);
    expect(popup.right).toBeLessThanOrEqual(width);
    const longName = screen
      .getByText(
        'Gemini 3.5 Flash Lite Preview with extended reasoning and a very long model name',
        { exact: true },
      )
      .element();
    expect(longName.scrollWidth).toBeLessThanOrEqual(longName.clientWidth + 1);
    await page.screenshot({ path: `.vitest/workrun-model-menu-${width}.png` });
    await screen
      .getByRole('option', { name: /Gemini 3.5 Flash Lite Preview/ })
      .click();
    await expect
      .poll(
        () =>
          screen.getByRole('combobox', { name: '主控模型' }).element()
            .textContent,
      )
      .toContain('Gemini 3.5 Flash Lite Preview');
  },
);

it('sizes the model menu to short model names instead of filling its maximum width', async () => {
  host.compactCatalog = true;
  await page.viewport(1280, 900);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const trigger = screen.getByRole('combobox', { name: '主控模型' });
  await trigger.click();
  const option = screen.getByRole('option', { name: /Gemini 3.5 Flash Lite/ });
  await expect.element(option).toBeVisible();
  const popup = option.element().closest('[data-slot="select-content"]')!;
  await expect
    .poll(() => popup.getBoundingClientRect().width)
    .toBeLessThan(280);
  await expect
    .poll(() => popup.getBoundingClientRect().width)
    .toBeGreaterThanOrEqual(
      trigger.element().getBoundingClientRect().width - 1,
    );
});

it('shows streamed text while the model request is pending and replaces it with one final message', async () => {
  let finish!: (reply: {
    text: string;
    content: { role: string; parts: { text: string }[] };
  }) => void;
  let channel!: { onmessage: (event: { type: string; text: string }) => void };
  host.reply.mockImplementationOnce((_request, onEvent) => {
    channel = onEvent;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await screen.getByRole('textbox').fill('你好');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => host.reply.mock.calls.length).toBe(1);
  channel.onmessage({ type: 'text_delta', text: '你好，' });
  await expect
    .element(screen.getByText('你好，', { exact: true }))
    .toBeVisible();
  expect(host.start).not.toHaveBeenCalled();
  await expect.element(screen.getByRole('textbox')).toBeDisabled();
  channel.onmessage({ type: 'text_delta', text: '有什么可以帮你？' });
  await expect
    .element(screen.getByText('你好，有什么可以帮你？', { exact: true }))
    .toBeVisible();
  finish({
    text: '你好，有什么可以帮你？',
    content: { role: 'model', parts: [{ text: '你好，有什么可以帮你？' }] },
  });
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await expect
    .element(screen.getByText('你好，有什么可以帮你？', { exact: true }))
    .toBeVisible();
  expect(
    screen.getByText('你好，有什么可以帮你？', { exact: true }).elements(),
  ).toHaveLength(1);
  channel.onmessage({ type: 'text_delta', text: '重复片段' });
  expect(useAssistantStore.getState().streams).toEqual({});
});

it('animates a buffered response and keeps revealing it after the completed message replaces the stream preview', async () => {
  let finish!: (reply: {
    text: string;
    content: { role: string; parts: { text: string }[] };
  }) => void;
  let channel!: { onmessage: (event: { type: string; text: string }) => void };
  host.reply.mockImplementationOnce((_request, onEvent) => {
    channel = onEvent;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await screen.getByRole('textbox').fill('介绍一下你能做什么');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => host.reply.mock.calls.length).toBe(1);
  const text = '我可以帮你分析数据、调用工作流，并整理执行结果。'.repeat(60);
  channel.onmessage({ type: 'text_delta', text });
  const visibleLength = () =>
    document.querySelector('[aria-busy="true"]')?.textContent?.length ?? 0;
  await expect.poll(visibleLength).toBeGreaterThan(0);
  expect(visibleLength()).toBeLessThan(text.length);
  finish({ text, content: { role: 'model', parts: [{ text }] } });
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  expect(visibleLength()).toBeGreaterThan(0);
  expect(visibleLength()).toBeLessThan(text.length);
  await expect.element(screen.getByText(text, { exact: true })).toBeVisible();
  expect(screen.getByText(text, { exact: true }).elements()).toHaveLength(1);
});

it('places copy and feedback below the answer and saves feedback without another model call', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  try {
    host.reply.mockResolvedValueOnce({
      text: '这是一条可操作的回答。',
      content: { role: 'model', parts: [{ text: '这是一条可操作的回答。' }] },
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/start']}>
          <div className='h-dvh'>
            <StartPage />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await expect.element(screen.getByRole('textbox')).toBeEnabled();
    await screen.getByRole('textbox').fill('你好');
    await screen.getByRole('button', { name: '发送', exact: true }).click();
    await expect
      .element(screen.getByText('这是一条可操作的回答。', { exact: true }))
      .toBeVisible();
    const row = screen
      .getByText('这是一条可操作的回答。', { exact: true })
      .element()
      .closest('[data-slot="message"]')!;
    const copy = row.querySelector<HTMLButtonElement>(
      '[aria-label="复制消息"]',
    )!;
    const answerRect = row
      .querySelector('[data-slot="bubble"]')!
      .getBoundingClientRect();
    expect(copy.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      answerRect.bottom,
    );
    copy.click();
    await expect.poll(() => writeText.mock.calls.length).toBe(1);
    expect(writeText).toHaveBeenCalledWith('这是一条可操作的回答。');
    await expect
      .element(screen.getByRole('button', { name: '已复制', exact: true }))
      .toBeVisible();
    await screen.getByRole('button', { name: '有帮助', exact: true }).click();
    await expect
      .element(screen.getByRole('button', { name: '有帮助', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    expect([...host.saved.values()].at(-1).messages.at(-1).feedback).toBe(
      'helpful',
    );
    await screen.getByRole('button', { name: '没有帮助', exact: true }).click();
    await expect
      .element(screen.getByRole('button', { name: '有帮助', exact: true }))
      .toHaveAttribute('aria-pressed', 'false');
    await expect
      .element(screen.getByRole('button', { name: '没有帮助', exact: true }))
      .toHaveAttribute('aria-pressed', 'true');
    expect(host.reply).toHaveBeenCalledTimes(1);
    expect(host.start).not.toHaveBeenCalled();
    await page.screenshot({ path: '.vitest/workrun-message-actions.png' });
  } finally {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: Clipboard }).clipboard;
  }
});

it('retries a failed response from the original user message without duplicating that message', async () => {
  host.reply
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({
      text: '已恢复回复。',
      content: { role: 'model', parts: [{ text: '已恢复回复。' }] },
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await screen.getByRole('textbox').fill('帮我回答一个问题');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .element(screen.getByText('回复失败', { exact: true }))
    .toBeVisible();
  await screen.getByRole('button', { name: '重试回复', exact: true }).click();
  await expect
    .element(screen.getByText('已恢复回复。', { exact: true }))
    .toBeVisible();
  const session = Object.values(useAssistantStore.getState().sessions)[0]!;
  expect(
    session.messages.filter((message) => message.role === 'user'),
  ).toHaveLength(1);
  expect(host.reply).toHaveBeenCalledTimes(2);
  expect(host.start).not.toHaveBeenCalled();
});

it('keeps only the latest message actions visible until an older message is hovered or focused', async () => {
  host.reply
    .mockResolvedValueOnce({
      text: '第一条回答',
      content: { role: 'model', parts: [{ text: '第一条回答' }] },
    })
    .mockResolvedValueOnce({
      text: '最新回答',
      content: { role: 'model', parts: [{ text: '最新回答' }] },
    });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await screen.getByRole('textbox').fill('第一个问题');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .element(screen.getByText('第一条回答', { exact: true }))
    .toBeVisible();
  await screen.getByRole('textbox').fill('第二个问题');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .element(screen.getByText('最新回答', { exact: true }))
    .toBeVisible();
  await screen.getByRole('textbox').click();
  const row = (text: string) =>
    screen
      .getByText(text, { exact: true })
      .element()
      .closest('[data-slot="message"]')!;
  const old = row('第一条回答').querySelector<HTMLElement>(
    '[data-slot="message-footer"]',
  )!;
  const latest = row('最新回答').querySelector<HTMLElement>(
    '[data-slot="message-footer"]',
  )!;
  expect(window.matchMedia('(hover: hover)').matches).toBe(true);
  await expect.poll(() => getComputedStyle(old).opacity).toBe('0');
  expect(getComputedStyle(latest).opacity).toBe('1');
  await screen.getByText('第一条回答', { exact: true }).hover();
  await expect.poll(() => getComputedStyle(old).opacity).toBe('1');
  await screen.getByRole('textbox').click();
  await expect.poll(() => getComputedStyle(old).opacity).toBe('0');
  old.querySelector<HTMLButtonElement>('button')!.focus();
  await expect.poll(() => getComputedStyle(old).opacity).toBe('1');
});
