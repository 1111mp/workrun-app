import type { Edge, Node } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { prepareWorkflowProcessApps } from '@/services/process-node';
import { resolvePendingAction } from '@/services/run-history';
import { inspectRunRecord } from '@/services/run-history';
import {
  archiveChatSession as archiveChatSessionRequest,
  createChatSession,
  getChatSession,
  listChatSessionTurns,
  resolveAskUserQuestion,
  resolveHumanReview,
  resumeBackgroundWorkflowRun,
  startBackgroundWorkflowRun,
  subscribeWorkflowRun,
  toWorkflowDocument,
  toWorkflowDsl,
  updateChatSessionSnapshot,
  type ToolConfirmationDecision,
  type ChatSession,
  type ChatWorkflowSnapshot,
  type WorkflowRunEvent,
  type WorkflowRunEventEnvelope,
} from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores';
import { workflowRunView } from '@/stores/workflow-run.store';

type SubworkflowContext = {
  workflowId: string;
  threadId: string;
  path: string[];
};

function preparationDescription({
  appName,
  version,
  progress,
}: import('@/services/process-node').WorkflowProcessNodePreparationProgress) {
  const stage = progress.stage;
  if (stage === 'downloading') {
    const percent = progress.totalBytes
      ? Math.min(
          100,
          Math.round((progress.downloadedBytes / progress.totalBytes) * 100),
        )
      : undefined;
    return `${appName} · v${version} — ${percent === undefined ? 'Downloading' : `Downloading ${percent}%`}`;
  }
  const labels: Record<Exclude<typeof stage, 'downloading'>, string> = {
    checkingVersion: 'Checking release',
    verifying: 'Verifying archive',
    extracting: 'Installing files',
    syncingDependencies: 'Syncing dependencies',
    activating: 'Activating release',
    savingCatalog: 'Saving local App',
    completed: 'Ready',
  };
  return `${appName} · v${version} — ${labels[stage]}`;
}

function getSubworkflowContext(value: unknown): SubworkflowContext | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { workflowId, threadId, path } = value as Record<string, unknown>;
  return typeof workflowId === 'string' &&
    typeof threadId === 'string' &&
    Array.isArray(path) &&
    path.every((part) => typeof part === 'string')
    ? { workflowId, threadId, path }
    : undefined;
}

function unconfiguredSubworkflow(nodes: Node[]) {
  return nodes.find((node) => {
    if (node.type !== 'subworkflow') return false;
    const workflowId = node.data?.workflowId;
    return typeof workflowId !== 'string' || !workflowId.trim();
  });
}

function recentChatMessages() {
  const run = workflowRunView(useWorkflowRunStore.getState().projection);
  const messages = run.messages.flatMap((message) => {
    const turnExecution = run.execution.filter(
      (entry) => entry.turnId === message.turnId,
    );
    return [
      { role: message.role, content: message.content },
      ...turnExecution.flatMap((entry) =>
        (Array.isArray(entry.messages) ? entry.messages : [])
          .filter(
            (item): item is { role?: unknown; content?: unknown } =>
              Boolean(item) && typeof item === 'object',
          )
          .flatMap((item) =>
            typeof item.content === 'string' && item.content.trim()
              ? [
                  {
                    role: item.role === 'user' ? 'user' : 'assistant',
                    content: item.content,
                  },
                ]
              : [],
          ),
      ),
    ];
  });
  // Keep prompt growth bounded until durable summaries are introduced.
  return messages.slice(-20);
}

function workflowSnapshot(session: ChatSession): ChatWorkflowSnapshot {
  const snapshot = session.workflowSnapshot;
  if (
    !snapshot ||
    !snapshot.dsl ||
    typeof snapshot.dsl !== 'object' ||
    !snapshot.document ||
    !Array.isArray(snapshot.document.nodes) ||
    !Array.isArray(snapshot.document.edges) ||
    !snapshot.document.settings
  ) {
    throw new Error('This conversation has an invalid workflow snapshot.');
  }
  return snapshot;
}

