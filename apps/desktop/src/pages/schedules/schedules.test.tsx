import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import { listen } from '@tauri-apps/api/event';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { beforeEach, expect, it, vi } from 'vitest';

import en from '@/locales/en.json';
import { getSessionUsage } from '@/services/model-usage';
import * as api from '@/services/schedules';
import type { ScheduledTask, SchedulingSession } from '@/services/schedules';

import { Component } from './index';

const nativeEvents = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  stops: [] as ReturnType<typeof vi.fn>[],
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(
    async (name: string, callback: (event: { payload: unknown }) => void) => {
      nativeEvents.listeners.set(name, callback);
      const stop = vi.fn(() => nativeEvents.listeners.delete(name));
      nativeEvents.stops.push(stop);
      return stop;
    },
  ),
}));

vi.mock('@/components/app-sidebar', () => ({
  useEntryWorkspace: () => 'personal',
}));
vi.mock('@/components/message-markdown', () => ({
  MessageMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));
// Timing and stream handoff are exercised with the real animation in WebKit tests.
vi.mock('@/pages/start/assistant-message-text', () => ({
  AssistantMessageText: ({ text }: { text: string }) => <div>{text}</div>,
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
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
    {
      id: 'model-1',
      name: 'Test model',
      provider: 'ollama',
      effortOptions: ['low', 'high'],
    },
    { id: 'model-2', name: 'Basic model', provider: 'ollama' },
  ],
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (value, part) => (value as Record<string, unknown>)?.[part],
          en,
        ) || key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/services/model-usage', () => ({ getSessionUsage: vi.fn() }));
vi.mock('@/services/schedules', () => ({
  listSchedules: vi.fn(),
  getSchedule: vi.fn(),
  listSchedulingSessions: vi.fn(),
  getSchedulingSession: vi.fn(),
  createSchedulingSession: vi.fn(),
  setSchedulingModel: vi.fn(),
  deleteSchedulingSession: vi.fn(),
  sendSchedulingMessage: vi.fn(),
  proposeScheduleChange: vi.fn(),
  changeScheduledTask: vi.fn(),
  decideScheduleChange: vi.fn(),
  replySchedulingReceipt: vi.fn(),
  stopSchedulingResponse: vi.fn(),
}));

const task: ScheduledTask = {
  id: 'task-1',
  name: 'Project report',
  targetId: 'wf-1',
  targetType: 'workflow',
  targetName: 'Weekly report',
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
const session: SchedulingSession = {
  id: 'session-1',
  title: 'Schedule report',
  messages: [],
  proposals: [],
  questions: [],
  status: 'idle',
};
function mount(path = '/schedules?view=new') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Component />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.changeScheduledTask).mockResolvedValue(task);
  vi.mocked(api.replySchedulingReceipt).mockImplementation(
    async () =>
      (await vi.mocked(api.decideScheduleChange).mock.results.at(-1)?.value) ||
      session,
  );
  vi.mocked(listen).mockImplementation(async (name, callback) => {
    nativeEvents.listeners.set(
      name,
      callback as (event: { payload: unknown }) => void,
    );
    const stop = vi.fn(() => {
      nativeEvents.listeners.delete(name);
    });
    nativeEvents.stops.push(stop);
    return stop;
  });
  nativeEvents.listeners.clear();
  nativeEvents.stops = [];
  localStorage.clear();
  vi.mocked(api.listSchedules).mockResolvedValue([task]);
  vi.mocked(api.listSchedulingSessions).mockResolvedValue([]);
  vi.mocked(api.getSchedule).mockResolvedValue(task);
  vi.mocked(api.createSchedulingSession).mockImplementation(
    async (_target, selection) => ({ ...session, ...selection }),
  );
  vi.mocked(api.setSchedulingModel).mockImplementation(
    async (id, selection) => ({
      ...session,
      id,
      ...selection,
      reasoningEffort: selection.reasoningEffort ?? null,
    }),
  );
  vi.mocked(api.getSchedulingSession).mockResolvedValue(session);
});

it('opens a task-list row in its corresponding conversation, with details available from its message card', async () => {
  const saved: SchedulingSession = {
    ...session,
    messages: [
      {
        id: 'result',
        role: 'assistant',
        text: 'Task ready',
        proposalId: 'saved-card',
      },
    ],
    proposals: [
      {
        id: 'saved-card',
        operation: 'create',
        status: 'saved',
        before: null,
        after: task,
        messageIndex: 0,
      },
    ],
  };
  vi.mocked(api.listSchedulingSessions).mockResolvedValue([
    { id: session.id, title: 'Task management', scheduleIds: [task.id] },
  ]);
  vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
  mount('/schedules?view=tasks');
  await userEvent.click(
    await screen.findByRole('button', { name: /Project report/ }),
  );
  expect(await screen.findByText('Task ready')).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('link', { name: 'View task' }));
  const dialog = await screen.findByRole('dialog');
  expect(
    await within(dialog).findByRole('heading', { name: 'Project report' }),
  ).toBeInTheDocument();
  expect(
    within(dialog).getByRole('link', { name: 'View result' }),
  ).toHaveAttribute('href', '/workflows/wf-1?runId=execution-1&live=true');
  expect(api.createSchedulingSession).not.toHaveBeenCalled();
});

it('uses its independent agent and waits for the native task card before saving', async () => {
  const pending: SchedulingSession = {
    ...session,
    messages: [{ id: 'm1', role: 'user', text: 'Run my report every Friday' }],
    proposals: [
      {
        id: 'proposal-1',
        operation: 'create',
        status: 'waiting',
        before: null,
        after: task,
        messageIndex: 1,
      },
    ],
    pending: 'proposal-1',
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockResolvedValue({
    ...pending,
    scheduleId: task.id,
    pending: null,
    proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
  });
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Run my report every Friday' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
  const card = await screen.findByRole('region', {
    name: 'Scheduled task confirmation',
  });
  expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
    'session-1',
    'model-1',
    'Run my report every Friday',
    expect.any(Function),
    undefined,
  );
  expect(api.decideScheduleChange).not.toHaveBeenCalled();
  fireEvent.click(within(card).getByRole('button', { name: 'Create task' }));
  await waitFor(() =>
    expect(api.decideScheduleChange).toHaveBeenCalledWith(
      'session-1',
      'proposal-1',
      true,
    ),
  );
  expect(await screen.findByText('Action saved')).toBeInTheDocument();
  const viewTask = screen.getByRole('link', { name: 'View task' });
  expect(viewTask).toHaveAttribute(
    'href',
    '/schedules?conversation=session-1&task=task-1',
  );
  const createsBefore = vi.mocked(api.createSchedulingSession).mock.calls
    .length;
  await userEvent.click(viewTask);
  await screen.findByRole('heading', { name: 'Project report' });
  expect(screen.getByText('Run my report every Friday')).toBeInTheDocument();
  expect(screen.queryByTestId('assistant-thinking')).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
  );
  expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  expect(api.createSchedulingSession).toHaveBeenCalledTimes(createsBefore);
});

it.each(['card', 'composer'] as const)(
  'explains both clarification entry points and accepts an answer through the %s',
  async (entry) => {
    const awaiting: SchedulingSession = {
      ...session,
      questions: [
        { title: 'Which project?', options: ['Workrun', 'Other project'] },
      ],
    };
    vi.mocked(api.getSchedulingSession).mockResolvedValue(awaiting);
    vi.mocked(api.sendSchedulingMessage).mockResolvedValue({
      ...session,
      messages: [{ id: 'reply', role: 'assistant', text: 'Ready to preview' }],
    });
    mount('/schedules?conversation=session-1');
    expect(
      await screen.findByText(en.schedules.answerHint),
    ).toBeInTheDocument();
    const composer = screen.getByPlaceholderText(
      en.schedules.answerPlaceholder,
    );
    if (entry === 'card') {
      fireEvent.click(screen.getByRole('button', { name: 'Workrun' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    } else {
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      fireEvent.change(composer, {
        target: { value: 'Use Workrun for the report' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    }
    await waitFor(() =>
      expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
        'session-1',
        'model-1',
        entry === 'card'
          ? 'Which project?\nWorkrun'
          : 'Use Workrun for the report',
        expect.any(Function),
        undefined,
      ),
    );
    expect(await screen.findByText('Ready to preview')).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(en.schedules.answerPlaceholder),
    ).not.toBeInTheDocument();
  },
);

it('keeps direct task errors in the dialog without creating conversation cards', async () => {
  vi.mocked(api.changeScheduledTask).mockRejectedValue(
    new Error('Schedule changed. Reopen and try again.'),
  );
  mount('/schedules?task=task-1');
  await userEvent.click(
    await screen.findByRole('button', { name: 'Pause task' }),
  );
  const dialog = screen.getByRole('dialog');
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Schedule changed',
  );
  expect(api.proposeScheduleChange).not.toHaveBeenCalled();
  expect(api.createSchedulingSession).not.toHaveBeenCalled();
  expect(api.replySchedulingReceipt).not.toHaveBeenCalled();
});

it('keeps the first response busy across route creation and surfaces transport failures', async () => {
  let reject!: (error: Error) => void;
  vi.mocked(api.sendSchedulingMessage).mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Schedule my report' },
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalledOnce());
  // The initial session read can still be idle while provider authentication is pending.
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: en.schedules.stop }),
    ).toBeInTheDocument(),
  );
  reject(new Error('Provider unavailable'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Provider unavailable',
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Scheduled task message')).not.toBeDisabled(),
  );
});

