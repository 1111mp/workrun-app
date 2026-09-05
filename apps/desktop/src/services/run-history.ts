import { invoke } from '@tauri-apps/api/core';

export type RunTargetType = 'workflow' | 'app';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type PendingActionKind =
  | 'tool_approval'
  | 'human_review'
  | 'ask_user_question';

export type PendingAction = {
  id: string;
  runId: string;
  kind: PendingActionKind;
  payload: unknown;
  status: 'pending' | 'resolved' | 'cancelled' | 'expired';
  createdAt: string;
};

export type CreatePendingAction = {
  id: string;
  runId: string;
  kind: PendingActionKind;
  payload: unknown;
  createdAt: string;
};

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
  runtime: unknown;
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

export function markRunRecordRunning(id: string) {
  return invoke('run_history_mark_running', { id });
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

export function listActiveRuns() {
  return invoke<RunRecordSummary[]>('run_history_list_active');
}

export function listPendingActions() {
  return invoke<PendingAction[]>('run_history_list_pending_actions');
}

export function createPendingAction(action: CreatePendingAction) {
  return invoke('run_history_create_pending_action', { action });
}

export function claimNextPendingAction(claimantId: string) {
  return invoke<PendingAction | null>('run_history_claim_next_pending_action', {
    claimantId,
  });
}

export function releasePendingAction(id: string, claimantId: string) {
  return invoke('run_history_release_pending_action', { id, claimantId });
}

export function resolvePendingAction(
  id: string,
  resolution: unknown,
  claimantId?: string,
) {
  return invoke<PendingAction>('run_history_resolve_pending_action', {
    id,
    resolution,
    claimantId,
  });
}
