import { listen } from '@tauri-apps/api/event';

import { createTeamAuthClient } from '@/lib/auth-client';
import {
  startAssistantTurn,
  getAssistantSnapshot,
  getAssistantHistory,
  getAssistantListSnapshot,
  type AssistantEvent,
  type AssistantSession,
  type AssistantSessionSummary,
  type AssistantStreamUpdate,
  type AssistantSnapshot,
  type AssistantTurnAction,
} from '@/services/assistant';
import { useAssistantStore } from '@/stores/assistant.store';
import { useWorkrunStore } from '@/stores/workrun.store';

// Runtime resources are shared for the application, independent of Store creation.
let listener: Promise<() => void> | undefined;
let context: { scope: string; workspaceId: string; epoch: string } | undefined;
let bootstrap: { scope: string; events: AssistantEvent[] } | undefined;
let listLoad:
  | { scope: string; promise: Promise<AssistantSessionSummary[]> }
  | undefined;
const versions = new Map<string, { epoch: string; sequence: number }>();
const pendingReads = new Map<string, AssistantEvent[]>();
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
export function ensureWorkspace(scope: string) {
  if (workspace() !== scope)
    throw new Error(
      'Workspace changed. Reopen this conversation in its workspace.',
    );
}
const itemFields = [
  'workflowPlans',
  'workflowConfirmations',
  'toolConfirmations',
  'reasoning',
  'activities',
] as const;
function mergeHistory(
  previous: AssistantSession,
  incoming: AssistantSession,
  prepend = false,
): AssistantSession {
  const merge = <T>(older: T[], newer: T[], key: (value: T) => string) => {
    const result = new Map(older.map((value) => [key(value), value]));
    for (const value of newer) result.set(key(value), value);
    return [...result.values()];
  };
  const result = { ...incoming };
  result.messages = prepend
    ? merge(incoming.messages, previous.messages, (message) => message.id)
    : merge(previous.messages, incoming.messages, (message) => message.id);
  for (const field of itemFields) {
    const key = (value: unknown) => {
      const item = value as {
        id?: string;
        turnId?: string;
        plan?: { id: string; version: number };
      };
      return field === 'workflowPlans'
        ? JSON.stringify([item.turnId, item.plan?.id, item.plan?.version])
        : item.id!;
    };
    // Item unions stay field-specific at the public API boundary.
    (result as unknown as Record<string, unknown>)[field] = prepend
      ? merge<unknown>(incoming[field] ?? [], previous[field] ?? [], key)
      : merge<unknown>(previous[field] ?? [], incoming[field] ?? [], key);
  }
  if (
    !prepend &&
    previous.history &&
    incoming.history &&
    previous.history.beforeSequence !== null &&
    (incoming.history.beforeSequence === null ||
      previous.history.beforeSequence < incoming.history.beforeSequence)
  ) {
    result.history = previous.history;
  }
  return result;
}

export async function loadAssistantHistory(id: string, scope: string) {
  ensureWorkspace(scope);
  const current = latest(id);
  const before = current.history?.beforeSequence;
  if (!current.history?.hasMore || before == null) return;
  const page = await getAssistantHistory(id, before);
  ensureWorkspace(scope);
  useAssistantStore.setState((state) => {
    const current = state.sessions[id];
    if (
      !current ||
      state.scopes[id] !== scope ||
      current.history?.beforeSequence !== before
    )
      return;
    const merged = mergeHistory(current, page, true);
    // Historical reads must never overwrite a newer native status or pending decision.
    state.sessions[id] = {
      ...current,
      messages: merged.messages,
      ...Object.fromEntries(itemFields.map((field) => [field, merged[field]])),
      history: page.history,
    };
  });
}