it('opens a focused creation view from the task list without creating a session', async () => {
  mount('/schedules?view=tasks');
  await screen.findByRole('button', { name: /Project report/ });
  expect(screen.queryByLabelText('Scheduled task message')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: en.schedules.new }));
  expect(
    await screen.findByRole('heading', { name: en.schedules.hero }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Scheduled task message')).toBeInTheDocument();
  expect(api.createSchedulingSession).not.toHaveBeenCalled();
});

it('switches conversations using the history dropdown', async () => {
  vi.mocked(api.listSchedulingSessions).mockResolvedValue([
    { id: session.id, title: session.title },
  ]);
  mount('/schedules?view=tasks');
  await screen.findByRole('button', { name: /Project report/ });
  fireEvent.click(
    screen.getByRole('button', { name: en.schedules.conversations }),
  );
  const dialog = await screen.findByRole('menu');
  await userEvent.click(
    await within(dialog).findByRole('menuitemradio', { name: session.title }),
  );
  await waitFor(() =>
    expect(api.getSchedulingSession).toHaveBeenCalledWith(session.id),
  );
  await waitFor(() =>
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(),
  );
  expect(screen.getByLabelText('Scheduled task message')).toBeInTheDocument();
});

it('sends the reasoning effort selected through the shared homepage control', async () => {
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue({
    ...session,
    modelId: 'model-1',
    reasoningEffort: 'high',
  });
  mount();
  await userEvent.click(await screen.findByRole('button', { name: 'Effort' }));
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'High' }),
  );
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Show my schedules' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
      'session-1',
      'model-1',
      'Show my schedules',
      expect.any(Function),
      'high',
    ),
  );
});

it('restores saved effort and clears it when selecting a model without effort support', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    modelId: 'model-1',
    reasoningEffort: 'high',
  });
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue({
    ...session,
    modelId: 'model-2',
  });
  mount('/schedules?conversation=session-1');
  expect(
    await screen.findByRole('button', { name: 'Effort' }),
  ).toHaveTextContent('High');
  await userEvent.click(
    screen.getByRole('button', { name: en.assistant.model }),
  );
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Basic model' }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Scheduled task message')).toBeEnabled(),
  );
  expect(
    screen.queryByRole('button', { name: 'Effort' }),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Show my schedules' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
      'session-1',
      'model-2',
      'Show my schedules',
      expect.any(Function),
      undefined,
    ),
  );
});

it('keeps the sent message visible before session creation and through stale idle reads, and streams the answer', async () => {
  let finishCreate!: (value: SchedulingSession) => void;
  let finishResponse!: (value: SchedulingSession) => void;
  let receive!: (
    event: import('@/services/schedules').SchedulingStream,
  ) => void;
  vi.mocked(api.createSchedulingSession).mockImplementation(
    () =>
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
  );
  vi.mocked(api.sendSchedulingMessage).mockImplementation(
    (_id, _model, _text, onStream) => {
      receive = onStream;
      return new Promise((resolve) => {
        finishResponse = resolve;
      });
    },
  );
  const client = mount();
  const text =
    '明天上午十点整运行 Weather workflow，根据上海的天气给出行程规划';
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: text },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText(text)).toBeInTheDocument();
  expect(
    screen.getByText(text).closest('[data-slot="message"]'),
  ).toHaveAttribute('data-align', 'end');
  await waitFor(() =>
    expect(api.createSchedulingSession).toHaveBeenCalledOnce(),
  );
  await act(async () => finishCreate(session));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalledOnce());
  await act(async () =>
    client.setQueryData(['scheduling-session', 'personal', session.id], {
      ...session,
      messages: [],
    }),
  );
  expect(screen.getByText(text)).toBeInTheDocument();
  expect(screen.getByTestId('assistant-thinking')).toBeInTheDocument();
  await act(async () => receive({ type: 'phase_start', phaseId: 'lookup' }));
  await act(async () =>
    receive({ type: 'tool_start', phaseId: 'lookup', name: 'list_targets' }),
  );
  expect(
    await screen.findByText(en.schedules.progress.list_targets),
  ).toBeInTheDocument();
  await act(async () => receive({ type: 'phase_start', phaseId: 'answer' }));
  await act(async () =>
    receive({
      type: 'text_delta',
      phaseId: 'answer',
      text: 'Weather workflow 已找到。',
    }),
  );
  expect(
    await screen.findByText('Weather workflow 已找到。'),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: en.schedules.stop }),
  ).toBeInTheDocument();
  await act(async () =>
    receive({
      type: 'text_delta',
      phaseId: 'answer',
      text: '请确认运行时间。',
    }),
  );
  const answer = 'Weather workflow 已找到。请确认运行时间。';
  expect(await screen.findByText(answer)).toBeInTheDocument();
  // A canonical user turn has a different native ID and must replace the optimistic bubble.
  await act(async () =>
    client.setQueryData(['scheduling-session', 'personal', session.id], {
      ...session,
      status: 'running',
      messages: [{ id: 'native-user', role: 'user', text }],
    }),
  );
  expect(screen.getAllByText(text)).toHaveLength(1);
  await act(async () =>
    finishResponse({
      ...session,
      messages: [
        { id: 'native-user', role: 'user', text },
        { id: 'answer', role: 'assistant', text: answer },
      ],
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Scheduled task message')).not.toBeDisabled(),
  );
  expect(screen.getAllByText(answer)).toHaveLength(1);
});

it('recovers when creating the native session fails without hiding the sent request', async () => {
  vi.mocked(api.createSchedulingSession).mockRejectedValue(
    new Error('Cannot create conversation'),
  );
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Schedule Weather workflow' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Cannot create conversation',
  );
  expect(screen.getByText('Schedule Weather workflow')).toBeInTheDocument();
  expect(screen.getByLabelText('Scheduled task message')).not.toBeDisabled();
});

it('starts a fresh creation view after a response rather than reusing the pending draft', async () => {
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue({
    ...session,
    messages: [
      { id: 'user', role: 'user', text: 'Weather request' },
      { id: 'answer', role: 'assistant', text: 'Ready' },
    ],
  });
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Ready');
  fireEvent.click(screen.getByRole('button', { name: en.schedules.new }));
  expect(
    await screen.findByRole('heading', { name: en.schedules.hero }),
  ).toBeInTheDocument();
  expect(screen.getByLabelText('Scheduled task message')).toBeEnabled();
  expect(screen.queryByText('Weather request')).not.toBeInTheDocument();
});

