import { beforeEach, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  invoke: vi.fn(),
  turn: vi.fn(),
  get: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  saved: new Map<string, unknown>(),
  token: vi.fn(),
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

import {
  createAssistantSession,
  loadAssistantSession,
  sendAssistantMessage,
  provideAssistantInputs,
  declineAssistantWorkflow,
  resumeAssistant,
  setAssistantFeedback,
  setAssistantModel,
  useAssistantStore,
} from './assistant.store';
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
function store(session: AssistantSession) {
  host.saved.set(session.id, structuredClone(session));
  return session;
}
beforeEach(() => {
  vi.resetAllMocks();
  host.saved.clear();
  host.scope.config.workspace_mode = 'personal';
  useAssistantStore.setState({ sessions: {}, scopes: {}, streams: {} });
  host.listen.mockResolvedValue(host.unlisten);
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
      if (command === 'assistant_session_get') return host.get(args.id);
      if (command === 'assistant_turn_start') return host.turn(args.request);
      throw new Error(`Renderer must not invoke ${command}`);
    },
  );
});

it('submits a user turn to native without passing catalogs, tools or workflow execution recipes', async () => {
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
    host.invoke.mock.calls.every(([command]) =>
      [
        'assistant_session_save',
        'assistant_session_get',
        'assistant_turn_start',
      ].includes(command),
    ),
  ).toBe(true);
});

it('observes a native execution until its persisted result arrives', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  let finish!: (session: AssistantSession) => void;
  host.turn.mockImplementationOnce(async () =>
    store({ ...session, status: 'running' }),
  );
  host.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = sendAssistantMessage(session.id, 'Create a report', scope);
  await vi.waitFor(() => expect(current(session.id).status).toBe('running'));
  expect(host.turn).toHaveBeenCalledTimes(1);
  finish(store({ ...session, status: 'idle', messages: [assistantMessage] }));
  await sending;
  expect(current(session.id).status).toBe('idle');
  expect(host.unlisten).toHaveBeenCalledOnce();
});

it('reattaches to a running native session after reload without dispatch or inference', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  store({ ...session, status: 'running' });
  host.get
    .mockResolvedValueOnce({ ...session, status: 'running' })
    .mockResolvedValueOnce({
      ...session,
      status: 'idle',
      messages: [assistantMessage],
    });
  await loadAssistantSession(session.id, scope);
  await vi.waitFor(() => expect(current(session.id).status).toBe('idle'));
  expect(host.turn).not.toHaveBeenCalled();
});

it('does not mark a native inference interrupted merely because the renderer reloaded', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  let finish!: (session: AssistantSession) => void;
  host.get
    .mockResolvedValueOnce({ ...session, status: 'thinking' })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  expect((await loadAssistantSession(session.id, scope)).status).toBe(
    'thinking',
  );
  await vi.waitFor(() => expect(host.listen).toHaveBeenCalled());
  finish({ ...session, status: 'idle' });
  await vi.waitFor(() => expect(current(session.id).status).toBe('idle'));
  expect(host.turn).not.toHaveBeenCalled();
});

it('never retries dispatch when the start IPC response is lost', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  host.turn.mockRejectedValueOnce(new Error('response lost'));
  host.get
    .mockResolvedValueOnce({ ...session, status: 'running' })
    .mockResolvedValueOnce({
      ...session,
      status: 'idle',
      messages: [assistantMessage],
    });
  await sendAssistantMessage(session.id, 'Create a report', scope);
  await vi.waitFor(() => expect(current(session.id).status).toBe('idle'));
  expect(host.turn).toHaveBeenCalledTimes(1);
});

it('forwards missing input decisions and cancellation to the native owner', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  useAssistantStore.setState({
    sessions: { [session.id]: { ...session, status: 'needs_input' } },
  });
  await provideAssistantInputs(session.id, { period: 'week' }, scope);
  expect(host.turn.mock.calls[0]![0].action).toEqual({
    kind: 'inputs',
    input: { period: 'week' },
  });
  useAssistantStore.setState({
    sessions: { [session.id]: { ...session, status: 'needs_input' } },
  });
  await declineAssistantWorkflow(session.id, scope);
  expect(host.turn.mock.calls[1]![0].action).toEqual({ kind: 'decline' });
  await resumeAssistant(session.id, scope);
  expect(host.turn.mock.calls[2]![0].action).toEqual({ kind: 'continue' });
});

it('publishes native stream events and removes the transient message once persisted', async () => {
  const session = await createAssistantSession('model', 'Work', scope);
  let receive!: (event: unknown) => void;
  let finish!: (session: AssistantSession) => void;
  host.listen.mockImplementationOnce(async (_name, callback) => {
    receive = callback;
    return host.unlisten;
  });
  host.turn.mockImplementationOnce(async () =>
    store({ ...session, status: 'thinking' }),
  );
  host.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const sending = sendAssistantMessage(session.id, 'Hello', scope);
  await vi.waitFor(() => expect(host.get).toHaveBeenCalled());
  receive({
    payload: {
      sessionId: session.id,
      messageId: 'answer',
      event: { type: 'text_delta', text: 'Rea' },
    },
  });
  receive({
    payload: {
      sessionId: session.id,
      messageId: 'answer',
      event: { type: 'text_delta', text: 'dy' },
    },
  });
  expect(useAssistantStore.getState().streams[session.id]?.text).toBe('Ready');
  const activity = {
    id: 'progress1',
    turnId: 'user1',
    summary: 'Check available capabilities',
  };
  receive({
    payload: {
      sessionId: session.id,
      messageId: 'answer',
      event: { type: 'activity', summary: activity.summary },
      activity,
    },
  });
  expect(current(session.id).activities).toEqual([activity]);
  const plan = { id: 'plan', version: 1, status: 'ready' };
  for (const [turnId, status] of [
    ['user1', 'ready'],
    ['user2', 'building'],
    ['user2', 'saved'],
  ])
    receive({
      payload: {
        sessionId: session.id,
        messageId: 'answer',
        turnId,
        event: { type: 'workflow_plan', plan: { ...plan, status } },
      },
    });
  expect(
    current(session.id).workflowPlans?.map((entry) => [
      entry.turnId,
      entry.plan.status,
    ]),
  ).toEqual([
    ['user1', 'ready'],
    ['user2', 'saved'],
  ]);
  const reasoning = {
    id: 'thought',
    turnId: 'user1',
    phaseId: 'answer',
    text: 'Check the inputs',
    durationMs: 1200,
    complete: false,
  };
  for (const text of ['Check', 'Check the inputs'])
    receive({
      payload: {
        sessionId: session.id,
        messageId: 'answer',
        event: { type: 'reasoning' },
        reasoning: { ...reasoning, text },
      },
    });
  expect(current(session.id).reasoning).toEqual([reasoning]);
  // A late polling snapshot must not drop reasoning observed over the event channel.
  finish(store({ ...session, status: 'idle', messages: [assistantMessage] }));
  await sending;
  expect(useAssistantStore.getState().streams[session.id]).toBeUndefined();
  expect(current(session.id).activities).toEqual([activity]);
  expect(current(session.id).reasoning).toEqual([reasoning]);
  expect(
    current(session.id).workflowPlans?.map((entry) => entry.plan.status),
  ).toEqual(['ready', 'saved']);
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
  const { decideAssistantPlan } = await import('./assistant.store');
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
  const { decideAssistantPlan } = await import('./assistant.store');
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
  const { decideAssistantTool } = await import('./assistant.store');
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
