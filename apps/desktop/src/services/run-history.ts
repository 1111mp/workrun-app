import { invoke } from '@tauri-apps/api/core';

export type RunTargetType = 'workflow' | 'app';
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export type RunRecordSummary = {
  id: string;
  targetType: RunTargetType;
  targetId: string;
  targetName: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
};

export type RunEvent = {
  sequence: number;
  event: unknown;
  createdAt: string;
};

export type RunHistoryCursor = {
  id: string;
  startedAt: string;
};

export type RunHistoryPage = {
  items: RunRecordSummary[];
  nextCursor?: RunHistoryCursor;
};

export type RunRecord = RunRecordSummary & {
  input?: Record<string, unknown>;
  outputView: unknown;
  targetSnapshot: unknown;
  events: RunEvent[];
};

export type CreateRunRecord = {
  id: string;
  targetType: RunTargetType;
  targetId: string;
  targetName: string;
  status: RunStatus;
  startedAt: string;
  input?: Record<string, unknown>;
  outputView: unknown;
  targetSnapshot: unknown;
};

export function createRunRecord(record: CreateRunRecord) {
  return invoke('run_history_create', { record });
}

export function appendRunEvents(id: string, events: RunEvent[]) {
  if (events.length === 0) return Promise.resolve();
  return invoke('run_history_append_events', { id, request: { events } });
}

export function finalizeRunRecord(
  id: string,
  record: {
    status: Exclude<RunStatus, 'running'>;
    endedAt: string;
    durationMs: number;
    outputView: unknown;
    error?: string;
  },
) {
  return invoke('run_history_finalize', { id, record });
}

export function listRunHistoryPage(
  query: {
    targetType?: RunTargetType;
    targetId?: string;
    status?: RunStatus;
    query?: string;
    pageSize?: number;
    cursor?: RunHistoryCursor;
  } = {},
) {
  return invoke<RunHistoryPage>('run_history_list', { query });
}

export function inspectRunRecord(id: string) {
  return invoke<RunRecord>('run_history_inspect', { id });
}