it('persists each conversation model immediately and uses only explicit recent selections for new conversations', async () => {
  const saved = new Map<string, SchedulingSession>([
    [
      'session-A',
      {
        ...session,
        id: 'session-A',
        title: 'Conversation A',
        modelId: 'model-1',
        reasoningEffort: 'high',
      },
    ],
    [
      'session-B',
      {
        ...session,
        id: 'session-B',
        title: 'Conversation B',
        modelId: 'model-2',
        reasoningEffort: null,
      },
    ],
  ]);
  vi.mocked(api.listSchedulingSessions).mockResolvedValue([...saved.values()]);
  vi.mocked(api.getSchedulingSession).mockImplementation(async (id) =>
    structuredClone(saved.get(id)!),
  );
  vi.mocked(api.setSchedulingModel).mockImplementation(
    async (id, selection) => {
      const value = {
        ...saved.get(id)!,
        ...selection,
        reasoningEffort: selection.reasoningEffort ?? null,
      };
      saved.set(id, value);
      return structuredClone(value);
    },
  );
  const client = mount('/schedules?conversation=session-A');
  expect(
    await screen.findByRole('button', { name: 'Effort' }),
  ).toHaveTextContent('High');
  await userEvent.click(
    screen.getByRole('button', { name: en.assistant.model }),
  );
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Basic model' }),
  );
  await waitFor(() =>
    expect(api.setSchedulingModel).toHaveBeenCalledWith('session-A', {
      modelId: 'model-2',
      reasoningEffort: null,
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Scheduled task message')).toBeEnabled(),
  );
  expect(api.sendSchedulingMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: en.schedules.new }));
  expect(
    screen.getByRole('button', { name: en.assistant.model }),
  ).toHaveTextContent('Basic model');
  await userEvent.click(
    screen.getByRole('button', { name: en.assistant.model }),
  );
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Test model' }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Effort' }));
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'High' }),
  );
  // Merely viewing a different conversation must not change the new-chat preference.
  for (const title of ['Conversation B', 'Conversation A']) {
    await userEvent.click(
      screen.getByRole('button', { name: en.schedules.conversations }),
    );
    const dialog = await screen.findByRole('menu');
    await userEvent.click(
      await within(dialog).findByRole('menuitemradio', { name: title }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: en.assistant.model }),
      ).toHaveTextContent('Basic model'),
    );
    expect(
      screen.queryByRole('button', { name: 'Effort' }),
    ).not.toBeInTheDocument();
  }
  fireEvent.click(screen.getByRole('button', { name: en.schedules.new }));
  expect(
    screen.getByRole('button', { name: en.assistant.model }),
  ).toHaveTextContent('Test model');
  expect(screen.getByRole('button', { name: 'Effort' })).toHaveTextContent(
    'High',
  );
  expect(saved.get('session-B')?.modelId).toBe('model-2');
  client.clear();
  cleanup();
  mount();
  expect(
    await screen.findByRole('button', { name: 'Effort' }),
  ).toHaveTextContent('High');
  expect(
    screen.getByRole('button', { name: en.assistant.model }),
  ).toHaveTextContent('Test model');
});

it('restores the conversation selection if native preference persistence fails', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    modelId: 'model-1',
    reasoningEffort: 'high',
  });
  vi.mocked(api.setSchedulingModel).mockRejectedValue(
    new Error('Could not save model'),
  );
  mount('/schedules?conversation=session-1');
  await screen.findByRole('button', { name: 'Effort' });
  await userEvent.click(
    screen.getByRole('button', { name: en.assistant.model }),
  );
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: 'Basic model' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not save model',
  );
  expect(
    screen.getByRole('button', { name: en.assistant.model }),
  ).toHaveTextContent('Test model');
  expect(screen.getByRole('button', { name: 'Effort' })).toHaveTextContent(
    'High',
  );
});

it('shows one-time task dates and reschedules finished tasks without a resume action', async () => {
  const once: ScheduledTask = {
    ...task,
    scheduleKind: 'once',
    cronExpression: '',
    runAt: '2026-11-05T02:00:00Z',
    enabled: false,
    finishedAt: '2026-11-05T03:00:00Z',
    finishReason: 'missed',
  };
  vi.mocked(api.listSchedules).mockResolvedValue([once]);
  vi.mocked(api.getSchedule).mockResolvedValue(once);
  mount('/schedules?task=task-1');
  expect(await screen.findByText('Missed')).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: en.schedules.resume }),
  ).toBeDisabled();
  expect(
    screen.getAllByText(/Nov 5, 2026, 10:00 AM · Once/)[0],
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: en.schedules.edit }));
  const date = screen.getByLabelText(en.schedules.runAt);
  expect(date).toHaveValue('2026-11-05T10:00');
  fireEvent.change(date, { target: { value: '2026-11-06T10:00' } });
  vi.mocked(api.changeScheduledTask).mockResolvedValue({
    ...once,
    runAt: '2026-11-06T02:00:00Z',
  });
  fireEvent.click(screen.getByRole('button', { name: en.apps.schedules.save }));
  await waitFor(() =>
    expect(api.changeScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleKind: 'once',
        runAt: '2026-11-06T10:00',
        timezone: 'Asia/Shanghai',
      }),
    ),
  );
});

it.each([false, true])(
  'preserves the exact one-time instant when renaming a task (finished: %s)',
  async (finished) => {
    const once: ScheduledTask = {
      ...task,
      scheduleKind: 'once',
      cronExpression: '',
      runAt: '2026-11-05T02:00:37.123+00:00',
      enabled: !finished,
      finishedAt: finished ? '2026-11-05T03:00:00Z' : null,
      finishReason: finished ? 'triggered' : null,
    };
    vi.mocked(api.listSchedules).mockResolvedValue([once]);
    vi.mocked(api.getSchedule).mockResolvedValue(once);
    vi.mocked(api.changeScheduledTask).mockResolvedValue({
      ...once,
      name: 'Renamed',
    });
    mount('/schedules?task=task-1');
    fireEvent.click(
      await screen.findByRole('button', { name: en.schedules.edit }),
    );
    fireEvent.change(screen.getByLabelText(en.schedules.name), {
      target: { value: 'Renamed' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: en.apps.schedules.save }),
    );
    await waitFor(() => expect(api.changeScheduledTask).toHaveBeenCalled());
    const change = vi.mocked(api.changeScheduledTask).mock.calls[0]![0];
    expect(change).toMatchObject({ name: 'Renamed', scheduleKind: 'once' });
    expect(change).not.toHaveProperty('runAt');
  },
);

it('keeps the current conversation and draft when switching to tasks and back', async () => {
  mount('/schedules?conversation=session-1');
  const composer = await screen.findByLabelText('Scheduled task message');
  fireEvent.change(composer, { target: { value: 'Move this task to ten' } });
  fireEvent.click(screen.getByRole('tab', { name: en.schedules.list }));
  expect(
    await screen.findByRole('button', { name: /Project report/ }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: en.schedules.chat }));
  expect(screen.getByLabelText('Scheduled task message')).toHaveValue(
    'Move this task to ten',
  );
});

it('does not refetch loaded conversation or task data on focus or reconnect even when stale', async () => {
  const client = mount('/schedules?task=task-1&conversation=session-1');
  await screen.findByRole('heading', { name: 'Project report' });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  await client.invalidateQueries({
    queryKey: ['scheduling-session'],
    refetchType: 'none',
  });
  await client.invalidateQueries({
    queryKey: ['schedule'],
    refetchType: 'none',
  });
  const reads = vi.mocked(api.getSchedulingSession).mock.calls.length;
  const taskReads = vi.mocked(api.getSchedule).mock.calls.length;
  try {
    await act(async () => {
      focusManager.setFocused(false);
      onlineManager.setOnline(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(api.getSchedulingSession).toHaveBeenCalledTimes(reads);
    expect(api.getSchedule).toHaveBeenCalledTimes(taskReads);
  } finally {
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  }
});

it('refreshes from native events without polling and disposes its subscriptions', async () => {
  mount('/schedules?task=task-1&conversation=session-1');
  await screen.findByRole('heading', { name: 'Project report' });
  await waitFor(() => expect(nativeEvents.listeners.size).toBe(3));
  await waitFor(() => expect(api.getSchedule).toHaveBeenCalled());
  const initial = vi.mocked(api.getSchedule).mock.calls.length;
  vi.useFakeTimers();
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
  } finally {
    vi.useRealTimers();
  }
  expect(api.getSchedule).toHaveBeenCalledTimes(initial);
  vi.mocked(api.getSchedule).mockResolvedValue({
    ...task,
    name: 'Changed by scheduler',
  });
  act(() =>
    nativeEvents.listeners.get('schedules-changed')!({
      payload: { workspaceId: 'personal' },
    }),
  );
  expect(
    await screen.findByRole('heading', { name: 'Changed by scheduler' }),
  ).toBeInTheDocument();
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    messages: [
      { id: 'pushed', role: 'assistant', text: 'Native response finished' },
    ],
  });
  act(() =>
    nativeEvents.listeners.get('schedule-session-changed')!({
      payload: { workspaceId: 'personal', sessionId: session.id },
    }),
  );
  expect(
    await screen.findByText('Native response finished'),
  ).toBeInTheDocument();
  const beforeRun = vi.mocked(api.getSchedule).mock.calls.length;
  act(() =>
    nativeEvents.listeners.get('run-status-changed')!({
      payload: { runId: 'run-1' },
    }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.getSchedule).mock.calls.length).toBeGreaterThan(
      beforeRun,
    ),
  );
  cleanup();
  expect(nativeEvents.stops.every((stop) => stop.mock.calls.length === 1)).toBe(
    true,
  );
});

