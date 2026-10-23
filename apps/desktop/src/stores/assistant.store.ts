import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import {
  saveAssistantSession,
  deleteAssistantSession as deleteSession,
  stopAssistantTurn,
  type AssistantSession,
  type AssistantSessionSummary,
  type AssistantToolConfirmation,
} from '@/services/assistant';

import {
  initializeAssistantEvents,
  disposeAssistantEvents,
  loadAssistantList,
  loadAssistantSession,
  ensureWorkspace,
  ensureEvents,
  latest,
  act,
  isAssistantActing,
} from './assistant.runtime';

type AssistantState = {
  initializeAssistantEvents: () => Promise<() => void>;
  disposeAssistantEvents: () => void;
  loadAssistantList: (scope: string) => Promise<AssistantSessionSummary[]>;
  createAssistantSession: (
    modelId: string,
    title: string,
    scope: string,
  ) => Promise<AssistantSession>;
  loadAssistantSession: (
    id: string,
    scope: string,
  ) => Promise<AssistantSession>;
  deleteAssistantSession: (id: string, scope: string) => Promise<void>;
  sendAssistantMessage: (
    id: string,
    text: string,
    scope: string,
    attachments?: unknown[],
  ) => Promise<void>;
  provideAssistantInputs: (
    id: string,
    input: Record<string, unknown>,
    scope: string,
  ) => Promise<void>;
  resumeAssistant: (id: string, scope: string) => Promise<void>;
  stopAssistant: (id: string, scope: string) => Promise<void>;
  declineAssistantWorkflow: (id: string, scope: string) => Promise<void>;
  setAssistantModel: (
    id: string,
    modelId: string,
    scope: string,
  ) => Promise<void>;
  setAssistantFeedback: (
    id: string,
    messageId: string,
    value: 'helpful' | 'unhelpful',
    scope: string,
  ) => Promise<void>;
  decideAssistantPlan: (
    id: string,
    planId: string,
    version: number,
    decision: 'approve' | 'cancel',
    text: string,
    scope: string,
  ) => Promise<void>;
  decideAssistantWorkflow: (
    id: string,
    confirmationId: string,
    decision: 'approve' | 'cancel' | 'reselect',
    scope: string,
    text?: string,
  ) => Promise<void>;
  decideAssistantTool: (
    id: string,
    confirmation: AssistantToolConfirmation,
    decision: 'approve' | 'deny',
    text: string,
    scope: string,
  ) => Promise<void>;
  syncErrors: Record<string, string>;
  summaries: Record<string, AssistantSessionSummary[]>;
  listErrors: Record<string, string>;
  sessions: Record<string, AssistantSession>;
  scopes: Record<string, string>;
  streams: Record<string, { messageId: string; text: string }>;
};