function useWorkflowRun(
  workflowId: string,
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
  restoredRun?: { id: string; threadId: string },
  releaseId?: string,
  releaseVersion?: string,
  ensureWorkflowId?: () => Promise<string>,
) {
  const [isResolvingHumanReview, setIsResolvingHumanReview] = useState(false);
  const [isResolvingAskUserQuestion, setIsResolvingAskUserQuestion] =
    useState(false);
  const [isRestoringChatSession, setIsRestoringChatSession] = useState(false);
  // `undefined` follows a restored history run, while `null` records that the
  // restored run has finished or been closed during this editor session.
  const [activeRunId, setActiveRunId] = useState<string | null>();
  const resolvedActiveRunId =
    activeRunId === undefined ? restoredRun?.id : (activeRunId ?? undefined);
  const [telemetryRevision, setTelemetryRevision] = useState(0);
  const store = useWorkflowRunStore(
    useShallow((state) => ({
      runningNodeId: state.runningNodeId,
      runStatus: state.projection.status,
      toolApproval: state.toolApproval,
      humanReview: state.humanReview,
      askUserQuestion: state.askUserQuestion,
      resetRunView: state.resetRunView,
      setRunPanelOpen: state.setRunPanelOpen,
      setShowRunOutput: state.setShowRunOutput,
      lastRunInput: state.lastRunInput,
      startWorkflowRun: state.startWorkflowRun,
      resumeWorkflowRun: state.resumeWorkflowRun,
      applyRunEvents: state.applyRunEvents,
      projectFailedRun: state.projectFailedRun,
      clearRunningNode: state.clearRunningNode,
      clearToolApproval: state.clearToolApproval,
      clearHumanReview: state.clearHumanReview,
      clearAskUserQuestion: state.clearAskUserQuestion,
      activeChatSession: state.activeChatSession,
      setActiveChatSession: state.setActiveChatSession,
    })),
  );
  const runThreadId = useRef<string | undefined>(undefined);
  const chatSessionId = useRef<string | undefined>(undefined);
  const chatSessionSnapshot = useRef<ChatWorkflowSnapshot | undefined>(
    undefined,
  );
  const runId = useRef<string | undefined>(undefined);
  const unlistenRunEvents = useRef<(() => void) | undefined>(undefined);
  const chatTurnId = useRef<string | undefined>(undefined);
  const pendingEvents = useRef<WorkflowRunEventEnvelope[]>([]);
  const pendingFrame = useRef<number | undefined>(undefined);
  const afterDrain = useRef<(() => void)[]>([]);
  const handleEventRef = useRef<(event: WorkflowRunEventEnvelope) => void>(
    () => {},
  );

  const context = () => ({
    mode: settings.mode,
    nodes,
    turnId: chatTurnId.current,
  });

  const rememberChatSession = (sessionId: string | undefined) => {
    chatSessionId.current = sessionId;
    if (!sessionId) chatSessionSnapshot.current = undefined;
    store.setActiveChatSession(
      sessionId ? { workflowId, sessionId } : undefined,
    );
  };

  const runAfterDrain = (callback: () => void) => {
    if (pendingEvents.current.length) afterDrain.current.push(callback);
    else callback();
  };

  const drain = () => {
    const event = pendingEvents.current.shift();
    if (event) store.applyRunEvents([event], context());
    if (pendingEvents.current.length) {
      // Preserve native ordering at visual boundaries. In particular, two
      // quick node_start events must not first appear as one combined list.
      pendingFrame.current = requestAnimationFrame(drain);
      return;
    }
    pendingFrame.current = undefined;
    const callbacks = afterDrain.current;
    afterDrain.current = [];
    callbacks.forEach((callback) => callback());
  };

  const queue = (event: WorkflowRunEventEnvelope) => {
    pendingEvents.current.push(event);
    if (pendingFrame.current !== undefined) return;
    pendingFrame.current = requestAnimationFrame(drain);
  };

  useEffect(
    () => () => {
      if (pendingFrame.current !== undefined)
        cancelAnimationFrame(pendingFrame.current);
      unlistenRunEvents.current?.();
    },
    [],
  );

  const handleTerminalEvent = (event: WorkflowRunEvent) => {
    if (event.type === 'done') {
      runAfterDrain(() => {
        const lastNode = event.state.workflow?.['workflow.last_node'];
        toast.success('Workflow completed', {
          toasterId: 'global',
          description:
            typeof lastNode === 'string'
              ? `Finished at node ${lastNode}.`
              : undefined,
        });
      });
    } else if (event.type === 'error') {
      runAfterDrain(() => {
        toast.error('Workflow failed', {
          toasterId: 'global',
          description: event.message,
        });
      });
    }
  };

  const handleEvent = (envelope: WorkflowRunEventEnvelope) => {
    const event = envelope.event;
    if (event.type === 'custom' && event.event_type === 'agent.model_call') {
      // The native runtime persists this span before emitting the event. A
      // revision lets the output panel refresh precisely when usage is ready.
      setTelemetryRevision((revision) => revision + 1);
    }
    handleTerminalEvent(event);
    if (event.type !== 'message' || event.content) queue(envelope);
  };
  handleEventRef.current = handleEvent;

  useEffect(() => {
    if (!restoredRun) return;
    runId.current = restoredRun.id;
    runThreadId.current = restoredRun.threadId;
    let disposed = false;
    // Keep this restored-run subscription intact while routing events through
    // the current render's handler and state.
    void subscribeWorkflowRun(restoredRun.id, (event) => {
      handleEventRef.current(event);
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenRunEvents.current = unlisten;
    });
    return () => {
      disposed = true;
      unlistenRunEvents.current?.();
      unlistenRunEvents.current = undefined;
    };
  }, [restoredRun]);

  const startWorkflowRun = (input: Record<string, unknown>) => {
    void beginWorkflowRun(input);
  };

  const beginWorkflowRun = async (input: Record<string, unknown>) => {
    const subworkflow = unconfiguredSubworkflow(nodes);
    if (subworkflow) {
      const workflowName = subworkflow.data?.workflowName;
      toast.error('Select a workflow for the subworkflow node', {
        toasterId: 'global',
        description:
          typeof workflowName === 'string' && workflowName.trim()
            ? `Choose the saved workflow for ${workflowName}.`
            : 'Open the subworkflow node settings and choose a saved workflow.',
      });
      return;
    }
    let executionWorkflowId = workflowId;
    if (ensureWorkflowId) {
      try {
        // A Team App workspace must belong to a persisted workflow, so the
        // first run creates that workflow before downloading its App files.
        executionWorkflowId = await ensureWorkflowId();
      } catch (error) {
        toast.error('Workflow could not start', {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    const currentDocument = toWorkflowDocument(nodes, edges, settings);
    const currentDsl = toWorkflowDsl(
      executionWorkflowId,
      nodes,
      edges,
      settings,
    );
    if (settings.mode === 'chat') {
      try {
        if (!chatSessionId.current) {
          const persisted = store.activeChatSession;
          if (persisted?.workflowId === executionWorkflowId)
            chatSessionId.current = persisted.sessionId;
        }
        if (chatSessionId.current && !chatSessionSnapshot.current) {
          chatSessionSnapshot.current = workflowSnapshot(
            await getChatSession(chatSessionId.current),
          );
        }
        if (!chatSessionId.current) {
          const id = crypto.randomUUID();
          const snapshot: ChatWorkflowSnapshot = {
            dsl: currentDsl,
            document: currentDocument,
            targetName: settings.name,
            releaseId,
            releaseVersion,
          };
          await createChatSession(id, executionWorkflowId, snapshot);
          chatSessionSnapshot.current = snapshot;
          rememberChatSession(id);
        }
      } catch (error) {
        toast.error('Workflow could not start', {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    if (pendingFrame.current !== undefined) {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    }
    pendingEvents.current = [];
    afterDrain.current = [];
    chatTurnId.current =
      settings.mode === 'chat' ? crypto.randomUUID() : undefined;
    // A completed graph checkpoint is not a resumable chat session. Give each
    // turn an execution-scoped thread; conversation continuity is injected as
    // input until the durable ChatSession store is introduced.
    const threadId = crypto.randomUUID();
    runThreadId.current = threadId;
    const id = crypto.randomUUID();
    runId.current = id;
    setTelemetryRevision(0);
    const initialState =
      settings.mode === 'chat'
        ? {
            ...input,
            conversation: { recentMessages: recentChatMessages() },
          }
        : input;
    store.startWorkflowRun(id, input, settings.mode, chatTurnId.current);
    const preparationToastId = `workflow-preparation-${id}`;
    let isPreparingTeamApp = false;
    try {
      unlistenRunEvents.current?.();
      unlistenRunEvents.current = await subscribeWorkflowRun(id, handleEvent);
      const sessionSnapshot = chatSessionSnapshot.current;
      const executionReleaseId = sessionSnapshot?.releaseId ?? releaseId;
      const dsl = await prepareWorkflowProcessApps(
        sessionSnapshot?.dsl ?? currentDsl,
        `release-${executionReleaseId ?? `draft-${executionWorkflowId}`}`,
        (progress) => {
          isPreparingTeamApp = true;
          toast.loading('Preparing Team Apps', {
            id: preparationToastId,
            toasterId: 'global',
            description: preparationDescription(progress),
          });
        },
      );
      if (isPreparingTeamApp) toast.dismiss(preparationToastId);
      if (sessionSnapshot && chatSessionId.current) {
        // Team App preparation resolves immutable releases to local executable
        // IDs. Persist that resolved DSL before native code reloads the session.
        const preparedSnapshot = { ...sessionSnapshot, dsl };
        await updateChatSessionSnapshot(
          chatSessionId.current,
          preparedSnapshot,
        );
        chatSessionSnapshot.current = preparedSnapshot;
      }
      await startBackgroundWorkflowRun({
        runId: id,
        targetId: executionWorkflowId,
        targetName: sessionSnapshot?.targetName ?? settings.name,
        input,
        targetSnapshot: sessionSnapshot?.document ?? currentDocument,
        releaseId: executionReleaseId,
        releaseVersion: sessionSnapshot?.releaseVersion ?? releaseVersion,
        dsl,
        initialState,
        threadId,
        chatSessionId: chatSessionId.current,
        chatTurnId: chatTurnId.current,
      });
      // The create command has returned, so the inspection query cannot race
      // the SQLite record creation for this newly started run.
      setActiveRunId(id);
    } catch (error) {
      if (isPreparingTeamApp) toast.dismiss(preparationToastId);
      unlistenRunEvents.current?.();
      unlistenRunEvents.current = undefined;
      store.projectFailedRun(
        error instanceof Error ? error.message : String(error),
      );
      toast.error('Workflow could not start', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
      runId.current = undefined;
      setActiveRunId(null);
    }
  };

  const resumeWorkflowRun = (toolConfirmation?: ToolConfirmationDecision) => {
    const id = runId.current;
    if (!id) return;
    if (pendingFrame.current !== undefined) {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    }
    pendingEvents.current = [];
    afterDrain.current = [];
    store.resumeWorkflowRun();
    void resumeBackgroundWorkflowRun(id, toolConfirmation).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.projectFailedRun(message);
      toast.error('Workflow could not resume', {
        toasterId: 'global',
        description: message,
      });
    });
  };

  const restoreChatSession = async (sessionId: string) => {
    setIsRestoringChatSession(true);
    try {
      // Read the complete replacement before clearing the active transcript.
      // A transient database failure must leave the visible conversation intact.
      const session = await getChatSession(sessionId);
      const snapshot = workflowSnapshot(session);
      const turns = await listChatSessionTurns(sessionId);
      const records = await Promise.all(
        turns.map((turn) => inspectRunRecord(turn.runId)),
      );
      resetRunContext();
      chatSessionSnapshot.current = snapshot;
      rememberChatSession(sessionId);
      for (const [turn, record] of turns.map(
        (turn, index) => [turn, records[index]] as const,
      )) {
        store.startWorkflowRun(
          record.id,
          record.input ?? { input: turn.userMessage },
          'chat',
          turn.id,
        );
        store.applyRunEvents(
          record.events.map(({ sequence, event }) => ({
            runId: record.id,
            sequence,
            event: event as WorkflowRunEvent,
          })),
          {
            mode: 'chat',
            nodes: snapshot.document.nodes,
            turnId: turn.id,
            input: record.input ?? undefined,
          },
        );
        runId.current = record.id;
        const threadId = (record.runtime as { threadId?: unknown }).threadId;
        runThreadId.current =
          typeof threadId === 'string' ? threadId : undefined;
      }
    } catch (error) {
      toast.error('Could not restore this conversation', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsRestoringChatSession(false);
    }
  };

  const archiveChatSession = async (sessionId: string) => {
    try {
      await archiveChatSessionRequest(sessionId);
      if (chatSessionId.current === sessionId) resetRunContext();
      return true;
    } catch (error) {
      toast.error('Could not archive this conversation', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const resetRunContext = (clearChatSession = true) => {
    if (pendingFrame.current !== undefined) {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    }
    pendingEvents.current = [];
    afterDrain.current = [];
    unlistenRunEvents.current?.();
    unlistenRunEvents.current = undefined;
    runId.current = undefined;
    runThreadId.current = undefined;
    chatTurnId.current = undefined;
    if (clearChatSession) rememberChatSession(undefined);
    // Clear the query identity with the output projection. Otherwise a mode
    // switch can render the prior task's telemetry in an empty chat session.
    setActiveRunId(null);
    setTelemetryRevision(0);
    store.resetRunView();
    store.setShowRunOutput(false);
  };

  const newChat = () => {
    resetRunContext();
    store.setRunPanelOpen(true);
  };

  const startRun = () => {
    if (settings.mode === 'chat') {
      const activeSession = store.activeChatSession;
      if (activeSession?.workflowId === workflowId) {
        void restoreChatSession(activeSession.sessionId);
        return;
      }
      // Reopening the run drawer is navigation, not a request for a new
      // conversation. Only the explicit New chat action clears its identity.
      resetRunContext(false);
      store.setRunPanelOpen(true);
    } else if (settings.inputSchema.fields.length === 0) {
      startWorkflowRun({});
    } else {
      store.setShowRunOutput(false);
      store.setRunPanelOpen(true);
    }
  };

  const resolvePendingToolApproval = async (approved: boolean) => {
    const approval = store.toolApproval;
    const { functionCallId, fingerprint } = approval ?? {};
    if (typeof functionCallId !== 'string' || typeof fingerprint !== 'string')
      return;
    const nodeId = approval?.nodeId;
    if (!approved && typeof nodeId === 'string') {
      // The native graph only records the decision on resume. Add the UI event
      // now so the rejected invocation remains visible in this execution.
      store.applyRunEvents(
        [
          {
            runId: runId.current ?? 'local',
            // Insert between the last persisted event and the next native
            // sequence, so the local denial cannot suppress resume events.
            sequence:
              useWorkflowRunStore.getState().projection.eventSequence + 0.5,
            event: {
              type: 'custom',
              node: nodeId,
              event_type: 'agent.tool_denied',
              data: {
                tool: approval?.tool,
                name: approval?.name,
                input: approval?.input,
                status: 'denied',
                message: 'Denied by user',
              },
            },
          },
        ],
        context(),
      );
    }

    const actionId = approval?.runActionId;
    if (actionId) {
      try {
        if (typeof actionId !== 'string')
          throw new Error('run action is invalid');
        await resolvePendingAction(actionId, { approved });
      } catch (error) {
        toast.error('Could not resume the run', {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    store.clearToolApproval();
    resumeWorkflowRun({ functionCallId, fingerprint, approved });
  };

  const resolvePendingHumanReview = async (
    approved: boolean,
    edits: Record<string, string> = {},
  ) => {
    if (isResolvingHumanReview) return false;
    const review = store.humanReview;
    const nodeId = review?.nodeId;
    if (typeof nodeId !== 'string') return false;
    const threadId = runThreadId.current;
    if (!threadId) return false;

    setIsResolvingHumanReview(true);
    try {
      const workflowContext = getSubworkflowContext(review?.workflowContext);
      await resolveHumanReview(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        threadId,
        nodeId,
        approved,
        edits,
        workflowContext,
      );
      const actionId = review?.runActionId;
      if (actionId) {
        if (typeof actionId !== 'string')
          throw new Error('run action is invalid');
        await resolvePendingAction(actionId, { approved, edits });
      }
      store.clearHumanReview();
      resumeWorkflowRun();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Could not record the review decision', {
        toasterId: 'global',
        description: message,
      });
      return false;
    } finally {
      setIsResolvingHumanReview(false);
    }
  };

  const resolvePendingAskUserQuestion = async (optionId: string) => {
    if (isResolvingAskUserQuestion) return;
    const nodeId = store.askUserQuestion?.nodeId;
    if (typeof nodeId !== 'string') return;
    const threadId = runThreadId.current;
    if (!threadId) return;

    setIsResolvingAskUserQuestion(true);
    try {
      const workflowContext = getSubworkflowContext(
        store.askUserQuestion?.workflowContext,
      );
      await resolveAskUserQuestion(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        threadId,
        nodeId,
        optionId,
        workflowContext,
      );
      const actionId = store.askUserQuestion?.runActionId;
      if (actionId) {
        if (typeof actionId !== 'string')
          throw new Error('run action is invalid');
        await resolvePendingAction(actionId, { optionId });
      }
      store.clearAskUserQuestion();
      resumeWorkflowRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Could not record the selected option', {
        toasterId: 'global',
        description: message,
      });
    } finally {
      setIsResolvingAskUserQuestion(false);
    }
  };

  return {
    isRunning: store.runStatus === 'running',
    runStatus: store.runStatus,
    startRun,
    startWorkflowRun,
    runningNodeId: store.runningNodeId,
    toolApproval: store.toolApproval,
    humanReview: store.humanReview,
    askUserQuestion: store.askUserQuestion,
    isResolvingHumanReview,
    isResolvingAskUserQuestion,
    resolvePendingToolApproval,
    resolvePendingHumanReview,
    resolvePendingAskUserQuestion,
    resumeWorkflowRun,
    restoreChatSession,
    archiveChatSession,
    isRestoringChatSession,
    chatSessionDocument: chatSessionSnapshot.current?.document,
    resetRunContext,
    newChat,
    activeChatSessionId:
      store.activeChatSession?.workflowId === workflowId
        ? store.activeChatSession.sessionId
        : undefined,
    runId: resolvedActiveRunId,
    telemetryRevision,
  };
}

export { useWorkflowRun };