it('reopens the selected conversation from history while the task list is visible', async () => {
  vi.mocked(api.listSchedulingSessions).mockResolvedValue([
    { id: session.id, title: session.title },
  ]);
  mount('/schedules?conversation=session-1');
  await screen.findByRole('tab', { name: en.schedules.chat, selected: true });
  fireEvent.click(screen.getByRole('tab', { name: en.schedules.list }));
  await userEvent.click(
    screen.getByRole('button', { name: en.schedules.conversations }),
  );
  await userEvent.click(
    await screen.findByRole('menuitemradio', { name: session.title }),
  );
  expect(screen.getByRole('tab', { name: en.schedules.chat })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

it('deletes a history row without selecting it or affecting the current conversation', async () => {
  const deletion = deferred<void>();
  let rows = [
    { id: session.id, title: 'Weather task' },
    { id: 'other-session', title: 'Weather task' },
  ];
  vi.mocked(api.listSchedulingSessions).mockImplementation(async () => rows);
  vi.mocked(api.deleteSchedulingSession).mockImplementation(async (id) => {
    await deletion.promise;
    rows = rows.filter((row) => row.id !== id);
  });
  mount('/schedules?conversation=session-1');
  await screen.findByLabelText('Scheduled task message');
  await userEvent.click(
    screen.getByRole('button', { name: en.schedules.conversations }),
  );
  const menu = await screen.findByRole('menu');
  const choices = await within(menu).findAllByRole('menuitemradio', {
    name: 'Weather task',
  });
  expect(choices[0]).toHaveAttribute('aria-checked', 'true');
  const deleteOther = within(choices[1]!.parentElement!).getByRole('menuitem', {
    name: 'Delete conversation: Weather task',
  });
  await userEvent.click(deleteOther);
  for (const item of within(menu).getAllByRole('menuitem')) {
    expect(item).not.toHaveAttribute('data-disabled');
  }
  await userEvent.click(deleteOther);
  expect(api.deleteSchedulingSession).toHaveBeenCalledTimes(1);
  deletion.resolve();
  await waitFor(() =>
    expect(vi.mocked(api.deleteSchedulingSession).mock.calls[0]?.[0]).toBe(
      'other-session',
    ),
  );
  expect(api.getSchedulingSession).not.toHaveBeenCalledWith('other-session');
  expect(
    await within(menu).findByRole('menuitemradio', { name: 'Weather task' }),
  ).toHaveAttribute('aria-checked', 'true');
  await waitFor(() =>
    expect(within(menu).queryAllByRole('menuitemradio')).toHaveLength(1),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

it('does not show model thinking while cancelling a task card', async () => {
  const pending: SchedulingSession = {
    ...session,
    messages: [{ id: 'm1', role: 'user', text: 'Schedule weather' }],
    pending: 'proposal-cancel',
    proposals: [
      {
        id: 'proposal-cancel',
        operation: 'create',
        status: 'waiting',
        before: null,
        after: task,
        messageIndex: 1,
      },
    ],
  };
  const receipt = deferred<SchedulingSession>();
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockReturnValue(receipt.promise);
  mount('/schedules?conversation=session-1');
  await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(api.decideScheduleChange).toHaveBeenCalledWith(
    'session-1',
    'proposal-cancel',
    false,
  );
  expect(screen.queryByTestId('assistant-thinking')).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: en.schedules.cancelling }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: en.schedules.stop }),
  ).not.toBeInTheDocument();
  receipt.resolve({
    ...pending,
    pending: null,
    proposals: [{ ...pending.proposals[0]!, status: 'cancelled' }],
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Cancel' }),
    ).not.toBeInTheDocument(),
  );
  expect(screen.queryByTestId('assistant-thinking')).not.toBeInTheDocument();
});

it('does not roll back displayed data when an event refresh resolves with an older revision', async () => {
  const original = {
    ...session,
    revision: 1,
    messages: [
      { id: 'original', role: 'assistant' as const, text: 'Original history' },
    ],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(original);
  const client = mount('/schedules?conversation=session-1');
  await screen.findByText('Original history');
  await waitFor(() => expect(nativeEvents.listeners.size).toBe(3));
  const read = deferred<SchedulingSession>();
  vi.mocked(api.getSchedulingSession).mockReturnValue(read.promise);
  void client.refetchQueries({
    queryKey: ['scheduling-session', 'personal', session.id],
  });
  await waitFor(() =>
    expect(
      client.isFetching({
        queryKey: ['scheduling-session', 'personal', session.id],
      }),
    ).toBe(1),
  );
  await act(async () => {
    client.setQueryData(['scheduling-session', 'personal', session.id], {
      ...original,
      revision: 2,
      messages: [
        ...original.messages,
        { id: 'new', role: 'assistant', text: 'New committed history' },
      ],
    });
  });
  await screen.findByText('New committed history');
  act(() =>
    nativeEvents.listeners.get('schedule-session-changed')!({
      payload: { workspaceId: 'personal', sessionId: session.id },
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.getByText('New committed history')).toBeInTheDocument();
  await act(async () => read.resolve(original));
  await waitFor(() =>
    expect(
      client.isFetching({
        queryKey: ['scheduling-session', 'personal', session.id],
      }),
    ).toBe(0),
  );
  expect(screen.getByText('New committed history')).toBeInTheDocument();
});

it('does not show a streamed answer twice when the completed snapshot precedes the invoke receipt', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue(session);
  const response = deferred<SchedulingSession>();
  let receive!: (event: api.SchedulingStream) => void;
  vi.mocked(api.sendSchedulingMessage).mockImplementation(
    (_id, _model, _text, onStream) => {
      receive = onStream;
      return response.promise;
    },
  );
  const client = mount('/schedules?conversation=session-1');
  await screen.findByLabelText('Scheduled task message');
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(receive).toBeDefined());
  act(() => receive({ type: 'text_delta', text: 'Final weather answer' }));
  await screen.findByText('Final weather answer');
  const complete = {
    ...session,
    messages: [
      { id: 'user', role: 'user' as const, text: 'Weather request' },
      {
        id: 'answer',
        role: 'assistant' as const,
        text: 'Final weather answer',
      },
    ],
  };
  await act(async () =>
    client.setQueryData(
      ['scheduling-session', 'personal', session.id],
      complete,
    ),
  );
  expect(screen.getAllByText('Final weather answer')).toHaveLength(1);
  await waitFor(() => {
    expect(screen.queryByTestId('assistant-thinking')).not.toBeInTheDocument();
    expect(screen.getAllByText('Final weather answer')).toHaveLength(1);
  });
  await act(async () => response.resolve(complete));
});

it('keeps the first message viewport mounted while the native session is created', async () => {
  const create = deferred<SchedulingSession>();
  const response = deferred<SchedulingSession>();
  vi.mocked(api.createSchedulingSession).mockReturnValue(create.promise);
  vi.mocked(api.sendSchedulingMessage).mockReturnValue(response.promise);
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const row = await screen.findByText('Weather request');
  const viewport = row.closest('[data-conversation-scroll-viewport]');
  await act(async () => create.resolve(session));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalled());
  expect(viewport).toBe(
    screen
      .getByText('Weather request')
      .closest('[data-conversation-scroll-viewport]'),
  );
  await act(async () =>
    response.resolve({
      ...session,
      messages: [{ id: 'user', role: 'user', text: 'Weather request' }],
    }),
  );
});

it('keeps the conversation and draft when confirming a card binds a new task', async () => {
  const proposal: api.ScheduleProposal = {
    id: 'new-card',
    operation: 'create',
    status: 'waiting',
    before: null,
    after: task,
    messageIndex: 1,
  };
  const pending = {
    ...session,
    messages: [{ id: 'user', role: 'user' as const, text: 'Weather request' }],
    proposals: [proposal],
    pending: proposal.id,
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockResolvedValue({
    ...pending,
    scheduleId: task.id,
    pending: null,
    proposals: [{ ...proposal, status: 'saved' }],
  });
  const taskRead = deferred<ScheduledTask>();
  vi.mocked(api.getSchedule).mockReturnValue(taskRead.promise);
  mount('/schedules?conversation=session-1');
  await screen.findByText('Weather request');
  const viewport = document.querySelector(
    '[data-conversation-scroll-viewport]',
  );
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Keep this draft' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await waitFor(() => expect(api.decideScheduleChange).toHaveBeenCalled());
  await act(async () => {
    await Promise.resolve();
  });
  expect(document.querySelector('[data-conversation-scroll-viewport]')).toBe(
    viewport,
  );
  expect(screen.getByLabelText('Scheduled task message')).toHaveValue(
    'Keep this draft',
  );
  await act(async () => taskRead.resolve(task));
});

it('isolates a new draft from an older creation response that finishes in the background', async () => {
  const response = deferred<SchedulingSession>();
  vi.mocked(api.sendSchedulingMessage).mockReturnValue(response.promise);
  mount();
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'First weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: en.schedules.new }));
  await screen.findByRole('heading', { name: en.schedules.hero });
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'My separate new draft' },
  });
  await act(async () =>
    response.resolve({
      ...session,
      revision: 3,
      messages: [
        { id: 'u', role: 'user', text: 'First weather request' },
        { id: 'a', role: 'assistant', text: 'Old response finished' },
      ],
    }),
  );
  expect(screen.getByLabelText('Scheduled task message')).toHaveValue(
    'My separate new draft',
  );
  expect(screen.queryByText('Old response finished')).not.toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: en.schedules.hero }),
  ).toBeInTheDocument();
});

