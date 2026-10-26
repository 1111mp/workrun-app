import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  invoke: vi.fn(),
  turn: vi.fn(),
  get: vi.fn(),
  token: vi.fn(),
  listen: vi.fn(),
  listeners: new Set<(event: unknown) => void>(),
  saved: new Map<string, unknown>(),
  sequences: new Map<string, number>(),
  scope: {
    config: {
      workspace_mode: 'personal',
      team: { server_url: 'https://team.example' },
    },
    teamUser: { id: 'user' },
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => host.invoke(...args),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => host.listen(...args),
}));
vi.mock('@/lib/auth-client', () => ({
  createTeamAuthClient: () => ({ getSession: () => host.token() }),
}));
vi.mock('@/stores/workrun.store', () => ({
  useWorkrunStore: { getState: () => host.scope },
}));

import type { AssistantSession } from '@/services/assistant';

import { useAssistantStore } from './assistant.store';
const {
  createAssistantSession,
  loadAssistantSession,
  sendAssistantMessage,
  provideAssistantInputs,
  declineAssistantWorkflow,
  resumeAssistant,
  setAssistantFeedback,
  setAssistantModel,
  disposeAssistantEvents,
  loadAssistantList,
} = useAssistantStore.getState();
const scope = JSON.stringify(['personal', '', '']);
const assistantMessage = {
  id: 'answer',
  role: 'assistant' as const,
  text: 'Ready',
  content: { role: 'model', parts: [{ text: 'Ready' }] },
};
function current(id: string) {
  return useAssistantStore.getState().sessions[id]!;
}
function envelope(id: string, sequence: number, session: unknown) {
  return {
    workspaceId: host.scope.config.workspace_mode,
    sessionId: id,
    epoch: 'process-1',
    sequence,
    type: 'snapshot',
    payload: { session, stream: null },
  };
}
function store(session: AssistantSession) {
  host.saved.set(session.id, structuredClone(session));
  const sequence = (host.sequences.get(session.id) ?? 0) + 1;
  host.sequences.set(session.id, sequence);
  for (const receive of host.listeners)
    receive({
      payload: envelope(session.id, sequence, structuredClone(session)),
    });
  return session;
}
function stream(id: string, payload: unknown) {
  const sequence = (host.sequences.get(id) ?? 0) + 1;
  host.sequences.set(id, sequence);
  for (const receive of host.listeners)
    receive({
      payload: {
        workspaceId: host.scope.config.workspace_mode,
        sessionId: id,
        epoch: 'process-1',
        sequence,
        type: 'stream',
        payload,
      },
    });
}
afterEach(() => {
  disposeAssistantEvents();
  vi.useRealTimers();
});
beforeEach(() => {
  disposeAssistantEvents();
  vi.resetAllMocks();
  host.saved.clear();
  host.listeners.clear();
  host.sequences.clear();
  host.scope.config.workspace_mode = 'personal';
  useAssistantStore.setState({
    sessions: {},
    scopes: {},
    streams: {},
    syncErrors: {},
    summaries: {},
    listErrors: {},
  });
  host.listen.mockImplementation(async (_name, receive) => {
    host.listeners.add(receive);
    return () => host.listeners.delete(receive);
  });
  host.get.mockImplementation(async (id: string) =>
    structuredClone(host.saved.get(id)),
  );
  host.turn.mockImplementation(async (request: { sessionId: string }) => {
    const session = structuredClone(
      host.saved.get(request.sessionId),
    ) as AssistantSession;
    return store({ ...session, messages: [assistantMessage], status: 'idle' });
  });
  host.token.mockResolvedValue({
    data: { session: { token: 'private-team-token' } },
  });
  host.invoke.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      if (command === 'assistant_session_save') {
        store(args.session as AssistantSession);
        return;
      }
      if (command === 'assistant_session_list')
        return {
          workspaceId: host.scope.config.workspace_mode,
          sessionId: '',
          epoch: 'process-1',
          sequence: 0,
          type: 'list',
          payload: [],
        };
      if (command === 'assistant_session_get') {
        const id = args.id as string;
        const sequence = host.sequences.get(id) ?? 0;
        return envelope(id, sequence, await host.get(id));
      }
      if (command === 'assistant_turn_start') return host.turn(args.request);
      throw new Error(`Renderer must not invoke ${command}`);
    },
  );
});

