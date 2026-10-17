import { create } from 'zustand';

import { artifactReferences } from '@/services/artifact';
import {
  assistantReply,
  assistantWorkflowResult,
  getAssistantSession,
  missingWorkflowInputs,
  resolveAssistantWorkflow,
  saveAssistantSession,
  toolResultContent,
  type AssistantMessage,
  type AssistantSession,
} from '@/services/assistant';
import { prepareWorkflowProcessApps } from '@/services/process-node';
import { inspectRunRecord } from '@/services/run-history';
import {
  getWorkflowCapabilities,
  startBackgroundWorkflowRun,
  toWorkflowDsl,
} from '@/services/workflow';
import { useWorkrunStore } from '@/stores/workrun.store';

export const useAssistantStore = create<{
  sessions: Record<string, AssistantSession>;
  scopes: Record<string, string>;
  streams: Record<string, { messageId: string; text: string }>;
}>(() => ({ sessions: {}, scopes: {}, streams: {} }));
const locks = new Set<string>();
const workspace = () => {
  const state = useWorkrunStore.getState();
  return JSON.stringify([
    state.config?.workspace_mode ?? 'personal',
    state.config?.workspace_mode === 'team'
      ? state.config.team?.server_url
      : '',
    state.config?.workspace_mode === 'team' ? state.teamUser?.id : '',
  ]);
};
function ensureWorkspace(scope: string) {
  if (workspace() !== scope)
    throw new Error(
      'Workspace changed. Reopen this conversation in its workspace.',
    );
}
function publish(session: AssistantSession, scope: string) {
  useAssistantStore.setState((state) => {
    const streams = { ...state.streams };
    const stream = streams[session.id];
    if (
      stream &&
      session.messages.some((message) => message.id === stream.messageId)
    )
      delete streams[session.id];
    return {
      sessions: { ...state.sessions, [session.id]: session },
      scopes: { ...state.scopes, [session.id]: scope },
      streams,
    };
  });
}

async function commit(session: AssistantSession, scope: string) {
  ensureWorkspace(scope);
  await saveAssistantSession(session);
  ensureWorkspace(scope);
  publish(session, scope);
}
function latest(id: string) {
  const value = useAssistantStore.getState().sessions[id];
  if (!value) throw new Error('Conversation is not loaded.');
  return value;
}
async function guarded(id: string, scope: string, action: () => Promise<void>) {
  if (locks.has(id)) return;
  locks.add(id);
  try {
    ensureWorkspace(scope);
    await action();
  } catch (error) {
    if (workspace() === scope && useAssistantStore.getState().sessions[id]) {
      const session = {
        ...latest(id),
        status: 'error' as const,
        error: String(error),
      };
      publish(session, scope);
      try {
        await saveAssistantSession(session);
      } catch {
        /* Keep the failure visible even if storage itself failed. */
      }
    }
  } finally {
    locks.delete(id);
  }
}

export async function createAssistantSession(
  modelId: string,
  title: string,
  scope: string,
) {
  const session: AssistantSession = {
    id: crypto.randomUUID(),
    title: title.slice(0, 72),
    modelId,
    messages: [],
    status: 'idle',
    steps: 0,
  };
  await commit(session, scope);
  return session;
}

export async function loadAssistantSession(id: string, scope: string) {
  ensureWorkspace(scope);
  const state = useAssistantStore.getState();
  const cached = state.scopes[id] === scope ? state.sessions[id] : undefined;
  if (cached && locks.has(id)) return cached;
  const session = cached
    ? structuredClone(cached)
    : await getAssistantSession(id);
  ensureWorkspace(scope);
  // A renderer restart must never repeat a call whose side effects are unknown.
  // Native runs can be reattached by ID; unfinished inference requires explicit retry.
  if (
    session.status === 'thinking' ||
    (session.status === 'running' && !session.activeCall?.runId)
  ) {
    session.status = 'error';
    session.error =
      'Assistant response was interrupted. Continue to retry the response.';
  }
  publish(session, scope);
  if (session.activeCall?.runId && session.status === 'running')
    void resumeAssistant(id, scope);
  return session;
}

function appendToolResult(
  session: AssistantSession,
  response: unknown,
  text: string,
): AssistantSession {
  const call = session.activeCall!;
  const message: AssistantMessage = {
    id: crypto.randomUUID(),
    role: 'tool',
    text,
    content: toolResultContent(call, response),
    runId: call.runId,
    workflowName: call.workflow.document.settings.name,
    artifacts: artifactReferences(response),
  };
  return {
    ...session,
    activeCall: undefined,
    messages: [...session.messages, message],
    status: 'thinking',
    error: undefined,
  };
}

