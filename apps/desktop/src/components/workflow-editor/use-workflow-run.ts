import type { Edge, Node } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import { resolvePendingAction } from '@/services/run-history';
import {
  resolveAskUserQuestion,
  resolveHumanReview,
  resumeBackgroundWorkflowRun,
  startBackgroundWorkflowRun,
  subscribeWorkflowRun,
  toWorkflowDocument,
  toWorkflowDsl,
  type ToolConfirmationDecision,
  type WorkflowRunEvent,
} from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores';

type MessageEvent = Extract<WorkflowRunEvent, { type: 'message' }>;
type BufferedMessageEvent = Omit<MessageEvent, 'content'> & {
  content: string[];
  offset: number;
};
type PendingRunEvent =
  | Exclude<WorkflowRunEvent, MessageEvent>
  | BufferedMessageEvent;

type SubworkflowContext = {
  workflowId: string;
  threadId: string;
  path: string[];
};

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

function charactersPerFrame(pendingCharacters: number) {
  if (pendingCharacters <= 0) return 0;
  return Math.min(1 + Math.floor(Math.sqrt(pendingCharacters) * 0.6), 32);
}

function splitGraphemes(str: string): string[] {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, {
      granularity: 'grapheme',
    });
    return Array.from(segmenter.segment(str), (s) => s.segment);
  }
  return Array.from(str);
}

function useWorkflowRun(
  workflowId: string,
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
  restoredRun?: { id: string; threadId: string },
) {
  const [isResolvingHumanReview, setIsResolvingHumanReview] = useState(false);
  const [isResolvingAskUserQuestion, setIsResolvingAskUserQuestion] =
    useState(false);
  const store = useWorkflowRunStore(
    useShallow((state) => ({
      runningNodeId: state.runningNodeId,
      runStatus: state.runView.status,
      toolApproval: state.toolApproval,
      humanReview: state.humanReview,
      askUserQuestion: state.askUserQuestion,
      resetRunView: state.resetRunView,
      setRunPanelOpen: state.setRunPanelOpen,
      setShowRunOutput: state.setShowRunOutput,
      setRunView: state.setRunView,
      lastRunInput: state.lastRunInput,
      startWorkflowRun: state.startWorkflowRun,
      resumeWorkflowRun: state.resumeWorkflowRun,
      applyRunEvents: state.applyRunEvents,
      finishWorkflowRun: state.finishWorkflowRun,
      failWorkflowRun: state.failWorkflowRun,
      clearRunningNode: state.clearRunningNode,
      clearToolApproval: state.clearToolApproval,
      clearHumanReview: state.clearHumanReview,
      clearAskUserQuestion: state.clearAskUserQuestion,
    })),
  );
  const chatThreadId = useRef<string | undefined>(undefined);
  const runThreadId = useRef<string | undefined>(undefined);
  const runId = useRef<string | undefined>(undefined);
  const unlistenRunEvents = useRef<(() => void) | undefined>(undefined);
  const chatTurnId = useRef<string | undefined>(undefined);
  const pendingEvents = useRef<PendingRunEvent[]>([]);
  const pendingCharacters = useRef(0);
  const pendingFrame = useRef<number | undefined>(undefined);
  const afterDrain = useRef<(() => void)[]>([]);

  const context = () => ({
    mode: settings.mode,
    nodes,
    turnId: chatTurnId.current,
  });

  const runAfterDrain = (callback: () => void) => {
    if (pendingEvents.current.length) afterDrain.current.push(callback);
    else callback();
  };

  const drain = () => {
    const events: WorkflowRunEvent[] = [];
    let remaining = charactersPerFrame(pendingCharacters.current);

    while (pendingEvents.current.length) {
      const event = pendingEvents.current[0];
      if (event.type !== 'message') {
        pendingEvents.current.shift();
        events.push(event);
        continue;
      }
      const count = Math.min(remaining, event.content.length - event.offset);
      const content = event.content
        .slice(event.offset, event.offset + count)
        .join('');
      event.offset += count;
      pendingCharacters.current -= count;
      remaining -= count;
      const complete = event.offset === event.content.length;
      events.push({
        type: 'message',
        node: event.node,
        content,
        is_final: complete && event.is_final,
      });
      if (complete) pendingEvents.current.shift();
      if (remaining === 0) break;
    }

    if (events.length) store.applyRunEvents(events, context());
    if (pendingEvents.current.length) {
      pendingFrame.current = requestAnimationFrame(drain);
      return;
    }
    pendingFrame.current = undefined;
    const callbacks = afterDrain.current;
    afterDrain.current = [];
    callbacks.forEach((callback) => callback());
  };

  const queue = (event: MessageEvent) => {
    const content = splitGraphemes(event.content);
    pendingCharacters.current += content.length;
    pendingEvents.current.push({ ...event, content, offset: 0 });
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

  const handleEvent = (event: WorkflowRunEvent) => {
    handleTerminalEvent(event);
    if (event.type === 'message') {
      if (event.content) queue(event);
      return;
    }
    if (pendingEvents.current.length) {
      pendingEvents.current.push(event);
      return;
    }
    store.applyRunEvents([event], context());
  };

  useEffect(() => {
    if (!restoredRun) return;
    runId.current = restoredRun.id;
    runThreadId.current = restoredRun.threadId;
    let disposed = false;
    void subscribeWorkflowRun(restoredRun.id, handleEvent).then((unlisten) => {
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
    if (pendingFrame.current !== undefined) {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    }
    pendingEvents.current = [];
    pendingCharacters.current = 0;
    afterDrain.current = [];
    chatTurnId.current =
      settings.mode === 'chat' ? crypto.randomUUID() : undefined;
    const threadId =
      settings.mode === 'chat'
        ? (chatThreadId.current ?? crypto.randomUUID())
        : crypto.randomUUID();
    runThreadId.current = threadId;
    const id = crypto.randomUUID();
    runId.current = id;
    store.startWorkflowRun(input, settings.mode, chatTurnId.current);
    try {
      unlistenRunEvents.current?.();
      unlistenRunEvents.current = await subscribeWorkflowRun(id, handleEvent);
      await startBackgroundWorkflowRun({
        runId: id,
        targetId: workflowId,
        targetName: settings.name,
        input,
        outputView: useWorkflowRunStore.getState().runView,
        targetSnapshot: toWorkflowDocument(nodes, edges, settings),
        dsl: toWorkflowDsl(workflowId, nodes, edges, settings),
        initialState: input,
        threadId,
      });
    } catch (error) {
      unlistenRunEvents.current?.();
      unlistenRunEvents.current = undefined;
      store.failWorkflowRun(
        error instanceof Error ? error.message : String(error),
      );
      toast.error('Workflow could not start', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
      runId.current = undefined;
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
    pendingCharacters.current = 0;
    afterDrain.current = [];
    store.resumeWorkflowRun();
    void resumeBackgroundWorkflowRun(id, toolConfirmation).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      store.failWorkflowRun(message);
      toast.error('Workflow could not resume', {
        toasterId: 'global',
        description: message,
      });
    });
  };

  const startRun = () => {
    if (settings.mode === 'chat') {
      chatThreadId.current = crypto.randomUUID();
      store.resetRunView();
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
  };
}

export { useWorkflowRun };
