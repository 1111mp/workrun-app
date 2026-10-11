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
  resolution?: Record<string, unknown> | null;
  resolvedAt?: string | null;
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
  triggerType?: string;
  releaseId?: string;
  releaseVersion?: string;
  appVersion?: string;
  modelTokens?: number | null;
  modelEstimatedCostMicrousd?: number | null;
};

export type RunEvent = {
  sequence: number;
  event: unknown;
  createdAt: string;
};

export type RunSpan = {
  id: string;
  kind: 'workflow_node' | 'agent' | 'model_call' | 'tool_call';
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  nodeId?: string;
  nodeName?: string;
  provider?: string;
  model?: string;
  toolName?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  totalTokensEstimated: boolean;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  estimatedCostMicrousd?: number;
  isByok?: boolean;
};

export type RunHistoryCursor = {
  id: string;
  startedAt: string;
};

export type RunHistoryPage = {
  items: RunRecordSummary[];
  nextCursor?: RunHistoryCursor;
};

export type RunHistoryMode = 'task' | 'chat';

export type RunHistoryTimelineCursor = {
  id: string;
  kind: RunHistoryMode;
  activityAt: string;
};

export type RunHistoryTimelineItem = {
  kind: RunHistoryMode;
  id: string;
  targetType: RunTargetType;
  targetId: string;
  targetName: string;
  status: RunStatus;
  activityAt: string;
  endedAt?: string;
  durationMs?: number;
  error?: string;
  triggerType?: string;
  releaseVersion?: string;
  turnCount?: number;
  latestMessage?: string;
};

export type RunHistoryTimelinePage = {
  items: RunHistoryTimelineItem[];
  nextCursor?: RunHistoryTimelineCursor;
  totalCount: number;
  completedCount: number;
};

export type MetricSummary = {
  count: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  successRate?: number;
  averageDurationMs?: number;
  p50DurationMs?: number;
  p95DurationMs?: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  estimatedCostMicrousd: number;
};

export type VersionMetricSummary = MetricSummary & {
  releaseVersion: string;
};

export type SpanMetricSummary = MetricSummary & {
  kind: RunSpan['kind'];
  nodeId?: string;
  provider?: string;
  model?: string;
  toolName?: string;
};

export type RunObservability = {
  overall: MetricSummary;
  versions: VersionMetricSummary[];
  spans: SpanMetricSummary[];
};

export type ExecutionHistory = {
  compensation?: {
    status: 'pending' | 'running' | 'completed' | 'blocked';
    automatic?: boolean;
    requestedAt: string;
    lastError?: string | null;
    completed: number;
    total: number;
  } | null;
  attempts: {
    sequence: number;
    status: string;
    startedAt: string;
    endedAt?: string;
    error?: string;
  }[];
  operations: {
    id: string;
    path: string;
    adapter: string;
    status: string;
    purpose?: 'execution' | 'compensation';
    dispatched?: boolean;
    confirmedNoEffect?: boolean;
    review?: {
      decision: 'completed' | 'no_effect';
      attemptSequence: number;
      createdAt: string;
    } | null;
    approval?: {
      id: string;
      status: 'pending' | 'granted' | 'denied' | 'consumed';
      targetName: string;
      arguments: unknown;
      createdAt: string;
    } | null;
    compensation?: {
      id: string;
      mode:
        | 'unspecified'
        | 'read_only'
        | 'compensatable'
        | 'irreversible'
        | 'delegated';
      status:
        | 'not_requested'
        | 'pending'
        | 'running'
        | 'succeeded'
        | 'failed'
        | 'blocked';
      provenance: 'before_dispatch' | 'after_dispatch';
      outcomeRecorded: boolean;
      argumentsAvailable: boolean;
      lastError?: string | null;
    } | null;
    attempts: {
      sequence: number;
      action: string;
      status: string;
      startedAt: string;
      endedAt?: string;
      errorSummary?: string;
    }[];
  }[];
  recovery?: {
    status: string;
    attempts: number;
    nextCheckAt: string;
    lastError?: string;
  };
};

export type RunRecord = RunRecordSummary & {
  input?: Record<string, unknown>;
  outputView: unknown;
  targetSnapshot: unknown;
  runtime: unknown;
  events: RunEvent[];
  spans: RunSpan[];
  executionHistory?: ExecutionHistory;
};

export type MissingReplayDependency = {
  remoteAppId: string;
  releaseId: string;
  version: string;
  archiveSha256: string;
  installationScope: string;
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

export function listRunHistoryTimelinePage(
  query: {
    targetType?: RunTargetType;
    targetId?: string;
    status?: RunStatus;
    query?: string;
    mode?: RunHistoryMode;
    pageSize?: number;
    cursor?: RunHistoryTimelineCursor;
  } = {},
) {
  return invoke<RunHistoryTimelinePage>('run_history_list_timeline', {
    query,
  });
}

export function inspectRunRecord(id: string) {
  return invoke<RunRecord>('run_history_inspect', { id });
}

export function getWorkflowObservability(query: {
  workflowId: string;
  releaseVersion?: string;
  startedAfter?: string;
  startedBefore?: string;
}) {
  return invoke<RunObservability>('run_history_observability', { query });
}

export function replayRun(sourceRunId: string) {
  return invoke<RunRecordSummary>('run_replay', { sourceRunId });
}

export function getReplayMissingDependencies(sourceRunId: string) {
  return invoke<MissingReplayDependency[]>('run_replay_missing_dependencies', {
    sourceRunId,
  });
}

export function listActiveRuns() {
  return invoke<RunRecordSummary[]>('run_history_list_active');
}

export function listPendingActions(runId?: string) {
  return invoke<PendingAction[]>('run_history_list_pending_actions', { runId });
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

export type OperationReviewDecision =
  | { kind: 'completed'; result: unknown }
  | { kind: 'no_effect' };
export function reviewWorkflowOperation(request: {
  runId: string;
  operationId: string;
  expectedAttempt: number;
  stoppedConfirmed: boolean;
  evidence: string;
  decision: OperationReviewDecision;
}) {
  return invoke<void>('workflow_operation_review', { request });
}
