import { useMutation } from '@tanstack/react-query';
import type { Edge, Node } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';

import {
  resolveAskUserQuestion,
  resolveHumanReview,
  resolveToolApproval,
  runWorkflow,
  toWorkflowDsl,
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

type WorkflowRunRequest = {
  input: Record<string, unknown>;
  threadId: string;
  resume: boolean;
};

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
) {
  const [isResolvingHumanReview, setIsResolvingHumanReview] = useState(false);
  const [isResolvingAskUserQuestion, setIsResolvingAskUserQuestion] =
    useState(false);
  const store = useWorkflowRunStore(
    useShallow((state) => ({
      runningNodeId: state.runningNodeId,
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
    },
    [],
  );
  const handleEvent = (event: WorkflowRunEvent) => {
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
  const mutation = useMutation({
    mutationFn: ({ input, threadId, resume }: WorkflowRunRequest) =>
      runWorkflow(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        input,
        threadId,
        resume,
        handleEvent,
      ),
    onSuccess: (result) => {
      runAfterDrain(() => {
        if (result.interrupted) {
          if (!store.humanReview && !store.askUserQuestion) {
            toast.info('Workflow interrupted', {
              toasterId: 'global',
              description: 'Resume to continue from the saved checkpoint.',
            });
          }
          return;
        }
        store.finishWorkflowRun(result.state);
        const lastNode = result.state['workflow.last_node'];
        toast.success('Workflow completed', {
          toasterId: 'global',
          description:
            typeof lastNode === 'string'
              ? `Finished at node ${lastNode}.`
              : undefined,
        });
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      runAfterDrain(() => {
        store.failWorkflowRun(message);
        toast.error('Workflow failed', {
          toasterId: 'global',
          description: message,
        });
      });
    },
    onSettled: () => runAfterDrain(store.clearRunningNode),
  });
  const startWorkflowRun = (input: Record<string, unknown>) => {
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
    store.startWorkflowRun(input, settings.mode, chatTurnId.current);
    mutation.mutate({ input, threadId, resume: false });
  };
  const resumeWorkflowRun = () => {
    const threadId = runThreadId.current;
    if (!threadId) return;
    const input = store.lastRunInput ?? {};
    if (pendingFrame.current !== undefined) {
      cancelAnimationFrame(pendingFrame.current);
      pendingFrame.current = undefined;
    }
    pendingEvents.current = [];
    pendingCharacters.current = 0;
    afterDrain.current = [];
    store.resumeWorkflowRun();
    mutation.mutate({ input, threadId, resume: true });
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
    const { requestId, fingerprint } = store.toolApproval ?? {};
    if (typeof requestId !== 'string' || typeof fingerprint !== 'string')
      return;
    store.clearToolApproval();
    await resolveToolApproval(requestId, fingerprint, approved);
  };
  const resolvePendingHumanReview = async (
    approved: boolean,
    edits: Record<string, string> = {},
  ) => {
    if (isResolvingHumanReview) return;
    const review = store.humanReview;
    const nodeId = review?.nodeId;
    if (typeof nodeId !== 'string') return;
    const threadId = runThreadId.current;
    if (!threadId) return;

    setIsResolvingHumanReview(true);
    try {
      await resolveHumanReview(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        threadId,
        nodeId,
        approved,
        edits,
      );
      store.clearHumanReview();
      resumeWorkflowRun();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error('Could not record the review decision', {
        toasterId: 'global',
        description: message,
      });
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
      await resolveAskUserQuestion(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        threadId,
        nodeId,
        optionId,
      );
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
    isRunning: mutation.isPending,
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