it('preserves the loaded history and viewport through a transport failure and retry', async () => {
  const loaded = {
    ...session,
    revision: 1,
    messages: [
      {
        id: 'old',
        role: 'assistant' as const,
        text: 'Previously saved answer',
      },
    ],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(loaded);
  const response = deferred<SchedulingSession>();
  vi.mocked(api.sendSchedulingMessage).mockReturnValue(response.promise);
  mount('/schedules?conversation=session-1');
  const old = await screen.findByText('Previously saved answer');
  const viewport = old.closest('[data-conversation-scroll-viewport]');
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'New weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalled());
  await act(async () => response.reject(new Error('Transport failed')));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Transport failed',
  );
  expect(old.isConnected).toBe(true);
  expect(old.closest('[data-conversation-scroll-viewport]')).toBe(viewport);
  const complete = {
    ...loaded,
    revision: 3,
    messages: [
      ...loaded.messages,
      { id: 'new-user', role: 'user' as const, text: 'New weather request' },
      {
        id: 'new-answer',
        role: 'assistant' as const,
        text: 'Retried weather answer',
      },
    ],
  };
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue(complete);
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'New weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Retried weather answer');
  expect(old.isConnected).toBe(true);
  expect(screen.getAllByText('New weather request')).toHaveLength(1);
});

it('keeps the historical rows while a native stop event precedes the command receipt', async () => {
  const loaded = {
    ...session,
    revision: 1,
    messages: [
      { id: 'old', role: 'assistant' as const, text: 'History before stop' },
    ],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(loaded);
  const response = deferred<SchedulingSession>();
  vi.mocked(api.sendSchedulingMessage).mockReturnValue(response.promise);
  const client = mount('/schedules?conversation=session-1');
  const old = await screen.findByText('History before stop');
  const viewport = old.closest('[data-conversation-scroll-viewport]');
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Stop this weather request' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => expect(api.sendSchedulingMessage).toHaveBeenCalled());
  const composer = screen.getByLabelText('Scheduled task message');
  expect(composer).toBeEnabled();
  await userEvent.type(composer, 'Next request');
  await userEvent.keyboard('{Enter}');
  expect(api.sendSchedulingMessage).toHaveBeenCalledTimes(1);
  expect(api.stopSchedulingResponse).not.toHaveBeenCalled();
  expect(composer).toHaveValue('Next request');
  fireEvent.click(screen.getByRole('button', { name: en.schedules.stop }));
  expect(api.stopSchedulingResponse).toHaveBeenCalledWith(session.id);
  const stopped = {
    ...loaded,
    revision: 3,
    status: 'interrupted' as const,
    error: 'Response stopped',
    messages: [
      ...loaded.messages,
      { id: 'u', role: 'user' as const, text: 'Stop this weather request' },
    ],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(stopped);
  act(() =>
    nativeEvents.listeners.get('schedule-session-changed')!({
      payload: { workspaceId: 'personal', sessionId: session.id },
    }),
  );
  await screen.findByText(en.schedules.interrupted);
  expect(old.isConnected).toBe(true);
  expect(old.closest('[data-conversation-scroll-viewport]')).toBe(viewport);
  await act(async () => response.resolve(stopped));
  expect(
    client.getQueryData<SchedulingSession>([
      'scheduling-session',
      'personal',
      session.id,
    ])?.revision,
  ).toBe(3);
  expect(screen.getAllByText('Stop this weather request')).toHaveLength(1);
  expect(composer).toHaveValue('Next request');
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue(stopped);
  await userEvent.click(await screen.findByRole('button', { name: 'Send' }));
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledTimes(2),
  );
  expect(vi.mocked(api.sendSchedulingMessage).mock.calls[1]?.[2]).toBe(
    'Next request',
  );
});

it('opens each task from a multi-task conversation in a dialog without replacing its history or draft', async () => {
  const second = { ...task, id: 'task-2', name: 'Weather schedule' };
  const saved: SchedulingSession = {
    ...session,
    messages: [{ id: 'user', role: 'user', text: 'Manage both tasks here' }],
    proposals: [task, second].map((after, index) => ({
      id: `saved-${index}`,
      operation: 'create',
      status: 'saved',
      before: null,
      after,
      messageIndex: 1,
    })),
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
  vi.mocked(api.listSchedules).mockResolvedValue([task, second]);
  vi.mocked(api.getSchedule).mockImplementation(async (id) =>
    id === second.id ? second : task,
  );
  mount('/schedules?conversation=session-1');
  const history = await screen.findByText('Manage both tasks here');
  const viewport = history.closest('[data-conversation-scroll-viewport]');
  fireEvent.change(screen.getByLabelText('Scheduled task message'), {
    target: { value: 'Keep this draft' },
  });
  for (const [index, expected] of [task, second].entries()) {
    await userEvent.click(
      screen.getAllByRole('link', { name: 'View task' })[index]!,
    );
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByRole('heading', { name: expected.name }),
    ).toBeInTheDocument();
    expect(viewport).toBe(
      history.closest('[data-conversation-scroll-viewport]'),
    );
    expect(viewport?.isConnected).toBe(true);
    expect(
      document.querySelector('[data-message-id="task-details"]'),
    ).toBeNull();
    await userEvent.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Scheduled task message')).toHaveValue(
      'Keep this draft',
    );
  }
  expect(api.createSchedulingSession).not.toHaveBeenCalled();
  expect(api.replySchedulingReceipt).not.toHaveBeenCalled();
});