async function waitForWorkflow(id: string, scope: string) {
  const call = latest(id).activeCall!;
  if (!call.runId) throw new Error('Workflow run has not started.');
  for (;;) {
    ensureWorkspace(scope);
    const record = await inspectRunRecord(call.runId);
    if (
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(
        record.status,
      )
    ) {
      await commit(
        appendToolResult(
          latest(id),
          assistantWorkflowResult(record),
          record.status,
        ),
        scope,
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function launchWorkflow(
  id: string,
  scope: string,
  input: Record<string, unknown>,
) {
  const session = latest(id);
  const call = session.activeCall!;
  const workflow = call.workflow;
  const settings = workflow.document.settings;
  if (missingWorkflowInputs(settings, input).length) {
    await commit(
      { ...session, status: 'needs_input', activeCall: { ...call, input } },
      scope,
    );
    return false;
  }
  const dsl = await prepareWorkflowProcessApps(
    toWorkflowDsl(
      workflow.id,
      workflow.document.nodes,
      workflow.document.edges,
      settings,
    ),
    `release-${workflow.releaseId ?? `draft-${workflow.id}`}`,
    () => undefined,
  );
  ensureWorkspace(scope);
  const runId = crypto.randomUUID();
  // Persist identity before starting. Recovery only observes this run; it never
  // dispatches a second execution when a create response was lost.
  await commit(
    { ...latest(id), status: 'running', activeCall: { ...call, input, runId } },
    scope,
  );
  await startBackgroundWorkflowRun({
    runId,
    targetId: workflow.id,
    targetName: settings.name,
    input,
    initialState: input,
    targetSnapshot: workflow.document,
    dsl,
    threadId: crypto.randomUUID(),
    releaseId: workflow.releaseId,
    releaseVersion: workflow.version,
  });
  await waitForWorkflow(id, scope);
  return true;
}

async function driveAssistant(id: string, scope: string) {
  for (;;) {
    ensureWorkspace(scope);
    let session = latest(id);
    if (session.steps >= 8)
      throw new Error(
        'Automatic workflow limit reached. Start a new turn to continue.',
      );
    const capabilities = await getWorkflowCapabilities();
    ensureWorkspace(scope);
    const messageId = crypto.randomUUID();
    useAssistantStore.setState((state) => ({
      streams: { ...state.streams, [id]: { messageId, text: '' } },
    }));
    let accepting = true;
    let reply;
    try {
      reply = await assistantReply(session, capabilities, (event) => {
        if (!accepting || workspace() !== scope) return;
        useAssistantStore.setState((state) => {
          const stream = state.streams[id];
          if (stream?.messageId !== messageId) return state;
          return {
            streams: {
              ...state.streams,
              [id]: {
                messageId,
                text:
                  event.type === 'text_replace'
                    ? event.text
                    : stream.text + event.text,
              },
            },
          };
        });
      });
    } finally {
      accepting = false;
    }

    ensureWorkspace(scope);
    session = {
      ...session,
      messages: [
        ...session.messages,
        {
          id: messageId,
          role: 'assistant',
          text: reply.text,
          content: reply.content,
        },
      ],
      status: reply.call ? 'thinking' : 'idle',
      error: undefined,
    };
    if (!reply.call) {
      await commit(session, scope);
      return;
    }
    // Bind the call to the exact document that will be executed and stored in
    // native history, rather than executing an unvalidated model-authored graph.
    const workflow = await resolveAssistantWorkflow(
      reply.call.workflowId,
      capabilities,
    );
    session = {
      ...session,
      activeCall: { ...reply.call, workflow },
      steps: session.steps + 1,
    };
    await commit(session, scope);
    try {
      if (!(await launchWorkflow(id, scope, reply.call.input))) return;
    } catch (error) {
      // A run ID means dispatch may have happened: never turn an uncertain
      // create response into an automatic retry or a second tool execution.
      if (latest(id).activeCall?.runId) throw error;
      await commit(
        appendToolResult(
          latest(id),
          { status: 'failed', error: String(error) },
          'failed',
        ),
        scope,
      );
    }
  }
}

export async function sendAssistantMessage(
  id: string,
  text: string,
  scope: string,
  attachments: unknown[] = [],
) {
  await guarded(id, scope, async () => {
    const session = latest(id);
    if (session.activeCall || !['idle', 'error'].includes(session.status))
      return;
    if (!text.trim() && !attachments.length) return;
    const message: AssistantMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text,
      artifacts: artifactReferences(attachments),
      content: {
        role: 'user',
        parts: [
          {
            text: attachments.length
              ? `${text}\n\nAttached file references (use these exact objects for file inputs):\n${JSON.stringify(attachments)}`
              : text,
          },
        ],
      },
    };
    await commit(
      {
        ...session,
        messages: [...session.messages, message],
        status: 'thinking',
        error: undefined,
        steps: 0,
      },
      scope,
    );
    await driveAssistant(id, scope);
  });
}

export async function provideAssistantInputs(
  id: string,
  input: Record<string, unknown>,
  scope: string,
) {
  await guarded(id, scope, async () => {
    if (latest(id).status !== 'needs_input') return;
    if (await launchWorkflow(id, scope, input)) await driveAssistant(id, scope);
  });
}

export async function resumeAssistant(id: string, scope: string) {
  await guarded(id, scope, async () => {
    const session = latest(id);
    if (session.activeCall?.runId) {
      await commit({ ...session, status: 'running', error: undefined }, scope);
      await waitForWorkflow(id, scope);
    } else if (session.activeCall) {
      await commit(
        { ...session, status: 'needs_input', error: undefined },
        scope,
      );
      return;
    } else
      await commit({ ...session, status: 'thinking', error: undefined }, scope);
    await driveAssistant(id, scope);
  });
}

export async function declineAssistantWorkflow(id: string, scope: string) {
  await guarded(id, scope, async () => {
    if (latest(id).status !== 'needs_input') return;
    await commit(
      appendToolResult(
        latest(id),
        { status: 'cancelled', reason: 'User cancelled parameter collection.' },
        'cancelled',
      ),
      scope,
    );
    await driveAssistant(id, scope);
  });
}

export async function setAssistantFeedback(
  id: string,
  messageId: string,
  value: 'helpful' | 'unhelpful',
  scope: string,
) {
  if (locks.has(id)) return;
  locks.add(id);
  try {
    ensureWorkspace(scope);
    const session = latest(id);
    // Feedback is local metadata. Storage failures must not turn a completed
    // response into a failed turn whose retry could dispatch work again.
    if (!['idle', 'error'].includes(session.status)) return;
    const messages = session.messages.map((message) =>
      message.id === messageId && message.role === 'assistant'
        ? {
            ...message,
            feedback: message.feedback === value ? undefined : value,
          }
        : message,
    );
    await commit({ ...session, messages }, scope);
  } finally {
    locks.delete(id);
  }
}