it('listens once before dispatch and submits no catalogs or execution recipes', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  await sendAssistantMessage(session.id, 'Create a report', scope, [
    { $type: 'artifact' },
  ]);
  expect(host.turn).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    action: {
      kind: 'send',
      text: 'Create a report',
      attachments: [{ $type: 'artifact' }],
    },
    teamToken: undefined,
  });
  expect(current(session.id).messages).toEqual([assistantMessage]);
  expect(
    host.invoke.mock.calls.some(([command]) => command.includes('subscribe')),
  ).toBe(false);
});

it('receives completion by push without periodic IPC while running', async () => {
  vi.useFakeTimers();
  const session = await createAssistantSession('model', 'Work', scope);
  host.turn.mockImplementationOnce(async () =>
    store({ ...session, status: 'running' }),
  );
  await sendAssistantMessage(session.id, 'Create a report', scope);
  expect(current(session.id).status).toBe('running');
  const calls = host.invoke.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(host.invoke).toHaveBeenCalledTimes(calls);
  store({ ...session, status: 'idle', messages: [assistantMessage] });
  expect(current(session.id).status).toBe('idle');
  expect(host.turn).toHaveBeenCalledOnce();
  expect(host.listen).toHaveBeenCalledExactlyOnceWith(
    'assistant-event',
    expect.any(Function),
  );
});

it('uses the same application listener when opening different conversations', async () => {
  const first = await createAssistantSession('model', 'First', scope);
  const second = await createAssistantSession('model', 'Second', scope);
  await loadAssistantSession(first.id, scope);
  await loadAssistantSession(second.id, scope);
  expect(host.listen).toHaveBeenCalledExactlyOnceWith(
    'assistant-event',
    expect.any(Function),
  );
  expect(host.listeners.size).toBe(1);
  store({ ...first, status: 'idle', messages: [assistantMessage] });
  expect(current(first.id).messages).toEqual([assistantMessage]);
  expect(current(second.id).messages).toEqual([]);
});

it('ignores events from the previous workspace without registering another listener', async () => {
  const first = await createAssistantSession('model', 'Personal', scope);
  host.scope.config.workspace_mode = 'team';
  const teamScope = JSON.stringify(['team', 'https://team.example', 'user']);
  const second = await createAssistantSession('model', 'Team', teamScope);
  for (const receive of host.listeners)
    receive({
      payload: {
        ...envelope(first.id, 99, { ...first, messages: [assistantMessage] }),
        workspaceId: 'personal',
      },
    });
  expect(current(first.id).messages).toEqual([]);
  expect(useAssistantStore.getState().scopes[second.id]).toBe(teamScope);
  expect(host.listen).toHaveBeenCalledOnce();
});

it('shows listener initialization failures and recovers on a manual read', async () => {
  host.listen.mockRejectedValueOnce(new Error('event listener unavailable'));
  await expect(loadAssistantList(scope)).rejects.toThrow(
    'event listener unavailable',
  );
  expect(useAssistantStore.getState().listErrors[scope]).toContain(
    'event listener unavailable',
  );
  await loadAssistantList(scope);
  expect(useAssistantStore.getState().listErrors[scope]).toBeUndefined();
});

it('continues receiving events when a list refresh fails', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, status: 'thinking' });
  let reject!: (error: Error) => void;
  host.invoke.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const refresh = loadAssistantList(scope);
  await vi.waitFor(() => expect(reject).toBeDefined());
  store({ ...session, status: 'idle', messages: [assistantMessage] });
  expect(current(session.id).messages).toEqual([assistantMessage]);
  reject(new Error('list read failed'));
  await expect(refresh).rejects.toThrow('list read failed');
  expect(current(session.id).status).toBe('idle');
});

it('buffers updates received before the initial snapshot reply', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  let finish!: (value: AssistantSession) => void;
  host.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const loading = loadAssistantSession(session.id, scope);
  await vi.waitFor(() => expect(finish).toBeDefined());
  store({ ...session, status: 'idle', messages: [assistantMessage] });
  finish({ ...session, status: 'thinking' });
  await loading;
  expect(current(session.id).status).toBe('idle');
  expect(current(session.id).messages).toEqual([assistantMessage]);
});