it('streams a real post-save reply and reasoning without replacing the saved card', async () => {
  const pending: SchedulingSession = {
    ...session,
    revision: 1,
    messages: [
      { id: 'u', role: 'user', text: 'Schedule my report' },
      { id: 'a', role: 'assistant', text: 'Confirm this schedule.' },
    ],
    proposals: [
      {
        id: 'card',
        operation: 'create',
        status: 'waiting',
        before: null,
        after: task,
        messageIndex: 2,
      },
    ],
  };
  const saved: SchedulingSession = {
    ...pending,
    revision: 2,
    pending: null,
    proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockResolvedValue(saved);
  const response = deferred<SchedulingSession>();
  let receive!: (event: api.SchedulingStream) => void;
  vi.mocked(api.replySchedulingReceipt).mockImplementation((_id, callback) => {
    receive = callback;
    return response.promise;
  });
  const client = mount('/schedules?conversation=session-1');
  const preview = await screen.findByRole('region', {
    name: 'Scheduled task confirmation',
  });
  const originalReply = screen
    .getByText('Confirm this schedule.')
    .closest('[data-slot="message"]');
  expect(preview.closest('[data-slot="message"]')).toBe(originalReply);
  await userEvent.click(screen.getByRole('button', { name: 'Create task' }));
  await waitFor(() =>
    expect(api.replySchedulingReceipt).toHaveBeenCalledOnce(),
  );
  expect(screen.getByText('Action saved')).toBeInTheDocument();
  act(() => {
    receive({ type: 'phase_start', phaseId: 'receipt' });
    receive({
      type: 'reasoning',
      phaseId: 'receipt',
      id: 'reason',
      text: 'Checked the saved receipt',
      complete: true,
      durationMs: 400,
    });
    receive({
      type: 'text_delta',
      phaseId: 'receipt',
      text: 'Your report schedule is saved.',
    });
  });
  expect(
    await screen.findByText('Your report schedule is saved.'),
  ).toBeInTheDocument();
  const complete: SchedulingSession = {
    ...saved,
    revision: 4,
    messages: [
      ...saved.messages,
      {
        id: 'receipt-answer',
        proposalId: 'card',
        role: 'assistant',
        text: 'Your report schedule is saved.',
        reasoning: [
          {
            id: 'reason',
            phaseId: 'receipt',
            turnId: 'turn',
            text: 'Checked the saved receipt',
            complete: true,
            durationMs: 400,
          },
        ],
      },
    ],
  };
  act(() => {
    client.setQueryData(
      ['scheduling-session', 'personal', session.id],
      complete,
    );
  });
  await waitFor(() =>
    expect(screen.getAllByText('Your report schedule is saved.')).toHaveLength(
      1,
    ),
  );
  vi.mocked(api.getSchedulingSession).mockResolvedValue(complete);
  await act(async () => response.resolve(complete));
  expect(screen.getAllByText('Your report schedule is saved.')).toHaveLength(1);
  expect(screen.getByText('Action saved')).toBeInTheDocument();
  const result = screen.getByRole('region', { name: task.name });
  const resultReply = screen
    .getByText('Your report schedule is saved.')
    .closest('[data-slot="message"]');
  expect(result.closest('[data-slot="message"]')).toBe(resultReply);
  expect(resultReply).not.toBe(originalReply);
  expect(
    within(resultReply as HTMLElement).getAllByRole('button', {
      name: en.assistant.copy,
    }),
  ).toHaveLength(1);
  expect(screen.getByText('Confirm this schedule.')).toBeVisible();
  expect(preview.isConnected).toBe(true);
  expect(
    within(preview).queryByRole('button', { name: 'Create task' }),
  ).not.toBeInTheDocument();
  expect(
    within(preview).getByText(en.schedules.cardStatus.saved),
  ).toBeInTheDocument();
});

it('opens a new conversation by default even when scheduled tasks already exist', async () => {
  mount('/schedules');
  expect(
    await screen.findByRole('heading', { name: en.schedules.hero }),
  ).toBeInTheDocument();
  await waitFor(() => expect(api.listSchedules).toHaveBeenCalled());
  expect(
    screen.queryByRole('heading', { name: en.schedules.scheduled, level: 2 }),
  ).not.toBeInTheDocument();
  expect(api.createSchedulingSession).not.toHaveBeenCalled();
});

function savedTaskConversation(): SchedulingSession {
  return {
    ...session,
    messages: [
      {
        id: 'saved-task',
        role: 'assistant',
        text: 'Task saved.',
        proposalId: 'saved-card',
      },
    ],
    proposals: [
      {
        id: 'saved-card',
        operation: 'create',
        status: 'saved',
        before: null,
        after: task,
        messageIndex: 0,
      },
    ],
  };
}

it('loads fresh task data before opening a complete dialog instead of showing a loading shell', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue(
    savedTaskConversation(),
  );
  const detail = deferred<ScheduledTask>();
  vi.mocked(api.getSchedule).mockReturnValue(detail.promise);
  mount('/schedules?conversation=session-1');
  await userEvent.click(await screen.findByRole('link', { name: 'View task' }));
  expect(api.getSchedule).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View task' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await act(async () => detail.resolve(task));
  const dialog = await screen.findByRole('dialog');
  expect(
    within(dialog).getByRole('heading', { name: task.name }),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByText(en.schedules.loading),
  ).not.toBeInTheDocument();
});

it.each([
  ['Schedule was not found in this workspace', en.schedules.taskDeleted],
  ['Temporary read failure', en.schedules.openTaskFailed],
])(
  'keeps the task dialog closed and reports %s even when stale detail is cached',
  async (failure, notice) => {
    vi.mocked(api.getSchedulingSession).mockResolvedValue(
      savedTaskConversation(),
    );
    vi.mocked(api.getSchedule).mockRejectedValue(new Error(failure));
    const client = mount('/schedules?conversation=session-1');
    client.setQueryData(['schedule', 'personal', task.id], task);
    await userEvent.click(
      await screen.findByRole('link', { name: 'View task' }),
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(notice, { toasterId: 'global' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Task saved.')).toBeInTheDocument();
    if (notice === en.schedules.taskDeleted) {
      expect(
        screen.queryByRole('link', { name: 'View task' }),
      ).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('region', { name: task.name })).getByRole(
          'status',
        ),
      ).toHaveTextContent(en.apps.schedules.deleted);
    } else {
      await waitFor(() =>
        expect(
          screen.getByRole('link', { name: 'View task' }),
        ).not.toHaveAttribute('aria-disabled', 'true'),
      );
    }
  },
);

it('keeps clarification choices inside the assistant reply that asks the question', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    messages: [
      { id: 'u', role: 'user', text: 'Create another task' },
      {
        id: 'a',
        role: 'assistant',
        text: 'Choose how to handle the duplicates.',
      },
    ],
    questions: [
      { title: 'Which action?', options: ['Keep existing', 'Create another'] },
    ],
  });
  mount('/schedules?conversation=session-1');
  const option = await screen.findByRole('button', { name: 'Create another' });
  expect(option.closest('[data-slot="message"]')).toBe(
    screen
      .getByText('Choose how to handle the duplicates.')
      .closest('[data-slot="message"]'),
  );
});

it.each(['pause', 'delete'] as const)(
  'performs detail-dialog %s directly without changing the conversation',
  async (operation) => {
    const original = savedTaskConversation();
    vi.mocked(api.getSchedulingSession).mockResolvedValue(original);
    const changed = { ...task, enabled: false, version: 'v2' };
    vi.mocked(api.changeScheduledTask).mockImplementation(async () => {
      vi.mocked(api.listSchedules).mockResolvedValue(
        operation === 'delete' ? [] : [changed],
      );
      return operation === 'delete' ? null : changed;
    });
    mount('/schedules?conversation=session-1');
    await userEvent.click(
      await screen.findByRole('link', { name: 'View task' }),
    );
    const dialog = await screen.findByRole('dialog');
    vi.mocked(api.getSchedule).mockImplementation(async () => {
      if (operation === 'delete') throw new Error('Schedule was not found');
      return changed;
    });
    await userEvent.click(
      within(dialog).getByRole('button', {
        name: operation === 'pause' ? 'Pause task' : 'Delete task',
      }),
    );
    if (operation === 'delete') {
      const confirm = await screen.findByRole('alertdialog');
      expect(api.changeScheduledTask).not.toHaveBeenCalled();
      await userEvent.click(
        within(confirm).getByRole('button', { name: 'Delete task' }),
      );
      await waitFor(() =>
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
      );
    } else {
      expect(
        await within(dialog).findByRole('button', { name: 'Resume task' }),
      ).toBeInTheDocument();
    }
    await waitFor(() =>
      expect(api.changeScheduledTask).toHaveBeenCalledWith({
        operation,
        id: task.id,
        version: task.version,
      }),
    );
    expect(screen.getByText('Task saved.')).toBeInTheDocument();
    expect(api.createSchedulingSession).not.toHaveBeenCalled();
    expect(api.proposeScheduleChange).not.toHaveBeenCalled();
    expect(api.decideScheduleChange).not.toHaveBeenCalled();
    expect(api.replySchedulingReceipt).not.toHaveBeenCalled();
    expect(api.sendSchedulingMessage).not.toHaveBeenCalled();
  },
);

