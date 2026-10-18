import { listen } from '@tauri-apps/api/event';
import { create } from 'zustand';

import { createTeamAuthClient } from '@/lib/auth-client';
import {
  getAssistantSession,
  saveAssistantSession,
  startAssistantTurn,
  type AssistantSession,
  type AssistantActivity,
  type AssistantReasoning,
  type AssistantTurnAction,
} from '@/services/assistant';
import { useWorkrunStore } from '@/stores/workrun.store';

export const useAssistantStore = create<{
  sessions: Record<string, AssistantSession>;
  scopes: Record<string, string>;
  streams: Record<string, { messageId: string; text: string }>;
}>(() => ({ sessions: {}, scopes: {}, streams: {} }));
const observers = new Map<string, Promise<void>>();
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
    // Polling snapshots may predate a live progress event. Preserve it until
    // the native phase commits the same ID to durable history.
    const activities = new Map(
      (session.activities ?? []).map((item) => [item.id, item]),
    );
    if (state.scopes[session.id] === scope)
      for (const item of state.sessions[session.id]?.activities ?? [])
        activities.set(item.id, item);
    const reasoning = new Map(
      (session.reasoning ?? []).map((item) => [item.id, item]),
    );
    if (state.scopes[session.id] === scope)
      for (const item of state.sessions[session.id]?.reasoning ?? []) {
        // Durable snapshots win once committed; live records fill polling gaps.
        if (!reasoning.has(item.id)) reasoning.set(item.id, item);
      }
    session = {
      ...session,
      activities: [...activities.values()],
      reasoning: [...reasoning.values()],
    };
    const streams = { ...state.streams };
    const stream = streams[session.id];
    if (
      stream &&
      (session.messages.some((message) => message.id === stream.messageId) ||
        !['thinking', 'running'].includes(session.status))
    )
      delete streams[session.id];
    return {
      sessions: { ...state.sessions, [session.id]: session },
      scopes: { ...state.scopes, [session.id]: scope },
      streams,
    };
  });
}
function latest(id: string) {
  const session = useAssistantStore.getState().sessions[id];
  if (!session) throw new Error('Conversation is not loaded.');
  return session;
}
async function teamToken() {
  const config = useWorkrunStore.getState().config;
  if (config?.workspace_mode !== 'team') return;
  const server = config.team?.server_url;
  if (!server) throw new Error('Team server URL is not configured.');
  const session = await createTeamAuthClient(server).getSession();
  if (!session.data?.session.token)
    throw new Error('Sign in to access Team workflows.');
  return session.data.session.token;
}

