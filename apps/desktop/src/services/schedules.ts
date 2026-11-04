import { Channel, invoke } from '@tauri-apps/api/core';

import { createTeamAuthClient } from '@/lib/auth-client';
import type { ScheduleTiming } from '@/lib/schedule-time';
import { useWorkrunStore } from '@/stores';

import type { AssistantReasoning } from './assistant';

export type ScheduledTask = ScheduleTiming & {
  id: string;
  name: string;
  targetType: 'app' | 'workflow';
  targetId: string;
  targetName: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastError?: string | null;
  version: string;
  source?: {
    kind: 'latest_local' | 'latest_published' | 'published_release';
    releaseVersion?: string;
  } | null;
  input?: Record<string, unknown> | null;
  occurrences?: ScheduleOccurrence[];
};

export type ScheduleOccurrence = {
  id: string;
  scheduledFor: string;
  status: string;
  runId?: string | null;
  reason?: string | null;
  error?: string | null;
};

export type ScheduleChange = {
  operation: 'create' | 'update' | 'pause' | 'resume' | 'delete';
  id?: string;
  version?: string;
  name?: string;
  cronExpression?: string;
  scheduleKind?: 'recurring' | 'once';
  runAt?: string | null;
  timezone?: string;
  input?: Record<string, unknown>;
};

export type ScheduleProposal = {
  id: string;
  operation: ScheduleChange['operation'];
  status: 'waiting' | 'saved' | 'cancelled' | 'superseded';
  before: ScheduledTask | null;
  after: ScheduledTask;
  messageIndex?: number;
};

export type ScheduleQuestion = { title: string; options?: string[] };

export type SchedulingModelSelection = {
  modelId: string;
  reasoningEffort?: ReasoningEffort | null;
};

export type SchedulingSession = {
  id: string;
  revision?: number;
  title: string;
  scheduleId?: string | null;
  modelId?: string;
  reasoningEffort?: ReasoningEffort | null;
  messages: {
    id: string;
    role: 'user' | 'assistant';
    text: string;
    reasoning?: AssistantReasoning[];
    proposalId?: string;
  }[];
  proposals: ScheduleProposal[];
  pending?: string | null;
  questions: ScheduleQuestion[];
  status: 'idle' | 'running' | 'interrupted';
  error?: string | null;
};

export type SchedulingSessionSummary = Pick<
  SchedulingSession,
  'id' | 'title' | 'scheduleId'
> & { scheduleIds?: string[] };

export type SchedulingStream = {
  type:
    | 'text_delta'
    | 'text_replace'
    | 'activity'
    | 'reasoning'
    | 'phase_start'
    | 'phase_end'
    | 'tool_start';
  text?: string;
  summary?: string;
  phaseId?: string;
  kind?: 'activity' | 'answer';
  name?: string;
  id?: string;
  durationMs?: number;
  complete?: boolean;
};

export async function replySchedulingReceipt(
  sessionId: string,
  receive: (event: SchedulingStream) => void,
) {
  const channel = new Channel<SchedulingStream>();
  channel.onmessage = receive;
  return invoke<SchedulingSession>('schedule_agent_reply_receipt', {
    sessionId,
    channel,
  });
}

async function token() {
  const config = useWorkrunStore.getState().config;
  if (config?.workspace_mode !== 'team') return;
  const server = config.team?.server_url;
  if (!server) throw new Error('Team server URL is not configured.');
  const session = await createTeamAuthClient(server).getSession();
  if (!session.data?.session.token)
    throw new Error('Sign in to access Team workflows.');
  return session.data.session.token;
}

export const listSchedules = () => invoke<ScheduledTask[]>('schedule_list');

export const getSchedule = (id: string) =>
  invoke<ScheduledTask>('schedule_detail', { id });

/** Detail-dialog actions never invoke the scheduling assistant or alter its history. */
export async function changeScheduledTask(
  change: ScheduleChange,
): Promise<ScheduledTask | null> {
  if (change.operation === 'delete') {
    await invoke('schedule_delete', { id: change.id });
    return null;
  }
  if (change.operation === 'pause' || change.operation === 'resume') {
    await invoke('schedule_set_enabled', {
      id: change.id,
      enabled: change.operation === 'resume',
    });
    return getSchedule(change.id!);
  }
  if (change.operation !== 'update') throw new Error('Unsupported task action');
  return invoke<ScheduledTask>('schedule_update', {
    change,
    teamToken: await token(),
  });
}

export const listSchedulingSessions = () =>
  invoke<SchedulingSessionSummary[]>('schedule_agent_list');

export const getSchedulingSession = (id: string) =>
  invoke<SchedulingSession>('schedule_agent_get', { id });

export const createSchedulingSession = (
  scheduleId?: string,
  selection?: SchedulingModelSelection,
) =>
  invoke<SchedulingSession>('schedule_agent_create', { scheduleId, selection });

export const setSchedulingModel = (
  sessionId: string,
  selection: SchedulingModelSelection,
) =>
  invoke<SchedulingSession>('schedule_agent_set_model', {
    sessionId,
    selection,
  });

export const deleteSchedulingSession = (id: string) =>
  invoke<void>('schedule_agent_delete', { id });

export const stopSchedulingResponse = (id: string) =>
  invoke<void>('schedule_agent_stop', { id });

export async function sendSchedulingMessage(
  sessionId: string,
  modelId: string,
  text: string,
  onStream: (event: SchedulingStream) => void,
  reasoningEffort?: ReasoningEffort,
) {
  const channel = new Channel<SchedulingStream>();
  channel.onmessage = onStream;
  return invoke<SchedulingSession>('schedule_agent_turn', {
    request: {
      sessionId,
      modelId,
      reasoningEffort,
      text,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      teamToken: await token(),
    },
    channel,
  });
}

export async function proposeScheduleChange(
  sessionId: string,
  args: ScheduleChange,
) {
  return invoke<SchedulingSession>('schedule_agent_propose', {
    sessionId,
    args,
    teamToken: await token(),
  });
}

export async function decideScheduleChange(
  sessionId: string,
  proposalId: string,
  approve: boolean,
) {
  return invoke<SchedulingSession>('schedule_agent_decide', {
    sessionId,
    proposalId,
    approve,
    teamToken: approve ? await token() : undefined,
  });
}