it('reattaches after reload without inference or dispatch', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({
    ...session,
    status: 'thinking',
    reasoning: [
      {
        id: 'thought',
        turnId: 'user',
        phaseId: 'answer',
        text: 'Checking',
        durationMs: 1,
        complete: false,
      },
    ],
  });
  disposeAssistantEvents();
  useAssistantStore.setState({ sessions: {}, scopes: {}, streams: {} });
  expect((await loadAssistantSession(session.id, scope)).status).toBe(
    'thinking',
  );
  expect(current(session.id).reasoning?.[0]?.text).toBe('Checking');
  store({ ...session, status: 'idle', messages: [assistantMessage] });
  expect(current(session.id).status).toBe('idle');
  expect(host.turn).not.toHaveBeenCalled();
});

it('does not overwrite a pushed completion with a delayed start acknowledgment', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  host.turn.mockImplementationOnce(async () => {
    store({ ...session, status: 'idle', messages: [assistantMessage] });
    return { ...session, status: 'thinking' };
  });
  await sendAssistantMessage(session.id, 'Hello', scope);
  expect(current(session.id).status).toBe('idle');
  expect(current(session.id).messages).toEqual([assistantMessage]);
});

it('reattaches once after an uncertain start response without retrying dispatch', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  host.turn.mockImplementationOnce(async () => {
    store({ ...session, status: 'running' });
    throw new Error('response lost');
  });
  await sendAssistantMessage(session.id, 'Hello', scope);
  expect(current(session.id).status).toBe('running');
  expect(host.turn).toHaveBeenCalledOnce();
  store({ ...session, status: 'idle', messages: [assistantMessage] });
  expect(current(session.id).status).toBe('idle');
  expect(useAssistantStore.getState().syncErrors[session.id]).toBeUndefined();
});

it('receives waiting states globally and clears transient text on terminal snapshots', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, status: 'thinking' });
  stream(session.id, {
    sessionId: session.id,
    messageId: 'answer',
    event: { type: 'text_delta', text: 'Rea' },
  });
  stream(session.id, {
    sessionId: session.id,
    messageId: 'answer',
    event: { type: 'text_delta', text: 'dy' },
  });
  expect(useAssistantStore.getState().streams[session.id]?.text).toBe('Ready');
  const reasoning = {
    id: 'thought',
    turnId: 'user',
    phaseId: 'answer',
    text: 'Checking',
    durationMs: 1,
    complete: false,
  };
  stream(session.id, {
    sessionId: session.id,
    messageId: 'answer',
    event: { type: 'reasoning' },
    reasoning,
  });
  expect(current(session.id).reasoning).toEqual([reasoning]);
  store({ ...session, status: 'awaiting_feedback', reasoning: [reasoning] });
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
  store({
    ...session,
    status: 'idle',
    messages: [assistantMessage],
    reasoning: [reasoning],
  });
  expect(current(session.id).messages).toEqual([assistantMessage]);
  stream(session.id, {
    sessionId: session.id,
    messageId: 'answer',
    event: { type: 'text_delta', text: 'Late text' },
  });
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
});

it('reports snapshot read errors without polling or dispatching', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  host.get.mockRejectedValueOnce(new Error('snapshot unavailable'));
  await expect(loadAssistantSession(session.id, scope)).rejects.toThrow(
    'snapshot unavailable',
  );
  expect(useAssistantStore.getState().syncErrors[session.id]).toContain(
    'snapshot unavailable',
  );
  expect(host.turn).not.toHaveBeenCalled();
  expect(
    host.invoke.mock.calls.some(([command]) => command.includes('subscribe')),
  ).toBe(false);
  await loadAssistantSession(session.id, scope);
  expect(useAssistantStore.getState().syncErrors[session.id]).toBeUndefined();
});

it('forwards input decisions and cancellation to the native owner', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, status: 'needs_input' });
  await provideAssistantInputs(session.id, { period: 'week' }, scope);
  store({ ...session, status: 'needs_input' });
  await declineAssistantWorkflow(session.id, scope);
  await resumeAssistant(session.id, scope);
  expect(host.turn.mock.calls.map(([request]) => request.action)).toEqual([
    { kind: 'inputs', input: { period: 'week' } },
    { kind: 'decline' },
    { kind: 'continue' },
  ]);
});

