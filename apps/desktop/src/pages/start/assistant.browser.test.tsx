import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { page } from 'vitest/browser';

import { WorkflowBackButton } from '@/components/workflow-editor/workflow-back-button';
import zh from '@/locales/zh_CN.json';

const host = vi.hoisted(() => {
  const sequences = new Map<string, number>();
  const listeners = new Set<(event: unknown) => void>();
  const saved = new (class extends Map {
    override set(id: string, value: unknown) {
      super.set(id, value);
      const sequence = (sequences.get(id) ?? 0) + 1;
      sequences.set(id, sequence);
      for (const receive of listeners)
        receive({
          payload: {
            workspaceId: 'personal',
            sessionId: id,
            epoch: 'native-test',
            sequence,
            type: 'snapshot',
            payload: { session: structuredClone(value), stream: null },
          },
        });
      return this;
    }
  })();
  return {
    reply: vi.fn(),
    start: vi.fn(),
    inspect: vi.fn(),
    saved,
    compactCatalog: false,
    snapshotGate: undefined as Promise<void> | undefined,
    listeners,
    sequences,
    commands: [] as string[],
    scope: JSON.stringify(['personal', '', '']),
  };
});
const state = vi.hoisted(() => ({
  config: { workspace_mode: 'personal', summary_model_profile_id: 'model' },
  teamUser: undefined,
}));
vi.mock('@/lib/auth-client', () => ({
  createTeamAuthClient: () => ({ getSession: async () => ({ data: null }) }),
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
  isTauri: () => false,
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  invoke: async (command: string, args: Record<string, unknown>) => {
    host.commands.push(command);
    if (command === 'assistant_session_list')
      return {
        workspaceId: 'personal',
        sessionId: '',
        epoch: 'native-test',
        sequence: 0,
        type: 'list',
        payload: [],
      };
    if (command === 'assistant_session_get') {
      await host.snapshotGate;
      const id = args.id as string;
      return {
        workspaceId: 'personal',
        sessionId: id,
        epoch: 'native-test',
        sequence: host.sequences.get(id) ?? 0,
        type: 'snapshot',
        payload: { session: structuredClone(host.saved.get(id)), stream: null },
      };
    }
    if (command === 'assistant_turn_stop') {
      const session = structuredClone(host.saved.get(args.id));
      session.status = 'idle';
      host.saved.set(args.id as string, session);
      return session;
    }
    if (command === 'assistant_turn_start') {
      // Native-host contract substitute: the page submits a turn and observes
      // snapshots/events. Workflow ownership stays behind this IPC boundary.
      const request = args.request as {
        sessionId: string;
        action: { kind: string; text: string };
      };
      const session = structuredClone(host.saved.get(request.sessionId));
      if (request.action.kind === 'send') {
        session.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          text: request.action.text,
          content: { role: 'user', parts: [{ text: request.action.text }] },
        });
      }
      session.status = 'thinking';
      session.error = undefined;
      host.saved.set(session.id, structuredClone(session));
      const acknowledged = structuredClone(session);
      setTimeout(async () => {
        try {
          let messageId = crypto.randomUUID();
          const channel = {
            onmessage: (event: unknown) => {
              const sequence = (host.sequences.get(session.id) ?? 0) + 1;
              host.sequences.set(session.id, sequence);
              host.listeners.forEach((receive) =>
                receive({
                  payload: {
                    workspaceId: 'personal',
                    sessionId: session.id,
                    epoch: 'native-test',
                    sequence,
                    type: 'stream',
                    payload: { sessionId: session.id, messageId, event },
                  },
                }),
              );
            },
          };
          let reply = await host.reply(
            {
              contents: session.messages.map(
                (message: { content: unknown }) => message.content,
              ),
            },
            channel,
          );
          session.messages.push({
            id: messageId,
            role: 'assistant',
            text: reply.text,
            content: reply.content,
          });
          if (reply.call) {
            session.status = 'running';
            session.activeCall = {
              ...reply.call,
              runId: 'run',
              workflow: { document: { settings: { name: '报告生成' } } },
            };
            host.saved.set(session.id, structuredClone(session));
            await host.start();
            const record = await host.inspect('run');
            const response = {
              status: record.status,
              result: record.events.at(-1)?.event.state,
            };
            session.messages.push({
              id: crypto.randomUUID(),
              role: 'tool',
              text: record.status,
              runId: 'run',
              workflowName: '报告生成',
              content: {
                role: 'function',
                parts: [
                  {
                    functionResponse: { name: reply.call.toolName, response },
                    id: reply.call.callId,
                  },
                ],
              },
            });
            session.activeCall = null;
            messageId = crypto.randomUUID();
            reply = await host.reply(
              {
                contents: session.messages.map(
                  (message: { content: unknown }) => message.content,
                ),
              },
              channel,
            );
            session.messages.push({
              id: messageId,
              role: 'assistant',
              text: reply.text,
              content: reply.content,
            });
          }
          session.status = 'idle';
          host.saved.set(session.id, structuredClone(session));
        } catch (error) {
          session.status = 'error';
          session.error = String(error);
          host.saved.set(session.id, structuredClone(session));
        }
      }, 0);
      return acknowledged;
    }
    if (command === 'assistant_session_save') {
      const session = args.session as { id: string };
      host.saved.set(session.id, structuredClone(session));
      return;
    }
    throw new Error(`Unexpected command ${command}`);
  },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (_name: string, receive: (event: unknown) => void) => {
    host.listeners.add(receive);
    return () => host.listeners.delete(receive);
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
    subscribeWorkflowRun: async () => () => {},
  };
});

