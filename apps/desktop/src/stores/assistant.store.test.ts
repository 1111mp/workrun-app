import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  reply: vi.fn(),
  save: vi.fn(),
  get: vi.fn(),
  start: vi.fn(),
  inspect: vi.fn(),
  workflows: vi.fn(),
  resolve: vi.fn(),
  prepare: vi.fn(),
  compile: vi.fn(),
  scope: { config: { workspace_mode: 'personal' }, teamUser: undefined },
}));
vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {
    onmessage?: (event: unknown) => void;
  },
  invoke: (command: string, args: Record<string, unknown>) => {
    if (command === 'assistant_reply')
      return mocks.reply(args.request, args.onEvent);
    if (command === 'assistant_session_save') return mocks.save(args.session);
    if (command === 'assistant_session_get') return mocks.get(args.id);
    throw new Error(`Unexpected command ${command}`);
  },
}));
vi.mock('@/stores/workrun.store', () => ({
  useWorkrunStore: { getState: () => mocks.scope },
}));
vi.mock('@/services/process-node', () => ({
  prepareWorkflowProcessApps: (...args: unknown[]) => mocks.prepare(...args),
}));
vi.mock('@/services/run-history', () => ({
  inspectRunRecord: (...args: unknown[]) => mocks.inspect(...args),
}));
vi.mock('@/services/deeplink', () => ({ validateDeeplinkInput: () => {} }));
vi.mock('@/services/workflow', () => ({
  getWorkflowCapabilities: () => mocks.workflows(),
  getWorkflow: () => mocks.resolve(),
  getPublishedWorkflow: () => mocks.resolve(),
  compileWorkflow: (...args: unknown[]) => mocks.compile(...args),
  toWorkflowDsl: (id: string) => ({ id }),
  startBackgroundWorkflowRun: (...args: unknown[]) => mocks.start(...args),
}));

import {
  capabilityParameters,
  toolResultContent,
  assistantWorkflowResult,
} from '@/services/assistant';

import {
  createAssistantSession,
  sendAssistantMessage,
  provideAssistantInputs,
  loadAssistantSession,
  resumeAssistant,
  setAssistantFeedback,
  useAssistantStore,
} from './assistant.store';

const scope = JSON.stringify(['personal', '', '']);
const workflow = {
  id: 'report',
  document: {
    nodes: [],
    edges: [],
    settings: {
      name: 'Report',
      description: 'Generate a report',
      mode: 'task',
      inputSchema: {
        fields: [
          {
            id: 'topic',
            key: 'topic',
            label: 'Topic',
            type: 'string',
            required: true,
          },
        ],
      },
    },
  },
};
const answer = (text: string) => ({
  text,
  content: { role: 'model', parts: [{ text }] },
});
const toolCall = (input: Record<string, unknown> = { topic: 'sales' }) => ({
  text: 'Preparing your report.',
  content: {
    role: 'model',
    parts: [
      {
        name: 'workflow_report',
        args: input,
        id: 'call-1',
        thought_signature: 'signature',
      },
    ],
  },
  call: {
    workflowId: 'report',
    input,
    toolName: 'workflow_report',
    callId: 'call-1',
  },
});
const finished = {
  id: 'run-1',
  targetName: 'Report',
  status: 'completed',
  events: [
    {
      event: { type: 'done', state: { global: { report: 'Sales increased' } } },
    },
  ],
  runtime: { secret: 'not-for-the-model' },
  targetSnapshot: { secret: 'not-for-the-model' },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.scope.config.workspace_mode = 'personal';
  useAssistantStore.setState({ sessions: {}, scopes: {}, streams: {} });
  mocks.save.mockResolvedValue(undefined);
  mocks.workflows.mockResolvedValue([workflow]);
  mocks.resolve.mockResolvedValue(workflow);
  mocks.compile.mockResolvedValue({});
  mocks.prepare.mockImplementation(async (dsl: unknown) => dsl);
  mocks.start.mockResolvedValue(undefined);
  mocks.inspect.mockResolvedValue(finished);
});

it('answers a normal question without starting a workflow', async () => {
  mocks.reply.mockResolvedValue(answer('Hello'));
  const session = await createAssistantSession('model', 'Hello', scope);
  await sendAssistantMessage(session.id, 'Hello', scope);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'idle',
  );
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)?.text,
  ).toBe('Hello');
});