it('keeps team authentication in the native request, outside conversation data', async () => {
  host.scope.config.workspace_mode = 'team';
  const teamScope = JSON.stringify(['team', 'https://team.example', 'user']);
  const session = await createAssistantSession('model', 'Work', teamScope);
  await sendAssistantMessage(session.id, 'Hello', teamScope);
  expect(host.turn.mock.calls[0]![0].teamToken).toBe('private-team-token');
  expect(JSON.stringify(current(session.id))).not.toContain(
    'private-team-token',
  );
});

it('prevents simultaneous submissions from the same renderer', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  let finish!: (session: AssistantSession) => void;
  host.turn.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = sendAssistantMessage(session.id, 'Hello', scope);
  await vi.waitFor(() => expect(host.turn).toHaveBeenCalledOnce());
  await sendAssistantMessage(session.id, 'Hello again', scope);
  finish(session);
  await first;
  expect(host.turn).toHaveBeenCalledOnce();
});

it('persists feedback without replaying the native turn', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, messages: [assistantMessage] });
  await loadAssistantSession(session.id, scope);
  await setAssistantFeedback(session.id, 'answer', 'helpful', scope);
  expect(current(session.id).messages[0]?.feedback).toBe('helpful');
  expect(host.turn).not.toHaveBeenCalled();
});

it('persists a new model without replacing conversation history', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  await sendAssistantMessage(session.id, 'Hello', scope);
  const messages = current(session.id).messages;
  await setAssistantModel(session.id, 'other', scope);
  expect(current(session.id).modelId).toBe('other');
  expect(current(session.id).messages).toEqual(messages);
  expect((host.saved.get(session.id) as AssistantSession).modelId).toBe(
    'other',
  );
});

it('submits only an exact plan version decision to native and rejects stale cards', async () => {
  const { decideAssistantPlan } = useAssistantStore.getState();
  const session = await createAssistantSession('model', 'Plan', scope);
  const plan = {
    id: 'plan-id',
    sessionId: session.id,
    version: 2,
    status: 'ready' as const,
    dependencyIssues: [],
    document: {
      goal: 'Process input',
      summary: 'Reviewable approach',
      inputs: [],
      outputs: ['Report'],
      steps: [],
      constraints: [],
      assumptions: [],
      questions: [],
      acceptance_criteria: ['Verified output'],
    },
  };
  useAssistantStore.setState({
    sessions: { [session.id]: { ...session, workflowPlan: plan } },
  });
  store({ ...session, workflowPlan: plan });
  await expect(
    decideAssistantPlan(session.id, plan.id, 1, 'approve', 'Create', scope),
  ).rejects.toThrow('Plan changed');
  expect(host.turn).not.toHaveBeenCalled();
  await decideAssistantPlan(
    session.id,
    plan.id,
    2,
    'approve',
    'Confirm and create',
    scope,
  );
  expect(host.turn).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    action: {
      kind: 'planDecision',
      plan_id: plan.id,
      version: 2,
      decision: 'approve',
      text: 'Confirm and create',
    },
    teamToken: undefined,
  });
});

it('allows conversation while a task waits and binds button feedback to its interaction', async () => {
  const { decideAssistantPlan } = useAssistantStore.getState();
  const session = await createAssistantSession('model', 'Waiting task', scope);
  const pending = {
    ...session,
    status: 'awaiting_feedback' as const,
    workflowPlan: {
      id: 'plan-id',
      sessionId: session.id,
      version: 1,
      status: 'ready' as const,
      dependencyIssues: [],
      interaction: {
        id: 'plan-id:v1',
        taskId: 'plan-id',
        threadId: 'thread',
        checkpointId: 'checkpoint',
        version: 1,
        kind: 'plan_confirmation' as const,
        status: 'waiting' as const,
      },
      document: {
        goal: 'Process records',
        summary: 'Review approach',
        inputs: [],
        outputs: [],
        steps: [],
        constraints: [],
        assumptions: [],
        questions: [],
        acceptance_criteria: [],
      },
    },
  };
  store(pending);
  useAssistantStore.setState({ sessions: { [session.id]: pending } });
  await sendAssistantMessage(session.id, 'Explain the proposed steps', scope);
  expect(host.turn.mock.calls[0]![0].action).toEqual({
    kind: 'send',
    text: 'Explain the proposed steps',
    attachments: [],
  });
  store(pending);
  useAssistantStore.setState({ sessions: { [session.id]: pending } });
  await decideAssistantPlan(
    session.id,
    'plan-id',
    1,
    'approve',
    'Confirm',
    scope,
  );
  expect(host.turn.mock.calls[1]![0].action).toEqual({
    kind: 'planDecision',
    plan_id: 'plan-id',
    version: 1,
    interaction_id: 'plan-id:v1',
    checkpoint_id: 'checkpoint',
    decision: 'approve',
    text: 'Confirm',
  });
});