function publish({ session, stream }: AssistantSnapshot, scope: string) {
  useAssistantStore.setState((state) => {
    const previous =
      state.scopes[session.id] === scope
        ? state.sessions[session.id]
        : undefined;
    // Reconnect must not silently leave a missing page inside cached history.
    const overlaps = previous?.messages.some((message) =>
      session.messages.some((next) => next.id === message.id),
    );
    state.sessions[session.id] =
      previous &&
      session.history &&
      (previous.messages.length === 0 || overlaps)
        ? mergeHistory(previous, session)
        : session;
    state.scopes[session.id] = scope;
    if (stream) state.streams[session.id] = stream;
    else delete state.streams[session.id];
    delete state.syncErrors[session.id];
  });
}
function synchronizationFailed(id: string, scope: string, error: unknown) {
  if (workspace() !== scope) return;
  useAssistantStore.setState((state) => {
    state.syncErrors[id] = String(error);
  });
}
export function latest(id: string): AssistantSession {
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

function applyStream(
  id: string,
  scope: string,
  payload: AssistantStreamUpdate,
) {
  if (workspace() !== scope || payload.sessionId !== id) return;
  useAssistantStore.setState((state) => {
    const session = state.sessions[id];
    if (
      state.scopes[id] !== scope ||
      !session ||
      !['thinking', 'running'].includes(session.status)
    )
      return;
    const event = payload.event;
    if (event.type === 'workflow_plan') {
      session.workflowPlan = event.plan;
      if (payload.turnId) {
        session.workflowPlans ??= [];
        const index = session.workflowPlans.findIndex(
          (entry) =>
            entry.turnId === payload.turnId &&
            entry.plan.id === event.plan.id &&
            entry.plan.version === event.plan.version,
        );
        const entry = { turnId: payload.turnId, plan: event.plan };
        // Updates retain their position so older cards cannot become the latest
        // card or move beneath a newer version during streaming reconciliation.
        if (index < 0) session.workflowPlans.push(entry);
        else session.workflowPlans[index] = entry;
      }
      return;
    }
    if (event.type === 'reasoning') {
      const thought = payload.reasoning;
      if (thought) {
        session.reasoning ??= [];
        const index = session.reasoning.findIndex(
          (item) => item.id === thought.id,
        );
        // Phases are displayed in first-seen order, including late final chunks.
        if (index < 0) session.reasoning.push(thought);
        else session.reasoning[index] = thought;
      }
      return;
    }
    if (event.type === 'activity') {
      const activity = payload.activity;
      if (
        activity &&
        !session.activities?.some((item) => item.id === activity.id)
      ) {
        session.activities ??= [];
        session.activities.push(activity);
      }
      return;
    }
    if (session.messages.some((message) => message.id === payload.messageId))
      return;
    const stream = state.streams[id];
    state.streams[id] = {
      messageId: payload.messageId,
      text:
        event.type === 'text_replace'
          ? event.text
          : (stream?.messageId === payload.messageId ? stream.text : '') +
            event.text,
    };
  });
}

function applyEvent(event: AssistantEvent, scope: string) {
  const key = `${scope}/${event.type === 'list' || event.type === 'summary' ? 'list' : event.sessionId}`;
  const previous = versions.get(key);
  if (previous?.epoch === event.epoch && previous.sequence >= event.sequence)
    return;
  // A stream for unopened history has no local message to update. Opening it
  // reads Rust's current live contents rather than reconstructing old tokens.
  if (
    event.type === 'stream' &&
    useAssistantStore.getState().scopes[event.sessionId] !== scope
  )
    return;
  versions.set(key, { epoch: event.epoch, sequence: event.sequence });
  if (event.type === 'summary' && !event.payload) {
    versions.set(`${scope}/${event.sessionId}`, {
      epoch: event.epoch,
      sequence: event.sequence,
    });
    useAssistantStore.setState((state) => {
      delete state.sessions[event.sessionId];
      delete state.streams[event.sessionId];
    });
  }
  if (event.type === 'snapshot') publish(event.payload, scope);
  else if (event.type === 'stream')
    applyStream(event.sessionId, scope, event.payload);
  else
    useAssistantStore.setState((state) => {
      let entries =
        event.type === 'list'
          ? [...event.payload]
          : (state.summaries[scope] ?? []).filter(
              (entry) => entry.id !== event.sessionId,
            );
      if (event.type === 'summary' && event.payload)
        entries = [...entries, event.payload];
      state.summaries[scope] = entries
        .sort(
          (a, b) =>
            b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
        )
        .slice(0, 50);
      delete state.listErrors[scope];
    });
}
function dispatch(event: AssistantEvent, scope: string) {
  const queued = pendingReads.get(`${scope}/${event.sessionId}`);
  if (queued && (event.type === 'snapshot' || event.type === 'stream'))
    queued.push(event);
  else applyEvent(event, scope);
}

export async function ensureEvents(scope: string) {
  await useAssistantStore.getState().initializeAssistantEvents();
  ensureWorkspace(scope);
  if (context?.scope !== scope)
    await useAssistantStore.getState().loadAssistantList(scope);
}

export async function act(
  id: string,
  scope: string,
  action: AssistantTurnAction,
) {
  const key = `${scope}/${id}`;
  if (locks.has(key)) return;
  locks.add(key);
  try {
    await ensureEvents(scope);
    const token = await teamToken();
    ensureWorkspace(scope);
    // The global event listener is attached before dispatch. Native snapshots
    // are authoritative; a delayed command acknowledgment must not overwrite them.
    await startAssistantTurn(id, action, token);
    ensureWorkspace(scope);
  } catch (error) {
    if (workspace() === scope) {
      // Recover delivery once, never retry the action after an uncertain IPC reply.
      try {
        await useAssistantStore.getState().loadAssistantSession(id, scope);
      } catch {
        /* The read error is reported independently below. */
      }
      synchronizationFailed(id, scope, error);
    }
  } finally {
    locks.delete(key);
  }
}

// One application listener remains independent of the selected conversation.
export function initializeAssistantEvents(): Promise<() => void> {
  listener ??= listen<AssistantEvent>('assistant-event', ({ payload }) => {
    const scope = workspace();
    if (
      bootstrap?.scope === scope &&
      (context?.scope !== scope || payload.epoch !== context.epoch)
    ) {
      bootstrap.events.push(payload);
      return;
    }
    if (context?.scope !== scope || payload.workspaceId !== context.workspaceId)
      return;
    if (payload.epoch !== context.epoch) {
      void useAssistantStore
        .getState()
        .loadAssistantList(scope)
        .catch(() => {});
      return;
    }
    dispatch(payload, scope);
  }).catch((error) => {
    listener = undefined;
    useAssistantStore.setState((state) => {
      state.listErrors[workspace()] = String(error);
    });
    throw error;
  });
  return listener;
}
export function disposeAssistantEvents() {
  void listener?.then((stop) => stop()).catch(() => {});
  listener = undefined;
  context = undefined;
  bootstrap = undefined;
  listLoad = undefined;
  versions.clear();
  pendingReads.clear();
}
export async function loadAssistantList(
  scope: string,
): Promise<AssistantSessionSummary[]> {
  await useAssistantStore.getState().initializeAssistantEvents();
  ensureWorkspace(scope);
  if (listLoad?.scope === scope) return listLoad.promise;
  const pending = { scope, events: [] as AssistantEvent[] };
  bootstrap = pending;
  const promise = (async () => {
    const snapshot = await getAssistantListSnapshot();
    ensureWorkspace(scope);
    if (bootstrap !== pending || snapshot.type !== 'list')
      throw new Error('Workspace changed while loading conversations');
    context = {
      scope,
      workspaceId: snapshot.workspaceId,
      epoch: snapshot.epoch,
    };
    applyEvent(snapshot, scope);
    useAssistantStore.setState((state) => {
      delete state.listErrors[scope];
    });
    for (const event of pending.events) {
      if (
        event.workspaceId === context.workspaceId &&
        event.epoch === context.epoch
      )
        dispatch(event, scope);
    }
    return useAssistantStore.getState().summaries[scope] ?? [];
  })();
  listLoad = { scope, promise };
  try {
    return await promise;
  } catch (error) {
    if (workspace() === scope)
      useAssistantStore.setState((state) => {
        state.listErrors[scope] = String(error);
      });
    throw error;
  } finally {
    if (bootstrap === pending) bootstrap = undefined;
    if (listLoad?.promise === promise) listLoad = undefined;
  }
}

export async function loadAssistantSession(
  id: string,
  scope: string,
): Promise<AssistantSession> {
  await ensureEvents(scope);
  const key = `${scope}/${id}`;
  const events: AssistantEvent[] = [];
  pendingReads.set(key, events);
  try {
    const snapshot = await getAssistantSnapshot(id);
    ensureWorkspace(scope);
    if (
      snapshot.type !== 'snapshot' ||
      snapshot.sessionId !== id ||
      snapshot.workspaceId !== context?.workspaceId ||
      snapshot.epoch !== context?.epoch
    )
      throw new Error('Invalid conversation snapshot');
    applyEvent(snapshot, scope);
    for (const event of events) applyEvent(event, scope);
    useAssistantStore.setState((state) => {
      delete state.syncErrors[id];
    });
    return latest(id);
  } catch (error) {
    synchronizationFailed(id, scope, error);
    throw error;
  } finally {
    if (pendingReads.get(key) === events) pendingReads.delete(key);
  }
}

export function isAssistantActing(scope: string, id: string) {
  return locks.has(`${scope}/${id}`);
}