import { useAssistantStore } from '@/stores/assistant.store';
const { disposeAssistantEvents } = useAssistantStore.getState();

import { Component as StartPage } from './index';

beforeEach(() => {
  disposeAssistantEvents();
  host.sequences.clear();
  host.commands.length = 0;
  vi.resetAllMocks();
  localStorage.clear();
  host.saved.clear();
  host.listeners.clear();
  host.compactCatalog = false;
  host.snapshotGate = undefined;
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

it('keeps the composer at the bottom while restoring a recent conversation', async () => {
  let release!: () => void;
  host.snapshotGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.saved.set('history', {
    id: 'history',
    title: '历史对话',
    modelId: 'model',
    status: 'idle',
    steps: 0,
    messages: [
      {
        id: 'user-1',
        role: 'user',
        text: '之前的消息',
        content: { role: 'user', parts: [{ text: '之前的消息' }] },
      },
    ],
  });
  const screen = await render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/start?session=history']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(
      screen.getByRole('status', { name: zh.assistant.loadingConversation }),
    )
    .toBeVisible();
  await expect
    .element(screen.getByRole('heading', { name: zh.start.title }))
    .not.toBeInTheDocument();
  const textbox = screen.getByRole('textbox');
  await expect.element(textbox).toBeDisabled();
  const bottom = textbox.element().getBoundingClientRect().bottom;
  release();
  await expect
    .element(screen.getByText('之前的消息', { exact: true }))
    .toBeVisible();
  await expect.element(textbox).toBeEnabled();
  expect(
    Math.abs(textbox.element().getBoundingClientRect().bottom - bottom),
  ).toBeLessThan(1);
});

it('allows drafting during a response and sends the preserved draft after stopping', async () => {
  host.reply
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({
      text: '第二次回答',
      content: { role: 'model', parts: [{ text: '第二次回答' }] },
    });
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const textbox = screen.getByRole('textbox');
  await textbox.fill('第一条');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  const stop = screen.getByRole('button', { name: '停止回答' });
  await expect.element(stop).toBeEnabled();
  await expect.poll(() => host.reply.mock.calls.length).toBe(1);
  await expect
    .element(screen.getByText('第一条', { exact: true }))
    .toBeVisible();
  await textbox.fill('下一条');
  textbox
    .element()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  expect([...host.saved.values()][0].messages).toHaveLength(1);
  await stop.click();
  const send = screen.getByRole('button', { name: '发送', exact: true });
  await expect.element(textbox).toHaveValue('下一条');
  await expect.element(send).toBeEnabled();
  await send.click();
  await expect
    .element(screen.getByText('第二次回答', { exact: true }))
    .toBeVisible();
  expect(
    [...host.saved.values()][0].messages.filter(
      (message: { role: string }) => message.role === 'user',
    ),
  ).toHaveLength(2);
});

it('remembers the selected model when opening a new conversation', async () => {
  host.compactCatalog = true;
  const client = new QueryClient();
  const chat = (key: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/start']}>
        <StartPage key={key} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const screen = await render(chat('first'));
  const selector = screen.getByRole('combobox', { name: '主控模型' });
  await selector.click();
  await screen.getByRole('option', { name: /GPT-5.6/ }).click();
  await screen.rerender(chat('new'));
  await expect.poll(() => selector.element().textContent).toContain('GPT-5.6');
});

it('keeps typing focus, lets the model dispatch a workflow, and returns its result into the same conversation', async () => {
  await page.viewport(1280, 900);
  host.reply
    .mockResolvedValueOnce({
      text: '我会调用报告生成工作流。',
      content: {
        role: 'model',
        parts: [{ name: 'execute_workflow', args: {}, id: 'call' }],
      },
      call: {
        workflowId: 'report',
        input: {},
        toolName: 'execute_workflow',
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
  expect(
    screen.getByRole('button', { name: '有帮助', exact: true }).elements(),
  ).toHaveLength(1);
  expect(host.start).toHaveBeenCalledTimes(1);
  expect(host.reply).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(host.reply.mock.calls[1]![0])).toContain(
    '销售额增长 10%',
  );
  await screen.getByRole('textbox').fill('谢谢');
  await expect.element(screen.getByRole('textbox')).toHaveValue('谢谢');
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
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
  const textbox = screen.getByRole('textbox');
  const composer = textbox.element().closest('[data-slot="input-group"]')!;
  expect(getComputedStyle(composer).cursor).toBe('text');
  expect(getComputedStyle(textbox.element()).cursor).toBe('text');
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
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  await expect
    .element(screen.getByRole('button', { name: '停止回答' }))
    .toBeEnabled();
  channel.onmessage({ type: 'text_delta', text: '有什么可以帮你？' });
  await expect
    .element(screen.getByText('你好，有什么可以帮你？', { exact: true }))
    .toBeVisible();
  finish({
    text: '你好，有什么可以帮你？',
    content: { role: 'model', parts: [{ text: '你好，有什么可以帮你？' }] },
  });
  await expect
    .element(screen.getByRole('button', { name: '发送', exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByText('你好，有什么可以帮你？', { exact: true }))
    .toBeVisible();
  expect(
    screen.getByText('你好，有什么可以帮你？', { exact: true }).elements(),
  ).toHaveLength(1);
  channel.onmessage({ type: 'text_delta', text: '重复片段' });
  expect(useAssistantStore.getState().streams).toEqual({});
  expect(host.commands.some((command) => command.includes('subscribe'))).toBe(
    false,
  );
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

it('keeps an expanded execution in place when the final assistant answer arrives', async () => {
  let finish!: (record: unknown) => void;
  const waiting = new Promise((resolve) => {
    finish = resolve;
  });
  host.inspect.mockImplementation(() => waiting);
  host.reply
    .mockResolvedValueOnce({
      text: '开始处理。',
      content: {
        role: 'model',
        parts: [{ name: 'execute_workflow', args: {}, id: 'call' }],
      },
      call: {
        workflowId: 'report',
        input: {},
        toolName: 'execute_workflow',
        callId: 'call',
      },
    })
    .mockResolvedValueOnce({
      text: '已根据执行结果完成处理。',
      content: { role: 'model', parts: [{ text: '已根据执行结果完成处理。' }] },
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
  await screen.getByRole('textbox').fill('生成报告');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await screen
    .getByTestId('assistant-workflow-run')
    .getByRole('button', { expanded: false })
    .click();
  const timeline = screen.getByTestId('workflow-run-timeline').element();
  finish({
    id: 'run',
    targetName: '报告生成',
    status: 'completed',
    spans: [],
    events: [
      {
        sequence: 0,
        event: {
          type: 'done',
          state: { global: {}, nodes: {}, workflow: {} },
          total_steps: 0,
        },
      },
    ],
  });
  await expect
    .element(screen.getByText('已根据执行结果完成处理。', { exact: true }))
    .toBeVisible();
  expect(screen.getByTestId('workflow-run-timeline').element()).toBe(timeline);
  expect(host.start).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[data-slot="drawer-content"]')).toBeNull();
});

it('right-aligns user bubbles and folds phase summaries when thinking ends', async () => {
  const session = {
    id: 'activity-lifecycle',
    title: '取消订单',
    modelId: 'model',
    status: 'idle' as const,
    steps: 0,
    messages: [
      {
        id: 'user',
        role: 'user' as const,
        text: '取消订单 43',
        content: { role: 'user', parts: [] },
      },
      {
        id: 'preamble',
        role: 'assistant' as const,
        text: '正在查找工作流',
        content: {
          role: 'model',
          parts: [{ name: 'execute_workflow', args: {} }],
        },
      },
    ],
    activities: [
      { id: 'progress', turnId: 'user', summary: '正在校验订单参数' },
    ],
  };
  host.saved.set(session.id, session);
  useAssistantStore.setState({
    sessions: { [session.id]: session },
    scopes: { [session.id]: host.scope },
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/start?session=${session.id}`]}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByText('取消订单 43', { exact: true }))
    .toBeVisible();
  const bubble = document.querySelector(
    '[data-align="end"] [data-slot="bubble"]',
  )!;
  const message = bubble.closest('[data-slot="message"]')!;
  expect(
    Math.abs(
      bubble.getBoundingClientRect().right -
        message.getBoundingClientRect().right,
    ),
  ).toBeLessThanOrEqual(1);
  useAssistantStore.setState({
    sessions: { [session.id]: { ...session, status: 'thinking' } },
  });
  await page.getByRole('button', { name: '正在思考' }).click();
  await expect
    .element(page.getByText('正在校验订单参数', { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText('正在查找工作流', { exact: true }))
    .not.toBeInTheDocument();
  // A second model phase follows execution; old discovery hints must vanish,
  // and newly reported delivery progress must become visible instead.
  useAssistantStore.setState({
    sessions: {
      [session.id]: {
        ...session,
        status: 'thinking',
        responsePhaseId: 'delivery',
        activities: [
          {
            id: 'old',
            turnId: 'user',
            phaseId: 'discovery',
            summary: '正在查找工作流',
          },
          {
            id: 'new',
            turnId: 'user',
            phaseId: 'delivery',
            summary: '正在整理执行结果',
          },
        ],
      },
    },
  });
  await expect
    .element(page.getByText('正在查找工作流', { exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole('button', { name: '正在思考' }).click();
  await expect
    .element(page.getByText('正在整理执行结果', { exact: true }))
    .toBeVisible();
  for (const status of ['running', 'needs_input', 'idle', 'error'] as const) {
    useAssistantStore.setState({
      sessions: { [session.id]: { ...session, status } },
    });
    await expect
      .element(page.getByText('正在校验订单参数', { exact: true }))
      .not.toBeInTheDocument();
  }
});

it('streams reasoning through Trace, collapses for the answer and preserves reader choices', async () => {
  const { AssistantTurnActivity } = await import('./assistant-turn-activity');
  const thought = {
    id: 'thinking-1',
    turnId: 'user',
    phaseId: 'phase',
    text: '先核对输入数据',
    durationMs: 2400,
    complete: false,
  };
  const screen = await render(
    <AssistantTurnActivity summaries={[]} reasoning={[thought]} busy />,
  );
  await expect
    .element(page.getByRole('button', { name: '正在思考' }))
    .toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: '正在思考' }).click();
  await expect.element(page.getByText(thought.text)).toBeVisible();
  await screen.rerender(
    <AssistantTurnActivity
      summaries={[]}
      reasoning={[{ ...thought, text: `${thought.text}，然后验证结果。` }]}
      busy
    />,
  );
  await expect
    .element(page.getByText('先核对输入数据，然后验证结果。'))
    .toBeVisible();
  await screen.rerender(
    <AssistantTurnActivity
      summaries={[]}
      reasoning={[{ ...thought, complete: true }]}
      busy={false}
    />,
  );
  const completed = page.getByRole('button', { name: /已思考/ });
  await expect.element(completed).toHaveAttribute('aria-expanded', 'false');
  await completed.click();
  await expect.element(page.getByText(thought.text)).toBeVisible();
  await screen.rerender(
    <AssistantTurnActivity summaries={[]} reasoning={[thought]} busy />,
  );
  const thinking = page.getByRole('button', { name: '正在思考' });
  await expect.element(thinking).toHaveAttribute('aria-expanded', 'false');
  await screen.rerender(
    <AssistantTurnActivity
      summaries={['正在校验']}
      reasoning={[{ ...thought, text: '更新后的思考' }]}
      busy
    />,
  );
  await expect.element(thinking).toHaveAttribute('aria-expanded', 'false');
  await expect
    .poll(
      () =>
        screen
          .getByTestId('assistant-thinking')
          .element()
          .getBoundingClientRect().height,
    )
    .toBeLessThan(40);
});

it('removes stale preparation reports after completion even if the reader expanded them', async () => {
  const { AssistantTurnActivity } = await import('./assistant-turn-activity');
  const summaries = ['正在为您准备执行订单号 43 的取消工作流...'];
  const screen = await render(
    <AssistantTurnActivity summaries={summaries} busy />,
  );
  const trigger = page.getByRole('button', { name: '正在思考' });
  await trigger.click();
  await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
  await screen.rerender(
    <AssistantTurnActivity summaries={summaries} busy={false} />,
  );
  await expect.element(page.getByText(summaries[0]!)).not.toBeInTheDocument();
  await expect
    .element(page.getByTestId('assistant-thinking'))
    .not.toBeInTheDocument();
});

it('switches the model for the next message in an existing conversation', async () => {
  host.compactCatalog = true;
  host.reply.mockResolvedValue({
    text: '完成',
    content: { role: 'model', parts: [{ text: '完成' }] },
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
  const textbox = screen.getByRole('textbox');
  await textbox.fill('第一条');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect.element(textbox).toBeEnabled();
  const selector = screen.getByRole('combobox', { name: '主控模型' });
  await selector.click();
  await screen.getByRole('option', { name: /GPT-5.6/ }).click();
  await textbox.fill('第二条');
  await screen.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => host.reply.mock.calls.length).toBe(2);
  expect([...host.saved.values()][0].modelId).toBe('other');
  expect(
    [...host.saved.values()][0].messages.filter(
      (message: { role: string }) => message.role === 'user',
    ),
  ).toHaveLength(2);
});

it('keeps plan snapshots between their user request and response across later turns', async () => {
  const plan = {
    id: 'ordered-plan',
    sessionId: 'ordered-session',
    version: 1,
    status: 'ready' as const,
    dependencyIssues: [],
    document: {
      goal: 'Reusable processing',
      summary: 'Original proposal',
      inputs: [],
      outputs: [],
      steps: [],
      constraints: [],
      assumptions: [],
      questions: [],
      acceptance_criteria: [],
    },
  };
  const saved = {
    ...plan,
    status: 'saved' as const,
    document: { ...plan.document, summary: 'Created configuration' },
  };
  const message = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    text,
    content: { role: role === 'user' ? 'user' : 'model', parts: [{ text }] },
  });
  const session = {
    id: plan.sessionId,
    title: 'Plan ordering',
    modelId: 'model',
    status: 'idle' as const,
    steps: 0,
    messages: [
      message('u1', 'user', 'Prepare a reusable process'),
      message('a1', 'assistant', 'Please review the proposal'),
      message('u2', 'user', 'Confirm creation'),
      message('a2', 'assistant', 'Configuration saved'),
    ],
    workflowPlan: saved,
    workflowPlans: [
      { turnId: 'u1', plan },
      { turnId: 'u2', plan: saved },
    ],
  };
  host.saved.set(session.id, session);
  useAssistantStore.setState({
    sessions: { [session.id]: session },
    scopes: { [session.id]: host.scope },
  });
  await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/start?session=${session.id}`]}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(page.getByText('Original proposal', { exact: true }))
    .toBeInTheDocument();
  const texts = [
    'Prepare a reusable process',
    'Original proposal',
    'Please review the proposal',
    'Confirm creation',
    'Created configuration',
    'Configuration saved',
  ];
  const nodes = texts.map((text) =>
    page.getByText(text, { exact: true }).element(),
  );
  for (let i = 1; i < nodes.length; i++)
    expect(
      nodes[i - 1]!.compareDocumentPosition(nodes[i]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  expect(
    page.getByRole('button', { name: '确认并创建' }).elements(),
  ).toHaveLength(0);
});

it('keeps a paused tool request on its original turn while allowing unrelated conversation', async () => {
  const confirmation = {
    id: 'tool-operation',
    turnId: 'u1',
    turnKey: 'turn-key',
    tool: { id: 'mcp:configured:tool', displayName: 'Configured tool' },
    arguments: { value: 2 },
    interaction: {
      id: 'tool:tool-operation',
      taskId: 'tool-operation',
      threadId: 'thread',
      checkpointId: 'checkpoint',
      version: 1,
      kind: 'tool_confirmation' as const,
      status: 'waiting' as const,
    },
  };
  const message = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    text,
    content: { role: role === 'user' ? 'user' : 'model', parts: [{ text }] },
  });
  const session = {
    id: 'tool-waiting-session',
    title: 'Pending tool',
    modelId: 'model',
    status: 'awaiting_feedback' as const,
    steps: 0,
    pendingTool: confirmation,
    toolConfirmations: [confirmation],
    messages: [
      message('u1', 'user', 'Use the selected tool'),
      message('a1', 'assistant', 'Please review this call'),
      message('u2', 'user', 'Explain its scope first'),
      message('a2', 'assistant', 'It applies only to the displayed arguments'),
    ],
  };
  host.saved.set(session.id, session);
  useAssistantStore.setState({
    sessions: { [session.id]: session },
    scopes: { [session.id]: host.scope },
  });
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/start?session=${session.id}`]}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(screen.getByRole('button', { name: '确认调用', exact: true }))
    .toBeEnabled();
  await expect.element(screen.getByRole('textbox')).toBeEnabled();
  const proposal = screen
    .getByText('Configured tool', { exact: true })
    .element();
  const followup = screen
    .getByText('Explain its scope first', { exact: true })
    .element();
  expect(
    proposal.compareDocumentPosition(followup) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(host.start).not.toHaveBeenCalled();
});

it('shows only the plan card at the pause and a native notice for an unconfirmed run without another plan', async () => {
  const plan = {
    id: 'paused-plan',
    sessionId: 'paused-session',
    version: 1,
    status: 'ready' as const,
    dependencyIssues: [],
    interaction: {
      id: 'paused-plan:v1',
      taskId: 'paused-plan',
      threadId: 'thread',
      checkpointId: 'checkpoint',
      version: 1,
      kind: 'plan_confirmation' as const,
      status: 'waiting' as const,
    },
    document: {
      goal: 'Reusable task',
      summary: 'Review this proposal',
      inputs: [],
      outputs: ['Result'],
      steps: [],
      constraints: [],
      assumptions: [],
      questions: [],
      acceptance_criteria: [],
    },
  };
  const session = {
    id: plan.sessionId,
    title: 'Paused planning',
    modelId: 'model',
    status: 'awaiting_feedback' as const,
    steps: 0,
    messages: [
      {
        id: 'user1',
        role: 'user' as const,
        text: 'Prepare a reusable process',
        content: {
          role: 'user',
          parts: [{ text: 'Prepare a reusable process' }],
        },
      },
    ],
    workflowPlan: plan,
    workflowPlans: [{ turnId: 'user1', plan }],
  };
  host.saved.set(session.id, session);
  useAssistantStore.setState({
    sessions: { [session.id]: session },
    scopes: { [session.id]: host.scope },
  });
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/start?session=${session.id}`]}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(screen.getByText('Review this proposal', { exact: true }))
    .toBeVisible();
  expect(
    document.querySelectorAll('[data-align="start"] [data-slot="bubble"]'),
  ).toHaveLength(0);
  await expect
    .element(
      screen.getByRole('button', { name: '确认方案并创建', exact: true }),
    )
    .toBeEnabled();
  const item = document.querySelector<HTMLElement>(
    '[data-message-id="reply-user1"]',
  )!;
  expect(getComputedStyle(item).contentVisibility).toBe('visible');
  for (let index = 0; index < 3; index++) {
    await screen.getByRole('button', { name: '收起方案', exact: true }).click();
    await screen
      .getByRole('button', { name: '查看完整方案', exact: true })
      .click();
    await screen.getByRole('button', { name: '查看节点选择与配置' }).click();
    // Native snapshots arrive during planning; they must retain the card DOM
    // and both expansion states rather than replay the interaction.
    host.saved.set(session.id, structuredClone(session));
    await expect
      .element(screen.getByText('Reusable task', { exact: true }))
      .toBeVisible();
    expect(document.querySelector('[data-message-id="reply-user1"]')).toBe(
      item,
    );
    await screen.getByRole('button', { name: '查看节点选择与配置' }).click();
  }
  const updated = {
    ...session,
    messages: [
      ...session.messages,
      {
        id: 'user2',
        role: 'user' as const,
        text: '执行一下呢',
        content: { role: 'user', parts: [{ text: '执行一下呢' }] },
      },
      {
        id: 'notice',
        role: 'assistant' as const,
        text: '',
        notice: 'plan_confirmation_required' as const,
        content: {
          role: 'model',
          parts: [{ text: 'Native state: confirmation required' }],
        },
      },
    ],
  };
  host.saved.set(session.id, updated);
  useAssistantStore.setState({ sessions: { [session.id]: updated } });
  await expect
    .element(
      screen.getByText(zh.assistant.plan.confirmationRequired, { exact: true }),
    )
    .toBeInTheDocument();
  expect(
    screen.getByText('Review this proposal', { exact: true }).elements(),
  ).toHaveLength(1);
  expect(host.reply).not.toHaveBeenCalled();
  expect(host.start).not.toHaveBeenCalled();
});

it('restores the chosen workflow confirmation in its conversation turn without starting a run', async () => {
  const confirmation = {
    id: 'confirm',
    turnId: 'request',
    workflowId: 'report',
    name: '文档整理流程',
    description: '核对输入并整理文档。',
    input: { document: 'selected-document' },
    status: 'waiting',
    changed: false,
  };
  host.saved.set('confirm-run', {
    id: 'confirm-run',
    title: '执行确认',
    modelId: 'model',
    status: 'awaiting_run_confirmation',
    steps: 1,
    messages: [
      {
        id: 'request',
        role: 'user',
        text: '整理这份文档',
        content: { role: 'user', parts: [{ text: '整理这份文档' }] },
      },
    ],
    activeCall: {
      workflowId: 'report',
      toolName: 'execute_capability',
      input: confirmation.input,
      confirmation,
      workflow: {
        id: 'report',
        document: { settings: { name: confirmation.name } },
      },
    },
    workflowConfirmations: [confirmation],
  });
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/start?session=confirm-run']}>
        <StartPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect.element(page.getByText('文档整理流程')).toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '确认执行' }))
    .toBeVisible();
  await expect
    .element(page.getByRole('button', { name: '不是这个工作流', exact: true }))
    .toBeVisible();
  expect(host.commands).not.toContain('assistant_turn_start');
  expect(host.start).not.toHaveBeenCalled();
});

it('restores the reading position when returning from a workflow', async () => {
  await page.viewport(1280, 900);
  const messages = Array.from({ length: 4 }, (_, index) => [
    {
      id: `user-${index}`,
      role: 'user',
      text: `问题 ${index}`,
      content: { role: 'user', parts: [{ text: `问题 ${index}` }] },
    },
    {
      id: `answer-${index}`,
      role: 'assistant',
      text: Array.from({ length: 60 }, (_, line) => `分析第 ${line} 行。`).join(
        '\n\n',
      ),
      content: {
        role: 'model',
        parts: [
          {
            text: Array.from(
              { length: 60 },
              (_, line) => `分析第 ${line} 行。`,
            ).join('\n\n'),
          },
        ],
      },
    },
  ]).flat();
  host.saved.set('long-history', {
    id: 'long-history',
    title: '长对话',
    modelId: 'model',
    status: 'idle',
    steps: 0,
    messages,
  });
  await render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/start?session=long-history']}>
        <Routes>
          <Route
            path='/start'
            element={
              <>
                <div className='h-dvh'>
                  <StartPage />
                </div>
                <Link
                  style={{ position: 'fixed', top: 0 }}
                  to='/workflows/report'
                  state={{ assistantReturnTo: '/start?session=long-history' }}
                >
                  Open workflow
                </Link>
              </>
            }
          />
          <Route path='/workflows/:id' element={<WorkflowBackButton />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .poll(
      () =>
        document.querySelector<HTMLElement>(
          '[data-slot="message-scroller-viewport"]',
        )?.scrollTop ?? 0,
    )
    .toBeGreaterThan(1000);
  const originalViewport = document.querySelector<HTMLElement>(
    '[data-slot="message-scroller-viewport"]',
  )!;
  originalViewport.dispatchEvent(
    new WheelEvent('wheel', { bubbles: true, deltaY: -100 }),
  );
  originalViewport.scrollTop = 760;
  originalViewport.dispatchEvent(new Event('scroll', { bubbles: true }));
  await page.getByRole('link', { name: 'Open workflow' }).click();
  await page
    .getByRole('button', { name: zh.workflowEditor.backToConversation })
    .click();
  await expect
    .poll(
      () =>
        document.querySelector<HTMLElement>(
          '[data-slot="message-scroller-viewport"]',
        )?.scrollTop,
    )
    .toBeCloseTo(760, 0);
  // Reading older content must stay put while new snapshots grow the final
  // reply; restoration runs on return, not on every subsequent state change.
  for (let index = 0; index < 12; index++) {
    const current = useAssistantStore.getState().sessions['long-history']!;
    host.saved.set(current.id, {
      ...structuredClone(current),
      messages: current.messages.map((message, messageIndex) =>
        messageIndex === current.messages.length - 1
          ? { ...message, text: `${message.text}\n\n新增输出 ${index}` }
          : message,
      ),
    });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(
      document.querySelector<HTMLElement>(
        '[data-slot="message-scroller-viewport"]',
      )!.scrollTop,
    ).toBeCloseTo(760, 0);
  }
});

it('keeps one live workflow and a continuous spinner across snapshots and the receipt handoff', async () => {
  await page.viewport(1280, 900);
  host.inspect.mockResolvedValue({
    id: 'run',
    status: 'running',
    events: [],
    spans: [],
  });
  const session = {
    id: 'live-stability',
    title: 'Live workflow',
    modelId: 'model',
    status: 'running',
    steps: 0,
    messages: [
      {
        id: 'request',
        role: 'user',
        text: '生成报告',
        content: { role: 'user', parts: [{ text: '生成报告' }] },
      },
    ],
    activeCall: {
      runId: 'run',
      workflow: { document: { settings: { name: '报告生成' } } },
    },
  };
  host.saved.set(session.id, session);
  const screen = await render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[`/start?session=${session.id}`]}>
        <div className='h-dvh'>
          <StartPage />
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await expect
    .element(screen.getByTestId('assistant-workflow-run'))
    .toBeVisible();
  await screen
    .getByTestId('assistant-workflow-run')
    .getByRole('button', { expanded: false })
    .click();
  const card = screen.getByTestId('assistant-workflow-run').element();
  const spinner = card.querySelector('[data-slot=spinner]')!;
  const rotation = spinner.getAnimations()[0]!;
  await expect.poll(() => rotation.startTime).not.toBeNull();
  const startedAt = rotation.startTime;
  const viewport = document.querySelector(
    '[data-slot=message-scroller-viewport]',
  )!;
  for (let index = 0; index < 20; index++) {
    host.saved.set(session.id, { ...structuredClone(session), steps: index });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    expect(screen.getByTestId('assistant-workflow-run').element()).toBe(card);
    expect(card.querySelector('[data-slot=spinner]')).toBe(spinner);
    expect(spinner.getAnimations()[0]).toBe(rotation);
    expect(rotation.startTime).toBe(startedAt);
    expect(
      document.querySelector('[data-slot=message-scroller-viewport]'),
    ).toBe(viewport);
    await expect
      .element(screen.getByTestId('workflow-run-timeline'))
      .toBeVisible();
  }
  const receipt = {
    id: 'receipt',
    role: 'tool',
    runId: 'run',
    workflowName: '报告生成',
    text: 'running',
    content: { role: 'function', parts: [] },
  };
  // Native snapshots can expose the persisted receipt before clearing activeCall.
  host.saved.set(session.id, {
    ...session,
    messages: [...session.messages, receipt],
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(screen.getByTestId('assistant-workflow-run').elements()).toHaveLength(
    1,
  );
  expect(screen.getByTestId('assistant-workflow-run').element()).toBe(card);
  host.saved.set(session.id, {
    ...session,
    activeCall: null,
    messages: [...session.messages, receipt],
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  expect(card.querySelector('[data-slot=spinner]')).toBe(spinner);
  expect(spinner.getAnimations()[0]).toBe(rotation);
  expect(rotation.startTime).toBe(startedAt);
  expect(Number(rotation.currentTime)).toBeGreaterThan(0);
  await expect
    .element(screen.getByTestId('workflow-run-timeline'))
    .toBeVisible();
});