it('runs the selected workflow, preserves call identity, and gives its real result to the model', async () => {
  mocks.reply
    .mockResolvedValueOnce(toolCall())
    .mockResolvedValueOnce(answer('Sales increased.'));
  const session = await createAssistantSession('model', 'Sales report', scope);
  await sendAssistantMessage(session.id, 'Make a sales report', scope);
  expect(mocks.start).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      targetId: 'report',
      input: { topic: 'sales' },
      initialState: { topic: 'sales' },
    }),
  );
  const request = mocks.reply.mock.calls[1]![0];
  expect(request.contents[1].parts[0].thought_signature).toBe('signature');
  expect(request.contents[2].parts[0]).toMatchObject({
    id: 'call-1',
    functionResponse: {
      name: 'workflow_report',
      response: { status: 'completed' },
    },
  });
  expect(JSON.stringify(request)).not.toContain('not-for-the-model');
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)?.text,
  ).toBe('Sales increased.');
});

it('collects missing inputs before any execution and then continues the same tool call', async () => {
  mocks.reply
    .mockResolvedValueOnce(toolCall({}))
    .mockResolvedValueOnce(answer('Done'));
  const session = await createAssistantSession('model', 'Report', scope);
  await sendAssistantMessage(session.id, 'Create a report', scope);
  expect(mocks.start).not.toHaveBeenCalled();
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'needs_input',
  );
  await provideAssistantInputs(session.id, { topic: 'sales' }, scope);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'idle',
  );
});

it('never repeats dispatch after an uncertain start response and reattaches by run ID', async () => {
  mocks.reply
    .mockResolvedValueOnce(toolCall())
    .mockResolvedValueOnce(answer('Done'));
  mocks.start.mockRejectedValueOnce(new Error('response lost'));
  const session = await createAssistantSession('model', 'Report', scope);
  await sendAssistantMessage(session.id, 'Create a sales report', scope);
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'error',
  );
  await resumeAssistant(session.id, scope);
  expect(mocks.start).toHaveBeenCalledTimes(1);
  expect(mocks.inspect).toHaveBeenCalledWith(expect.any(String));
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'idle',
  );
});

it('rejects duplicate sends while the model is responding', async () => {
  let complete!: (result: ReturnType<typeof answer>) => void;
  mocks.reply.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const session = await createAssistantSession('model', 'Hello', scope);
  const first = sendAssistantMessage(session.id, 'Hello', scope);
  await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
  await sendAssistantMessage(session.id, 'Hello again', scope);
  complete(answer('Hello'));
  await first;
  expect(mocks.reply).toHaveBeenCalledTimes(1);
});

it('restores interrupted inference without automatically issuing a model call or workflow', async () => {
  mocks.get.mockResolvedValue({
    id: 'saved',
    title: 'Saved',
    modelId: 'model',
    status: 'thinking',
    messages: [],
    steps: 0,
  });
  const session = await loadAssistantSession('saved', scope);
  expect(session.status).toBe('error');
  expect(mocks.reply).not.toHaveBeenCalled();
  expect(mocks.start).not.toHaveBeenCalled();
});

it('generates typed input declarations and preserves false as a supplied required value', () => {
  const settings = {
    ...workflow.document.settings,
    inputSchema: {
      fields: [
        {
          id: 'ok',
          key: 'ok',
          label: 'Approved',
          type: 'boolean',
          required: true,
        },
      ],
    },
  } as WorkflowSettings;
  expect(capabilityParameters(settings)).toMatchObject({
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  });
  expect(
    toolResultContent(
      { workflowId: 'x', input: {}, toolName: 'x', callId: 'id' },
      { status: 'cancelled' },
    ),
  ).toMatchObject({ parts: [{ id: 'id' }] });
  expect(
    JSON.stringify(assistantWorkflowResult(finished as never)),
  ).not.toContain('not-for-the-model');
});

it('waits for the actual terminal result before asking the model to continue', async () => {
  let finish!: (record: typeof finished) => void;
  mocks.reply
    .mockResolvedValueOnce(toolCall())
    .mockResolvedValueOnce(answer('Done'));
  mocks.inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const session = await createAssistantSession('model', 'Report', scope);
  const sending = sendAssistantMessage(session.id, 'Create a report', scope);
  await vi.waitFor(() => expect(mocks.inspect).toHaveBeenCalled());
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'running',
  );
  expect(mocks.reply).toHaveBeenCalledTimes(1);
  finish(finished);
  await sending;
  expect(mocks.reply).toHaveBeenCalledTimes(2);
});

it('stops dispatch when the workspace changes and allows explicit recovery after returning', async () => {
  mocks.reply.mockImplementationOnce(async () => {
    mocks.scope.config.workspace_mode = 'team';
    return toolCall();
  });
  const session = await createAssistantSession('model', 'Report', scope);
  await sendAssistantMessage(session.id, 'Create a report', scope);
  expect(mocks.start).not.toHaveBeenCalled();
  mocks.scope.config.workspace_mode = 'personal';
  const restored = await loadAssistantSession(session.id, scope);
  expect(restored.status).toBe('error');
});

