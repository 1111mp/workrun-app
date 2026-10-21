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
  notice?: 'plan_confirmation_required';
  id: string;
  role: 'user' | 'assistant' | 'tool';
  text: string;
  content: ModelContent;
  runId?: string;
  workflowName?: string;
  toolName?: string;
  toolOperationId?: string;
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
export type AssistantInteraction = {
  id: string;
  taskId: string;
  threadId: string;
  checkpointId: string;
  kind: 'plan_confirmation' | 'clarification' | 'tool_confirmation';
  version: number;
  status:
    | 'waiting'
    | 'creating'
    | 'executing'
    | 'completed'
    | 'unknown'
    | 'saved'
    | 'failed'
    | 'cancelled';
};
export type AssistantToolConfirmation = {
  id: string;
  turnId: string;
  turnKey: string;
  tool: { id: string; displayName: string; name?: string };
  arguments: unknown;
  interaction: AssistantInteraction;
};
export type WorkflowPlan = {
  interaction?: AssistantInteraction | null;
  id: string;
  sessionId: string;
  version: number;
  status:
    | 'ready'
    | 'needs_clarification'
    | 'approved'
    | 'building'
    | 'saved'
    | 'failed'
    | 'cancelled';
  dependencyIssues: string[];
  workflowId?: string | null;
  outcome?: { summary?: string; status?: string } | null;
  document: {
    goal: string;
    summary: string;
    target_id?: string | null;
    inputs: {
      name: string;
      description: string;
      artifact_id?: string | null;
    }[];
    outputs: string[];
    steps: {
      title: string;
      description: string;
      node_types: string[];
      configuration_notes: string;
      dependencies: { kind: string; id: string; purpose: string }[];
    }[];
    constraints: string[];
    assumptions: string[];
    questions: string[];
    acceptance_criteria: string[];
  };
};
export type AssistantSession = {
  pendingTool?: AssistantToolConfirmation | null;
  toolConfirmations?: AssistantToolConfirmation[];
  workflowPlan?: WorkflowPlan | null;
  workflowPlans?: { turnId: string; plan: WorkflowPlan }[];
  reasoning?: AssistantReasoning[];
  activities?: AssistantActivity[];
  responsePhaseId?: string;
  id: string;
  title: string;
  modelId: string;
  messages: AssistantMessage[];
  status:
    | 'idle'
    | 'thinking'
    | 'running'
    | 'needs_input'
    | 'awaiting_feedback'
    | 'error';
  activeCall?: ActiveWorkflowCall;
  error?: string;
  steps: number;
};
export type AssistantSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
};
export const saveAssistantSession = (session: AssistantSession) =>
  invoke('assistant_session_save', { session });

export type AssistantTurnAction =
  | { kind: 'send'; text: string; attachments: unknown[] }
  | {
      kind: 'planDecision';
      interaction_id?: string;
      checkpoint_id?: string;
      plan_id: string;
      version: number;
      decision: 'approve' | 'cancel';
      text: string;
    }
  | {
      kind: 'toolDecision';
      operation_id: string;
      interaction_id: string;
      checkpoint_id: string;
      decision: 'approve' | 'deny';
      text: string;
    }
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

export const stopAssistantTurn = (id: string) =>
  invoke<AssistantSession>('assistant_turn_stop', { id });

export type AssistantStream = { messageId: string; text: string };
export type AssistantSnapshot = {
  session: AssistantSession;
  stream: AssistantStream | null;
};
export type AssistantStreamUpdate = {
  sessionId: string;
  messageId: string;
  turnId?: string;
  activity?: AssistantActivity;
  reasoning?: AssistantReasoning;
  event:
    | { type: 'text_delta' | 'text_replace'; text: string }
    | { type: 'activity'; summary: string }
    | { type: 'workflow_plan'; plan: WorkflowPlan }
    | {
        type: 'reasoning';
        id: string;
        text: string;
        durationMs: number;
        complete: boolean;
      };
};
export type AssistantEvent = {
  workspaceId: string;
  sessionId: string;
  epoch: string;
  sequence: number;
} & (
  | { type: 'snapshot'; payload: AssistantSnapshot }
  | { type: 'stream'; payload: AssistantStreamUpdate }
  | { type: 'list'; payload: AssistantSessionSummary[] }
  | { type: 'summary'; payload: AssistantSessionSummary | null }
);

// One-time reads used when opening a conversation or restoring the window.
export const getAssistantSnapshot = (id: string) =>
  invoke<AssistantEvent>('assistant_session_get', { id });
export const getAssistantListSnapshot = () =>
  invoke<AssistantEvent>('assistant_session_list');
