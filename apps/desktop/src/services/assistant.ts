import { invoke } from '@tauri-apps/api/core';

import type { ArtifactRef } from '@/services/artifact';
import type { StoredWorkflow } from '@/services/workflow';

export type ModelContent = { role: string; parts: unknown[] };
export type WorkflowCall = {
  workflowId: string;
  input: Record<string, unknown>;
  toolName: string;
  callId?: string;
};
export type AssistantMessage = {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  content: ModelContent;
  runId?: string;
  workflowName?: string;
  artifacts?: ArtifactRef[];
  feedback?: 'helpful' | 'unhelpful';
};
export type ActiveWorkflowCall = WorkflowCall & {
  workflow: StoredWorkflow;
  runId?: string;
};
export type AssistantActivity = {
  id: string;
  turnId: string;
  phaseId?: string;
  summary: string;
};
export type AssistantReasoning = {
  id: string;
  turnId: string;
  phaseId: string;
  text: string;
  durationMs: number;
  complete: boolean;
};
export type AssistantSession = {
  reasoning?: AssistantReasoning[];
  activities?: AssistantActivity[];
  responsePhaseId?: string;
  id: string;
  title: string;
  modelId: string;
  messages: AssistantMessage[];
  status: 'idle' | 'thinking' | 'running' | 'needs_input' | 'error';
  activeCall?: ActiveWorkflowCall;
  error?: string;
  steps: number;
};
export type AssistantSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
};
export const listAssistantSessions = () =>
  invoke<AssistantSessionSummary[]>('assistant_session_list');
export const getAssistantSession = (id: string) =>
  invoke<AssistantSession>('assistant_session_get', { id });
export const saveAssistantSession = (session: AssistantSession) =>
  invoke('assistant_session_save', { session });

export type AssistantTurnAction =
  | { kind: 'send'; text: string; attachments: unknown[] }
  | { kind: 'continue' }
  | { kind: 'inputs'; input: Record<string, unknown> }
  | { kind: 'decline' };

export const startAssistantTurn = (
  sessionId: string,
  action: AssistantTurnAction,
  teamToken?: string,
) =>
  invoke<AssistantSession>('assistant_turn_start', {
    request: { sessionId, action, teamToken },
  });

export const deleteAssistantSession = (id: string) =>
  invoke<void>('assistant_session_delete', { id });