it('publishes streaming text before completion and saves exactly one final assistant message', async () => {
  let finish!: (result: ReturnType<typeof answer>) => void;
  let channel!: { onmessage: (event: { type: string; text: string }) => void };
  mocks.reply.mockImplementationOnce((_request, onEvent) => {
    channel = onEvent;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const session = await createAssistantSession('model', 'Hello', scope);
  const sending = sendAssistantMessage(session.id, 'Hello', scope);
  await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
  channel.onmessage({ type: 'text_delta', text: 'Hello ' });
  channel.onmessage({ type: 'text_delta', text: 'world' });
  expect(useAssistantStore.getState().streams[session.id]?.text).toBe(
    'Hello world',
  );
  expect(
    useAssistantStore
      .getState()
      .sessions[session.id]?.messages.filter(
        (message) => message.role === 'assistant',
      ),
  ).toHaveLength(0);
  expect(mocks.start).not.toHaveBeenCalled();
  const previewId = useAssistantStore.getState().streams[session.id]!.messageId;
  finish(answer('Hello world'));
  await sending;
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1),
  ).toMatchObject({ id: previewId, text: 'Hello world' });
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
  channel.onmessage({ type: 'text_delta', text: 'late duplicate' });
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
});

it('replaces authoritative text snapshots without duplicating deltas and retains failed output only as a preview', async () => {
  let fail!: (error: Error) => void;
  let channel!: { onmessage: (event: { type: string; text: string }) => void };
  mocks.reply.mockImplementationOnce((_request, onEvent) => {
    channel = onEvent;
    return new Promise((_resolve, reject) => {
      fail = reject;
    });
  });
  const session = await createAssistantSession('model', 'Hello', scope);
  const sending = sendAssistantMessage(session.id, 'Hello', scope);
  await vi.waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(1));
  channel.onmessage({ type: 'text_delta', text: 'Hello' });
  channel.onmessage({ type: 'text_replace', text: 'Hello world' });
  expect(useAssistantStore.getState().streams[session.id]?.text).toBe(
    'Hello world',
  );
  fail(new Error('connection lost'));
  await sending;
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'error',
  );
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages,
  ).toHaveLength(1);
  expect(mocks.save.mock.calls.at(-1)?.[0].messages).toHaveLength(1);
  channel.onmessage({ type: 'text_delta', text: 'late' });
  expect(useAssistantStore.getState().streams[session.id]?.text).toBe(
    'Hello world',
  );
  mocks.reply.mockResolvedValueOnce(answer('Recovered'));
  await resumeAssistant(session.id, scope);
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)?.text,
  ).toBe('Recovered');
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
});

it('persists mutually exclusive message feedback without regenerating or dispatching work', async () => {
  mocks.reply.mockResolvedValue(answer('Hello'));
  const session = await createAssistantSession('model', 'Hello', scope);
  await sendAssistantMessage(session.id, 'Hello', scope);
  const messageId = useAssistantStore
    .getState()
    .sessions[session.id]!.messages.at(-1)!.id;
  await setAssistantFeedback(session.id, messageId, 'helpful', scope);
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)
      ?.feedback,
  ).toBe('helpful');
  expect(mocks.save.mock.calls.at(-1)?.[0].messages.at(-1).feedback).toBe(
    'helpful',
  );
  await setAssistantFeedback(session.id, messageId, 'unhelpful', scope);
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)
      ?.feedback,
  ).toBe('unhelpful');
  await setAssistantFeedback(session.id, messageId, 'unhelpful', scope);
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)
      ?.feedback,
  ).toBeUndefined();
  expect(mocks.reply).toHaveBeenCalledTimes(1);
  expect(mocks.start).not.toHaveBeenCalled();
});

it('does not mark a completed response as failed when saving feedback fails', async () => {
  mocks.reply.mockResolvedValue(answer('Hello'));
  const session = await createAssistantSession('model', 'Hello', scope);
  await sendAssistantMessage(session.id, 'Hello', scope);
  const messageId = useAssistantStore
    .getState()
    .sessions[session.id]!.messages.at(-1)!.id;
  mocks.save.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(
    setAssistantFeedback(session.id, messageId, 'helpful', scope),
  ).rejects.toThrow('storage unavailable');
  expect(useAssistantStore.getState().sessions[session.id]?.status).toBe(
    'idle',
  );
  expect(
    useAssistantStore.getState().sessions[session.id]?.error,
  ).toBeUndefined();
  expect(
    useAssistantStore.getState().sessions[session.id]?.messages.at(-1)
      ?.feedback,
  ).toBeUndefined();
  expect(mocks.reply).toHaveBeenCalledTimes(1);
});