it('shows a failed detail action inside the still-open dialog rather than behind it', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue(
    savedTaskConversation(),
  );
  vi.mocked(api.changeScheduledTask).mockRejectedValue(
    new Error('The task changed. Reopen it and try again.'),
  );
  mount('/schedules?conversation=session-1');
  await userEvent.click(await screen.findByRole('link', { name: 'View task' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(
    within(dialog).getByRole('button', { name: 'Pause task' }),
  );
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'The task changed. Reopen it and try again.',
  );
  expect(dialog).toBeVisible();
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Pause task' }),
    ).toBeEnabled(),
  );
});

function confirmationSession(
  operation: api.ScheduleChange['operation'] = 'create',
): SchedulingSession {
  return {
    ...session,
    revision: 1,
    pending: 'recovery-card',
    messages: [
      { id: 'request', role: 'user', text: 'Please arrange my report' },
    ],
    proposals: [
      {
        id: 'recovery-card',
        operation,
        status: 'waiting',
        before: operation === 'create' ? null : task,
        after: task,
        messageIndex: 1,
      },
    ],
  };
}

it.each(['native', 'transport'] as const)(
  'keeps saved actions distinct from %s reply failures and retries only the reply',
  async (failure) => {
    const pending = confirmationSession();
    const saved: SchedulingSession = {
      ...pending,
      revision: 2,
      pending: null,
      receiptPending: true,
      proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
    };
    const failed = { ...saved, error: 'Provider unavailable' };
    const complete: SchedulingSession = {
      ...saved,
      revision: 4,
      receiptPending: false,
      messages: [
        ...saved.messages,
        {
          id: 'reply',
          role: 'assistant',
          text: 'Task saved',
          proposalId: 'recovery-card',
        },
      ],
    };
    vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
    vi.mocked(api.decideScheduleChange).mockImplementation(async () => {
      vi.mocked(api.getSchedulingSession).mockResolvedValue(failed);
      return saved;
    });
    if (failure === 'native')
      vi.mocked(api.replySchedulingReceipt).mockResolvedValueOnce(failed);
    else
      vi.mocked(api.replySchedulingReceipt).mockRejectedValueOnce(
        new Error('Provider unavailable'),
      );
    mount('/schedules?conversation=session-1');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Create task' }),
    );
    expect(
      await screen.findByText(en.schedules.savedReplyFailed),
    ).toBeInTheDocument();
    expect(screen.getByRole('region', { name: task.name })).toBeInTheDocument();
    const draft = screen.getByLabelText(en.schedules.composer);
    fireEvent.change(draft, { target: { value: 'Keep this draft' } });
    vi.mocked(api.replySchedulingReceipt).mockImplementationOnce(async () => {
      vi.mocked(api.getSchedulingSession).mockResolvedValue(complete);
      return complete;
    });
    await userEvent.click(
      await screen.findByRole('button', { name: en.schedules.retryReply }),
    );
    expect(await screen.findByText('Task saved')).toBeInTheDocument();
    expect(api.replySchedulingReceipt).toHaveBeenCalledTimes(2);
    expect(api.decideScheduleChange).toHaveBeenCalledTimes(1);
    expect(api.sendSchedulingMessage).not.toHaveBeenCalled();
    expect(draft).toHaveValue('Keep this draft');
    expect(
      screen.queryByText(en.schedules.savedReplyFailed),
    ).not.toBeInTheDocument();
  },
);

it.each([null, 'Interrupted provider'])(
  'recovers an unanswered receipt after reload without saving again (error: %s)',
  async (error) => {
    const pending = confirmationSession();
    const saved: SchedulingSession = {
      ...pending,
      pending: null,
      receiptPending: true,
      error,
      proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
    };
    vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
    vi.mocked(api.replySchedulingReceipt).mockImplementation(async () => {
      const complete: SchedulingSession = {
        ...saved,
        receiptPending: false,
        error: null,
        messages: [
          ...saved.messages,
          { id: 'done', role: 'assistant', text: 'Recovered reply' },
        ],
      };
      vi.mocked(api.getSchedulingSession).mockResolvedValue(complete);
      return complete;
    });
    mount('/schedules?conversation=session-1');
    await userEvent.click(
      await screen.findByRole('button', { name: en.schedules.retryReply }),
    );
    expect(await screen.findByText('Recovered reply')).toBeInTheDocument();
    expect(api.decideScheduleChange).not.toHaveBeenCalled();
    expect(api.sendSchedulingMessage).not.toHaveBeenCalled();
  },
);

it('offers a new preview after a confirmation conflict and separates saving from model generation', async () => {
  const pending = confirmationSession('update');
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  const decision = deferred<SchedulingSession>();
  vi.mocked(api.decideScheduleChange).mockReturnValue(decision.promise);
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue({
    ...pending,
    error: null,
  });
  mount('/schedules?conversation=session-1');
  await userEvent.click(
    await screen.findByRole('button', { name: en.schedules.confirm.update }),
  );
  expect(
    screen.getByRole('button', { name: en.schedules.actionProgress.update }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: en.schedules.stop }),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId('assistant-thinking')).not.toBeInTheDocument();
  await act(async () => decision.reject(new Error('Schedule changed')));
  await userEvent.click(
    await screen.findByRole('button', { name: en.schedules.repreview }),
  );
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
      'session-1',
      'model-1',
      en.schedules.repreviewRequest,
      expect.any(Function),
      undefined,
    ),
  );
  expect(api.decideScheduleChange).toHaveBeenCalledTimes(1);
});

it('retries a failed send using its original text without clearing a newer draft', async () => {
  vi.mocked(api.sendSchedulingMessage).mockRejectedValueOnce(
    new Error('Offline'),
  );
  mount('/schedules?conversation=session-1');
  const composer = await screen.findByLabelText(en.schedules.composer);
  fireEvent.change(composer, { target: { value: 'Original request' } });
  await userEvent.click(
    screen.getByRole('button', { name: en.schedules.send }),
  );
  await screen.findByText(/Offline/);
  fireEvent.change(composer, { target: { value: 'Next draft' } });
  vi.mocked(api.sendSchedulingMessage).mockResolvedValueOnce({
    ...session,
    messages: [{ id: 'done', role: 'assistant', text: 'Retried successfully' }],
  });
  await userEvent.click(
    await screen.findByRole('button', { name: en.schedules.retrySend }),
  );
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledTimes(2),
  );
  expect(vi.mocked(api.sendSchedulingMessage).mock.calls[1]?.[2]).toBe(
    'Original request',
  );
  expect(composer).toHaveValue('Next draft');
});

it('continues an interrupted request using current native context', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    status: 'interrupted',
    messages: [{ id: 'user', role: 'user', text: 'Original request' }],
  });
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue(session);
  mount('/schedules?conversation=session-1');
  await userEvent.click(
    await screen.findByRole('button', { name: en.schedules.continueRequest }),
  );
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledWith(
      'session-1',
      'model-1',
      en.schedules.continueRequestText,
      expect.any(Function),
      undefined,
    ),
  );
});

it.each(['pause', 'resume'] as const)(
  'uses the %s success message for a direct task action',
  async (operation) => {
    const current = { ...task, enabled: operation === 'pause' };
    vi.mocked(api.getSchedule).mockResolvedValue(current);
    vi.mocked(api.changeScheduledTask).mockResolvedValue({
      ...current,
      enabled: !current.enabled,
    });
    mount('/schedules?task=task-1');
    await userEvent.click(
      await screen.findByRole('button', { name: en.schedules[operation] }),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        operation === 'pause'
          ? en.schedules.taskPaused
          : en.schedules.taskResumed,
        { toasterId: 'global' },
      ),
    );
  },
);

