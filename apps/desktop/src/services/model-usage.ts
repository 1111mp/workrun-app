import { invoke } from '@tauri-apps/api/core';

export type UsageTotals = {
  calls: number;
  missingUsageCalls: number;
  unfinishedCalls: number;
  estimatedCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
};
export type ModelCall = {
  id: string;
  model: string;
  startedAt: string;
  status: string;
  responseKind?: 'content' | 'tool_call';
  requestedTools?: string[];
  finishReason?: unknown;
  requestSize?: {
    contentsChars: number;
    toolsChars: number;
    messages: number;
    toolResponseChars: number;
    largestToolResults?: { name: string; responses: number; chars: number }[];
    toolResultKinds?: number;
  };
  context: {
    purpose: string;
    turnId?: string;
    nodeId?: string;
    runId?: string;
  };
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    totalTokensEstimated?: boolean;
  } | null;
};
export type SessionUsage = {
  recordingDegraded?: boolean;
  conversation: UsageTotals;
  execution: UsageTotals;
  calls: ModelCall[];
  byTurn?: {
    turnId: string | null;
    calls: number;
    conversationTokens: number;
    executionTokens: number;
    startedAt: string;
    endedAt: string | null;
    modelDurationMs: number;
    missingUsageCalls: number;
    unfinishedCalls: number;
  }[];
  byPurpose: {
    purpose: string;
    calls: number;
    totalTokens: number;
    missingUsageCalls: number;
  }[];
};
export const getSessionUsage = (
  kind: 'assistant' | 'workflow_chat',
  id: string,
) => invoke<SessionUsage>('model_usage_session', { kind, id });