it('sends only frozen tool and checkpoint identities for explicit feedback and rejects stale cards', async () => {
  const { decideAssistantTool } = useAssistantStore.getState();
  const session = await createAssistantSession('model', 'Tool approval', scope);
  const confirmation = {
    id: 'operation',
    turnId: 'turn',
    turnKey: 'key',
    tool: { id: 'tool', displayName: 'Tool' },
    arguments: { value: 2 },
    interaction: {
      id: 'tool:operation',
      taskId: 'operation',
      threadId: 'thread',
      checkpointId: 'checkpoint',
      kind: 'tool_confirmation' as const,
      version: 1,
      status: 'waiting' as const,
    },
  };
  const waiting = {
    ...session,
    status: 'awaiting_feedback' as const,
    pendingTool: confirmation,
    toolConfirmations: [confirmation],
  };
  store(waiting);
  useAssistantStore.setState({ sessions: { [session.id]: waiting } });
  await expect(
    decideAssistantTool(
      session.id,
      {
        ...confirmation,
        interaction: { ...confirmation.interaction, checkpointId: 'stale' },
      },
      'approve',
      'Approve',
      scope,
    ),
  ).rejects.toThrow('changed');
  expect(host.turn).not.toHaveBeenCalled();
  await decideAssistantTool(
    session.id,
    confirmation,
    'approve',
    'Approve exact call',
    scope,
  );
  expect(host.turn).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    teamToken: undefined,
    action: {
      kind: 'toolDecision',
      operation_id: 'operation',
      interaction_id: 'tool:operation',
      checkpoint_id: 'checkpoint',
      decision: 'approve',
      text: 'Approve exact call',
    },
  });
});

it('submits workflow confirmation only for the active request and never auto-resumes it', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  const confirmation = {
    id: 'confirmation',
    turnId: 'turn',
    workflowId: 'workflow',
    name: 'Selected',
    input: { amount: 0 },
    status: 'waiting' as const,
    changed: false,
  };
  const activeCall = {
    workflowId: 'workflow',
    toolName: 'execute_capability',
    input: { amount: 0 },
    confirmation,
    workflow: {
      id: 'workflow',
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
      document: {
        nodes: [],
        edges: [],
        settings: {
          name: 'Selected',
          description: '',
          mode: 'task',
          inputSchema: { fields: [] },
        },
      },
    },
  } satisfies NonNullable<AssistantSession['activeCall']>;
  const waiting: AssistantSession = {
    ...session,
    status: 'awaiting_run_confirmation',
    activeCall,
    workflowConfirmations: [confirmation],
  };
  store(waiting);
  host.turn.mockClear();
  await resumeAssistant(session.id, scope);
  expect(host.turn).not.toHaveBeenCalled();
  await useAssistantStore
    .getState()
    .decideAssistantWorkflow(session.id, 'old', 'approve', scope);
  expect(host.turn).not.toHaveBeenCalled();
  host.turn.mockImplementationOnce(async () =>
    store({ ...waiting, status: 'running' }),
  );
  await useAssistantStore
    .getState()
    .decideAssistantWorkflow(session.id, 'confirmation', 'approve', scope);
  expect(host.turn).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    action: {
      kind: 'runDecision',
      confirmation_id: 'confirmation',
      decision: 'approve',
    },
    teamToken: undefined,
  });
  await useAssistantStore
    .getState()
    .decideAssistantWorkflow(session.id, 'confirmation', 'approve', scope);
  expect(host.turn).toHaveBeenCalledOnce();
});