// Observation never calls a model or dispatches a workflow. Native ownership
// continues when this loop, the renderer, or the stream listener disappears.
function observe(id: string, scope: string): Promise<void> {
  const key = `${scope}/${id}`;
  const existing = observers.get(key);
  if (existing) return existing;
  const task = (async () => {
    const unlisten = await listen<{
      sessionId: string;
      messageId: string;
      activity?: AssistantActivity;
      reasoning?: AssistantReasoning;
      event:
        | { type: 'text_delta' | 'text_replace'; text: string }
        | { type: 'activity'; summary: string }
        | {
            type: 'reasoning';
            id: string;
            text: string;
            durationMs: number;
            complete: boolean;
          };
    }>('assistant-stream', ({ payload }) => {
      const state = useAssistantStore.getState();
      if (
        workspace() !== scope ||
        payload.sessionId !== id ||
        state.scopes[id] !== scope
      )
        return;
      if (payload.event.type === 'reasoning') {
        const thought = payload.reasoning;
        const session = state.sessions[id];
        if (thought && session)
          useAssistantStore.setState({
            sessions: {
              ...state.sessions,
              [id]: {
                ...session,
                reasoning: [
                  ...(session.reasoning ?? []).filter(
                    (item) => item.id !== thought.id,
                  ),
                  thought,
                ],
              },
            },
          });
        return;
      }
      if (payload.event.type === 'activity') {
        const activity = payload.activity;
        const session = state.sessions[id];
        if (
          activity &&
          session &&
          !session.activities?.some((item) => item.id === activity.id)
        )
          useAssistantStore.setState({
            sessions: {
              ...state.sessions,
              [id]: {
                ...session,
                activities: [...(session.activities ?? []), activity],
              },
            },
          });
        return;
      }
      const event = payload.event;
      if (
        state.sessions[id]?.messages.some(
          (message) => message.id === payload.messageId,
        )
      )
        return;
      useAssistantStore.setState((state) => {
        const stream = state.streams[id];
        return {
          streams: {
            ...state.streams,
            [id]: {
              messageId: payload.messageId,
              text:
                event.type === 'text_replace'
                  ? event.text
                  : (stream?.messageId === payload.messageId
                      ? stream.text
                      : '') + event.text,
            },
          },
        };
      });
    }).catch(() => () => {});
    try {
      while (
        workspace() === scope &&
        useAssistantStore.getState().scopes[id] === scope
      ) {
        const session = await getAssistantSession(id);
        ensureWorkspace(scope);
        if (useAssistantStore.getState().scopes[id] !== scope) return;
        publish(session, scope);
        if (!['thinking', 'running'].includes(session.status)) return;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      unlisten();
    }
  })().finally(() => observers.delete(key));
  observers.set(key, task);
  return task;
}

export async function createAssistantSession(
  modelId: string,
  title: string,
  scope: string,
) {
  ensureWorkspace(scope);
  const session: AssistantSession = {
    id: crypto.randomUUID(),
    title: title.slice(0, 72),
    modelId,
    messages: [],
    status: 'idle',
    steps: 0,
  };
  await saveAssistantSession(session);
  ensureWorkspace(scope);
  publish(session, scope);
  return session;
}
export async function loadAssistantSession(id: string, scope: string) {
  ensureWorkspace(scope);
  const session = await getAssistantSession(id);
  ensureWorkspace(scope);
  publish(session, scope);
  if (['thinking', 'running'].includes(session.status))
    void observe(id, scope).catch(() => {});
  return session;
}
async function act(id: string, scope: string, action: AssistantTurnAction) {
  if (locks.has(id)) return;
  locks.add(id);
  let ownsLock = true;
  try {
    ensureWorkspace(scope);
    const token = await teamToken();
    ensureWorkspace(scope);
    const session = await startAssistantTurn(id, action, token);
    ensureWorkspace(scope);
    publish(session, scope);
    // Native ownership now guards the turn. Release the submission guard before
    // observation publishes a terminal state and enables the next user action.
    locks.delete(id);
    ownsLock = false;
    await observe(id, scope);
  } catch (error) {
    if (workspace() === scope && useAssistantStore.getState().sessions[id]) {
      // An uncertain IPC response never authorizes a retry. Prefer the native
      // state; a running task remains running despite a transport failure.
      const session = await getAssistantSession(id).catch(() => undefined);
      if (session && ['thinking', 'running'].includes(session.status)) {
        publish(session, scope);
        void observe(id, scope).catch(() => {});
      } else
        publish(
          { ...(session ?? latest(id)), status: 'error', error: String(error) },
          scope,
        );
    }
  } finally {
    if (ownsLock) locks.delete(id);
  }
}
export async function sendAssistantMessage(
  id: string,
  text: string,
  scope: string,
  attachments: unknown[] = [],
) {
  const session = latest(id);
  if (
    session.activeCall ||
    !['idle', 'error'].includes(session.status) ||
    (!text.trim() && !attachments.length)
  )
    return;
  await act(id, scope, { kind: 'send', text, attachments });
}
export async function provideAssistantInputs(
  id: string,
  input: Record<string, unknown>,
  scope: string,
) {
  if (latest(id).status === 'needs_input')
    await act(id, scope, { kind: 'inputs', input });
}
export async function resumeAssistant(id: string, scope: string) {
  await act(id, scope, { kind: 'continue' });
}
export async function declineAssistantWorkflow(id: string, scope: string) {
  if (latest(id).status === 'needs_input')
    await act(id, scope, { kind: 'decline' });
}
export async function setAssistantFeedback(
  id: string,
  messageId: string,
  value: 'helpful' | 'unhelpful',
  scope: string,
) {
  ensureWorkspace(scope);
  const session = latest(id);
  if (!['idle', 'error'].includes(session.status)) return;
  const updated = {
    ...session,
    messages: session.messages.map((message) =>
      message.id === messageId && message.role === 'assistant'
        ? {
            ...message,
            feedback: message.feedback === value ? undefined : value,
          }
        : message,
    ),
  };
  await saveAssistantSession(updated);
  ensureWorkspace(scope);
  publish(updated, scope);
}