it('reconciles a lost confirmation receipt without repeating the task mutation', async () => {
  const pending = confirmationSession();
  const saved: SchedulingSession = {
    ...pending,
    revision: 2,
    pending: null,
    receiptPending: true,
    proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockImplementation(async () => {
    vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
    throw new Error('Lost confirmation receipt');
  });
  vi.mocked(api.replySchedulingReceipt).mockResolvedValue({
    ...saved,
    receiptPending: false,
    messages: [
      ...saved.messages,
      { id: 'reply', role: 'assistant', text: 'Recovered saved task' },
    ],
  });
  mount('/schedules?conversation=session-1');
  await userEvent.click(
    await screen.findByRole('button', { name: 'Create task' }),
  );
  await userEvent.click(
    await screen.findByRole('button', { name: en.schedules.retryReply }),
  );
  expect(await screen.findByText('Recovered saved task')).toBeInTheDocument();
  expect(api.decideScheduleChange).toHaveBeenCalledTimes(1);
  expect(api.sendSchedulingMessage).not.toHaveBeenCalled();
});

it('does not regenerate a receipt reply that native storage already completed', async () => {
  const pending = confirmationSession();
  const saved: SchedulingSession = {
    ...pending,
    revision: 2,
    pending: null,
    receiptPending: true,
    error: 'Lost reply',
    proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
  mount('/schedules?conversation=session-1');
  const retry = await screen.findByRole('button', {
    name: en.schedules.retryReply,
  });
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...saved,
    revision: 3,
    receiptPending: false,
    error: null,
    messages: [
      ...saved.messages,
      { id: 'reply', role: 'assistant', text: 'Already delivered' },
    ],
  });
  await userEvent.click(retry);
  expect(await screen.findByText('Already delivered')).toBeInTheDocument();
  expect(api.replySchedulingReceipt).not.toHaveBeenCalled();
  expect(api.decideScheduleChange).not.toHaveBeenCalled();
});

it('does not resend a request whose answer was committed before the transport failed', async () => {
  vi.mocked(api.sendSchedulingMessage).mockRejectedValueOnce(
    new Error('Lost response'),
  );
  mount('/schedules?conversation=session-1');
  const composer = await screen.findByLabelText(en.schedules.composer);
  fireEvent.change(composer, { target: { value: 'Original request' } });
  await userEvent.click(
    screen.getByRole('button', { name: en.schedules.send }),
  );
  const retry = await screen.findByRole('button', {
    name: en.schedules.retrySend,
  });
  vi.mocked(api.getSchedulingSession).mockResolvedValue({
    ...session,
    revision: 10,
    messages: [
      { id: 'user', role: 'user', text: 'Original request' },
      { id: 'answer', role: 'assistant', text: 'Already answered' },
    ],
  });
  await userEvent.click(retry);
  expect(await screen.findByText('Already answered')).toBeInTheDocument();
  expect(api.sendSchedulingMessage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not mistake an older identical request for delivery of a failed new send', async () => {
  const loaded: SchedulingSession = {
    ...session,
    messages: [
      { id: 'old-user', role: 'user', text: 'Same request' },
      { id: 'old-answer', role: 'assistant', text: 'Old answer' },
    ],
  };
  vi.mocked(api.getSchedulingSession).mockResolvedValue(loaded);
  vi.mocked(api.sendSchedulingMessage).mockRejectedValueOnce(
    new Error('Offline'),
  );
  mount('/schedules?conversation=session-1');
  await screen.findByText('Old answer');
  fireEvent.change(screen.getByLabelText(en.schedules.composer), {
    target: { value: 'Same request' },
  });
  await userEvent.click(
    screen.getByRole('button', { name: en.schedules.send }),
  );
  const retry = await screen.findByRole('button', {
    name: en.schedules.retrySend,
  });
  vi.mocked(api.sendSchedulingMessage).mockResolvedValue(loaded);
  await userEvent.click(retry);
  await waitFor(() =>
    expect(api.sendSchedulingMessage).toHaveBeenCalledTimes(2),
  );
  expect(vi.mocked(api.sendSchedulingMessage).mock.calls[1]?.[2]).toBe(
    'Same request',
  );
});

it('updates saved result cards after an event reports task deletion without rewriting confirmation history', async () => {
  const saved = savedTaskConversation();
  saved.messages = [
    { id: 'preview', role: 'assistant', text: 'Historical confirmation' },
    ...saved.messages,
  ];
  saved.proposals[0]!.messageIndex = 1;
  vi.mocked(api.getSchedulingSession).mockResolvedValue(saved);
  const client = mount('/schedules?conversation=session-1');
  const result = await screen.findByRole('region', { name: task.name });
  expect(within(result).getByText(en.schedules.active)).toBeInTheDocument();
  client.setQueryData(['schedule', 'personal', task.id], task);
  vi.mocked(api.listSchedules).mockResolvedValue([]);
  act(() =>
    nativeEvents.listeners.get('schedules-changed')!({
      payload: { workspaceId: 'personal' },
    }),
  );
  await waitFor(() =>
    expect(within(result).getByRole('status')).toHaveTextContent(
      en.apps.schedules.deleted,
    ),
  );
  expect(
    within(result).queryByText(en.schedules.active),
  ).not.toBeInTheDocument();
  expect(
    within(result).queryByRole('link', { name: 'View task' }),
  ).not.toBeInTheDocument();
  expect(result).not.toHaveTextContent(en.schedules.next);
  const preview = screen.getByRole('region', { name: en.schedules.taskCard });
  expect(
    within(preview).getByText(en.schedules.cardStatus.saved),
  ).toBeInTheDocument();
  expect(screen.getByText('Historical confirmation')).toBeInTheDocument();
});

it('shows deleted results when opening old history after the task is gone', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue(
    savedTaskConversation(),
  );
  vi.mocked(api.listSchedules).mockResolvedValue([]);
  mount('/schedules?conversation=session-1');
  const result = await screen.findByRole('region', { name: task.name });
  expect(within(result).getByRole('status')).toHaveTextContent(
    en.apps.schedules.deleted,
  );
  expect(within(result).queryByRole('link')).not.toBeInTheDocument();
  expect(api.getSchedule).not.toHaveBeenCalled();
});

it('does not infer task deletion from a failed task-list read', async () => {
  vi.mocked(api.getSchedulingSession).mockResolvedValue(
    savedTaskConversation(),
  );
  vi.mocked(api.listSchedules).mockRejectedValue(
    new Error('Database unavailable'),
  );
  mount('/schedules?conversation=session-1');
  const result = await screen.findByRole('region', { name: task.name });
  expect(within(result).getByText(en.schedules.active)).toBeInTheDocument();
  expect(
    within(result).getByRole('link', { name: 'View task' }),
  ).toBeInTheDocument();
});

it('publishes a newly confirmed task before refreshing an initially empty list', async () => {
  const pending = confirmationSession();
  const saved: SchedulingSession = {
    ...pending,
    revision: 2,
    proposals: [{ ...pending.proposals[0]!, status: 'saved' }],
  };
  vi.mocked(api.listSchedules)
    .mockResolvedValueOnce([])
    .mockReturnValue(new Promise(() => {}));
  vi.mocked(api.getSchedulingSession).mockResolvedValue(pending);
  vi.mocked(api.decideScheduleChange).mockResolvedValue(saved);
  vi.mocked(api.replySchedulingReceipt).mockReturnValue(new Promise(() => {}));
  mount('/schedules?conversation=session-1');
  await userEvent.click(
    await screen.findByRole('button', { name: 'Create task' }),
  );
  const result = await screen.findByRole('region', { name: task.name });
  expect(within(result).getByText(en.schedules.active)).toBeInTheDocument();
  expect(
    within(result).getByRole('link', { name: 'View task' }),
  ).toBeInTheDocument();
  expect(within(result).getByRole('status')).not.toHaveTextContent(
    en.apps.schedules.deleted,
  );
});

it('loads usage for the selected scheduling conversation on demand', async () => {
  vi.mocked(getSessionUsage).mockRejectedValue(new Error('Usage unavailable'));
  mount('/schedules?conversation=session-1');
  const usage = await screen.findByRole('button', { name: en.usage.title });
  expect(getSessionUsage).not.toHaveBeenCalled();
  fireEvent.click(usage);
  await waitFor(() =>
    expect(getSessionUsage).toHaveBeenCalledWith('schedule_agent', 'session-1'),
  );
});

it('does not expose conversation usage for a new draft or in the task list', async () => {
  mount('/schedules');
  await screen.findByText(en.schedules.hero);
  expect(
    screen.queryByRole('button', { name: en.usage.title }),
  ).not.toBeInTheDocument();
  cleanup();
  mount('/schedules?conversation=session-1&view=tasks');
  await screen.findByText(task.name);
  expect(
    screen.queryByRole('button', { name: en.usage.title }),
  ).not.toBeInTheDocument();
});