export const useAssistantStore = create<AssistantState>()(
  immer((set, get) => ({
    sessions: {},
    scopes: {},
    streams: {},
    syncErrors: {},
    summaries: {},
    listErrors: {},
    initializeAssistantEvents,
    disposeAssistantEvents,
    loadAssistantList,
    loadAssistantSession,
    async createAssistantSession(
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
      await ensureEvents(scope);
      await saveAssistantSession(session);
      ensureWorkspace(scope);
      return get().loadAssistantSession(session.id, scope);
    },
    async sendAssistantMessage(
      id: string,
      text: string,
      scope: string,
      attachments: unknown[] = [],
    ) {
      const session = latest(id);
      if (
        session.activeCall ||
        !['idle', 'error', 'awaiting_feedback'].includes(session.status) ||
        (!text.trim() && !attachments.length)
      )
        return;
      await act(id, scope, { kind: 'send', text, attachments });
    },
    async decideAssistantWorkflow(id, confirmationId, decision, scope, text) {
      const session = latest(id);
      if (
        isAssistantActing(scope, id) ||
        session.status !== 'awaiting_run_confirmation' ||
        session.activeCall?.confirmation?.id !== confirmationId
      )
        return;
      await act(id, scope, {
        kind: 'runDecision',
        confirmation_id: confirmationId,
        decision,
        ...(text ? { text } : {}),
      });
    },
    async provideAssistantInputs(
      id: string,
      input: Record<string, unknown>,
      scope: string,
    ) {
      if (latest(id).status === 'needs_input')
        await act(id, scope, { kind: 'inputs', input });
    },
    async resumeAssistant(id: string, scope: string) {
      ensureWorkspace(scope);
      if (latest(id).status === 'awaiting_run_confirmation') return;
      await act(id, scope, { kind: 'continue' });
    },
    async stopAssistant(id: string, scope: string) {
      ensureWorkspace(scope);
      await ensureEvents(scope);
      await stopAssistantTurn(id);
      ensureWorkspace(scope);
    },
    async declineAssistantWorkflow(id: string, scope: string) {
      if (latest(id).status === 'needs_input')
        await act(id, scope, { kind: 'decline' });
    },
    async setAssistantModel(id: string, modelId: string, scope: string) {
      ensureWorkspace(scope);
      const session = latest(id);
      if (
        isAssistantActing(scope, id) ||
        !['idle', 'error', 'awaiting_feedback'].includes(session.status)
      )
        throw new Error(
          'Wait for the current response before changing its model.',
        );
      const updated = { ...session, modelId };
      await saveAssistantSession(updated);
      ensureWorkspace(scope);
    },
    async setAssistantFeedback(
      id: string,
      messageId: string,
      value: 'helpful' | 'unhelpful',
      scope: string,
    ) {
      ensureWorkspace(scope);
      const session = latest(id);
      if (!['idle', 'error', 'awaiting_feedback'].includes(session.status))
        return;
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
    },
    async decideAssistantPlan(
      id: string,
      planId: string,
      version: number,
      decision: 'approve' | 'cancel',
      text: string,
      scope: string,
    ) {
      const session = latest(id);
      if (
        session.activeCall ||
        !['idle', 'error', 'awaiting_feedback'].includes(session.status)
      )
        return;
      if (
        session.workflowPlan?.id !== planId ||
        session.workflowPlan.version !== version
      )
        throw new Error('Plan changed. Review the latest version.');
      await act(id, scope, {
        kind: 'planDecision',
        plan_id: planId,
        ...(session.workflowPlan.interaction
          ? {
              interaction_id: session.workflowPlan.interaction.id,
              checkpoint_id: session.workflowPlan.interaction.checkpointId,
            }
          : {}),
        version,
        decision,
        text,
      });
    },
    async decideAssistantTool(
      id: string,
      confirmation: AssistantToolConfirmation,
      decision: 'approve' | 'deny',
      text: string,
      scope: string,
    ) {
      const session = latest(id);
      if (
        session.activeCall ||
        !['idle', 'error', 'awaiting_feedback'].includes(session.status)
      )
        return;
      if (
        session.pendingTool?.id !== confirmation.id ||
        session.pendingTool.interaction.checkpointId !==
          confirmation.interaction.checkpointId ||
        session.pendingTool.interaction.status !== 'waiting'
      )
        throw new Error(
          'Tool confirmation changed. Review the latest request.',
        );
      await act(id, scope, {
        kind: 'toolDecision',
        operation_id: confirmation.id,
        interaction_id: confirmation.interaction.id,
        checkpoint_id: confirmation.interaction.checkpointId,
        decision,
        text,
      });
    },
    async deleteAssistantSession(id: string, scope: string) {
      ensureWorkspace(scope);
      await deleteSession(id);
      ensureWorkspace(scope);
      set((state) => {
        delete state.sessions[id];
        delete state.scopes[id];
        delete state.streams[id];
        delete state.syncErrors[id];
      });
    },
  })),
);

if (import.meta.hot)
  import.meta.hot.dispose(() =>
    useAssistantStore.getState().disposeAssistantEvents(),
  );