it('sends a rejected workflow selection as explicit feedback for another assistant turn', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  const confirmation = {
    id: 'selection',
    turnId: 'turn',
    workflowId: 'wrong',
    name: 'Wrong',
    input: {},
    status: 'waiting' as const,
    changed: false,
  };
  const activeCall = {
    workflowId: 'wrong',
    toolName: 'execute_capability',
    input: {},
    confirmation,
    workflow: {
      id: 'wrong',
      createdAt: '2026-10-23T00:00:00Z',
      updatedAt: '2026-10-23T00:00:00Z',
      document: {
        nodes: [],
        edges: [],
        settings: {
          name: 'Wrong',
          description: '',
          mode: 'task',
          inputSchema: { fields: [] },
        },
      },
    },
  } satisfies NonNullable<AssistantSession['activeCall']>;
  store({
    ...session,
    status: 'awaiting_run_confirmation',
    activeCall,
    workflowConfirmations: [confirmation],
  });
  host.turn.mockClear();
  const feedback = 'Not this workflow. Please reconsider my original request.';
  host.turn.mockImplementationOnce(async () =>
    store({ ...session, status: 'thinking' }),
  );
  await useAssistantStore
    .getState()
    .decideAssistantWorkflow(
      session.id,
      'selection',
      'reselect',
      scope,
      feedback,
    );
  expect(host.turn).toHaveBeenCalledExactlyOnceWith({
    sessionId: session.id,
    action: {
      kind: 'runDecision',
      confirmation_id: 'selection',
      decision: 'reselect',
      text: feedback,
    },
    teamToken: undefined,
  });
  expect(current(session.id).status).toBe('thinking');
});

it('keeps phase and plan order when late streaming updates revise an earlier entry', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, status: 'thinking' });
  const thought = (id: string, text: string) => ({
    id,
    turnId: 'user',
    phaseId: id,
    text,
    durationMs: 1,
    complete: false,
  });
  for (const reasoning of [
    thought('first', 'First phase'),
    thought('second', 'Second phase'),
    thought('first', 'First phase final chunk'),
  ]) {
    stream(session.id, {
      sessionId: session.id,
      messageId: 'answer',
      event: { type: 'reasoning' },
      reasoning,
    });
  }
  expect(current(session.id).reasoning?.map((item) => item.phaseId)).toEqual([
    'first',
    'second',
  ]);
  expect(current(session.id).reasoning?.[0]?.text).toBe(
    'First phase final chunk',
  );
  const plan = (version: number, status: string) => ({
    id: 'plan',
    sessionId: session.id,
    version,
    status,
    dependencyIssues: [],
    document: {
      goal: 'Report',
      summary: 'Report',
      inputs: [],
      outputs: [],
      steps: [],
      constraints: [],
      assumptions: [],
      questions: [],
      acceptance_criteria: [],
    },
  });
  for (const value of [plan(1, 'ready'), plan(2, 'ready'), plan(1, 'saved')]) {
    stream(session.id, {
      sessionId: session.id,
      turnId: 'user',
      messageId: 'answer',
      event: { type: 'workflow_plan', plan: value },
    });
  }
  expect(
    current(session.id).workflowPlans?.map((entry) => entry.plan.version),
  ).toEqual([1, 2]);
  expect(current(session.id).workflowPlans?.[0]?.plan.status).toBe('saved');
});

it('prepends older messages and preserves live state and loaded history across bounded snapshots', async () => {
  const { loadAssistantHistory } = await import('./assistant.runtime');
  const session = await createAssistantSession('model', 'Paged', scope);
  const recent = {
    ...session,
    messages: [assistantMessage],
    history: { hasMore: true, beforeSequence: 50 },
  };
  store(recent);
  host.invoke.mockImplementationOnce(async () => ({
    ...recent,
    status: 'idle',
    messages: [{ ...assistantMessage, id: 'old', text: 'Older' }],
    history: { hasMore: false, beforeSequence: 0 },
  }));
  await loadAssistantHistory(session.id, scope);
  expect(current(session.id).messages.map((message) => message.id)).toEqual([
    'old',
    'answer',
  ]);
  store({
    ...recent,
    status: 'thinking',
    messages: [{ ...assistantMessage, text: 'Updated' }],
  });
  expect(current(session.id).messages.map((message) => message.id)).toEqual([
    'old',
    'answer',
  ]);
  expect(current(session.id).messages[1]!.text).toBe('Updated');
  expect(current(session.id).history).toEqual({
    hasMore: false,
    beforeSequence: 0,
  });
  expect(current(session.id).status).toBe('thinking');
  store({
    ...recent,
    messages: [{ ...assistantMessage, id: 'far-away' }],
    history: { hasMore: true, beforeSequence: 100 },
  });
  expect(current(session.id).messages.map((message) => message.id)).toEqual([
    'far-away',
  ]);
  expect(current(session.id).history?.hasMore).toBe(true);
});
