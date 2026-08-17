import type { Node } from '@xyflow/react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type { WorkflowRunEvent, WorkflowRunView } from '@/services/workflow';

const initialRunView: WorkflowRunView = {
  status: 'idle',
  nodes: [],
  messages: [],
  thoughts: [],
  processLogs: [],
  execution: [],
};

type WorkflowRunStore = {
  lastRunInput?: Record<string, unknown>;
  runPanelOpen: boolean;
  runView: WorkflowRunView;
  runningNodeId: string | null;
  showRunOutput: boolean;
  toolApproval?: Record<string, unknown>;
  setLastRunInput: (input: Record<string, unknown> | undefined) => void;
  setRunPanelOpen: (open: boolean) => void;
  setRunningNodeId: (nodeId: string | null) => void;
  setRunView: (
    view: WorkflowRunView | ((current: WorkflowRunView) => WorkflowRunView),
  ) => void;
  setShowRunOutput: (show: boolean) => void;
  setToolApproval: (approval: Record<string, unknown> | undefined) => void;
  resetRunView: () => void;
  startWorkflowRun: (
    input: Record<string, unknown>,
    mode: WorkflowMode,
    turnId?: string,
  ) => void;
  applyRunEvents: (
    events: WorkflowRunEvent[],
    context: { mode: WorkflowMode; nodes: Node[]; turnId?: string },
  ) => void;
  finishWorkflowRun: (state: Record<string, unknown>) => void;
  failWorkflowRun: (message: string) => void;
  clearRunningNode: () => void;
  clearToolApproval: () => void;
};

/** Transient UI state for the workflow run panel. It is intentionally not persisted. */
export const useWorkflowRunStore = create<WorkflowRunStore>()(
  immer((set) => ({
    lastRunInput: undefined,
    runPanelOpen: false,
    runView: initialRunView,
    runningNodeId: null,
    showRunOutput: false,
    toolApproval: undefined,

    setLastRunInput: (input) => {
      set((state) => {
        state.lastRunInput = input;
      });
    },
    setRunPanelOpen: (open) => {
      set((state) => {
        state.runPanelOpen = open;
      });
    },
    setRunningNodeId: (nodeId) => {
      set((state) => {
        state.runningNodeId = nodeId;
      });
    },
    setRunView: (view) => {
      set((state) => {
        state.runView =
          typeof view === 'function'
            ? view(state.runView as WorkflowRunView)
            : view;
      });
    },
    setShowRunOutput: (show) => {
      set((state) => {
        state.showRunOutput = show;
      });
    },
    setToolApproval: (approval) => {
      set((state) => {
        state.toolApproval = approval;
      });
    },
    resetRunView: () => {
      set((state) => {
        state.runView = initialRunView;
      });
    },
    startWorkflowRun: (input, mode, turnId) => {
      set((state) => {
        state.lastRunInput = input;
        state.runPanelOpen = true;
        state.showRunOutput = true;
        if (mode === 'chat') {
          const value = input.input;
          state.runView.status = 'running';
          state.runView.startedAt = Date.now();
          state.runView.endedAt = undefined;
          state.runView.activeNodeId = undefined;
          state.runView.finalState = undefined;
          state.runView.error = undefined;
          state.runView.nodes = [];
          state.runView.execution = [];
          state.runView.messages.push({
            id: crypto.randomUUID(),
            nodeId: 'You',
            content:
              typeof value === 'string'
                ? value
                : (JSON.stringify(value ?? '') ?? ''),
            isStreaming: false,
            role: 'user',
            turnId,
          });
        } else {
          state.runView = {
            ...initialRunView,
            status: 'running',
            startedAt: Date.now(),
          };
        }
      });
    },
    applyRunEvents: (events, context) => {
      set((state) => {
        for (const event of events) applyRunEvent(state, event, context);
      });
    },
    finishWorkflowRun: (finalState) => {
      set((state) => finish(state, 'completed', finalState));
    },
    failWorkflowRun: (message) => {
      set((state) => finish(state, 'failed', undefined, message));
    },
    clearRunningNode: () => {
      set((state) => {
        state.runningNodeId = null;
      });
    },
    clearToolApproval: () => {
      set((state) => {
        state.toolApproval = undefined;
      });
    },
  })),
);

function applyRunEvent(
  state: WorkflowRunStore,
  event: WorkflowRunEvent,
  context: { mode: WorkflowMode; nodes: Node[]; turnId?: string },
) {
  const view = state.runView;
  if (event.type === 'node_start') {
    const node = context.nodes.find((item) => item.id === event.node);
    const existing = view.nodes.find((item) => item.id === event.node);
    if (existing) existing.status = 'running';
    else
      view.nodes.push({
        id: event.node,
        name: displayName(node),
        status: 'running',
      });
    state.runningNodeId = event.node;
    view.activeNodeId = event.node;
    view.execution.push({
      nodeId: event.node,
      type: node?.type ?? 'node',
      status: 'running',
      turnId: context.turnId,
    });
    view.thoughts.push({
      id: crypto.randomUUID(),
      nodeId: event.node,
      status: 'running',
      turnId: context.turnId,
    });
    return;
  }
  if (event.type === 'message') return appendMessage(view, event, context);
  if (event.type === 'node_end') {
    const node = view.nodes.find((item) => item.id === event.node);
    if (node)
      Object.assign(node, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    const execution = view.execution.findLast(
      (item) => item.nodeId === event.node,
    );
    if (execution)
      Object.assign(execution, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    const thought = view.thoughts.findLast(
      (item) => item.nodeId === event.node && item.status === 'running',
    );
    if (thought)
      Object.assign(thought, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    if (view.activeNodeId === event.node) view.activeNodeId = undefined;
    view.messages.forEach((item) => {
      if (item.nodeId === event.node) item.isStreaming = false;
    });
    return;
  }
  if (event.type === 'custom') return applyCustom(state, event);
  if (event.type === 'done') {
    finish(state, 'completed', event.state);
    view.totalSteps = event.total_steps;
  } else if (event.type === 'error') {
    finish(state, 'failed', undefined, event.message);
  } else if (event.type === 'interrupted') {
    finish(state, 'interrupted', undefined, event.message);
  }
}

function appendMessage(
  view: WorkflowRunView,
  event: Extract<WorkflowRunEvent, { type: 'message' }>,
  context: { mode: WorkflowMode; turnId?: string },
) {
  if (context.mode !== 'chat') {
    const execution = view.execution.findLast(
      (item) => item.nodeId === event.node,
    );
    if (!execution) return;
    const messages = Array.isArray(execution.messages)
      ? execution.messages
      : [];
    const last = messages.at(-1) as Record<string, unknown> | undefined;
    if (typeof last?.content === 'string') last.content += event.content;
    else messages.push({ role: 'assistant', content: event.content });
    execution.messages = messages;
    return;
  }
  const last = view.messages.at(-1);
  if (last?.nodeId === event.node && last.isStreaming) {
    last.content += event.content;
    last.isStreaming = !event.is_final;
  } else
    view.messages.push({
      id: crypto.randomUUID(),
      nodeId: event.node,
      content: event.content,
      isStreaming: !event.is_final,
      role: 'assistant',
      turnId: context.turnId,
    });
}

function applyCustom(
  state: WorkflowRunStore,
  event: Extract<WorkflowRunEvent, { type: 'custom' }>,
) {
  if (typeof event.data !== 'object' || event.data === null) return;
  if (event.event_type === 'agent.tool_approval_required') {
    state.toolApproval = event.data as Record<string, unknown>;
    return;
  }
  const execution = state.runView.execution.findLast(
    (item) => item.nodeId === event.node,
  );
  if (!execution) return;
  if (event.event_type === 'agent.tool_result') {
    execution.toolCalls = [
      ...(Array.isArray(execution.toolCalls) ? execution.toolCalls : []),
      event.data,
    ];
  } else if (event.event_type === 'workflow.node_result') {
    const messages = execution.messages;
    Object.assign(execution, event.data);
    if (Array.isArray(messages) && messages.length)
      execution.messages = messages;
  } else if (event.event_type === 'process.output') {
    const { stream, data, name } = event.data as Record<string, unknown>;
    if (
      (stream !== 'stdout' && stream !== 'stderr') ||
      typeof data !== 'string'
    )
      return;
    execution[stream] = truncate(String(execution[stream] ?? '') + data);
    let log = state.runView.processLogs.find(
      (item) => item.nodeId === event.node,
    );
    if (!log) {
      log = {
        nodeId: event.node,
        name: typeof name === 'string' ? name : event.node,
        stdout: '',
        stderr: '',
      };
      state.runView.processLogs.push(log);
    }
    log[stream] = truncate(log[stream] + data);
  }
}

function finish(
  state: WorkflowRunStore,
  status: WorkflowRunView['status'],
  finalState?: Record<string, unknown>,
  error?: string,
) {
  const view = state.runView;
  view.status = status;
  view.activeNodeId = undefined;
  view.endedAt ??= Date.now();
  if (finalState) view.finalState = finalState;
  if (error) view.error = error;
  view.thoughts.forEach((item) => {
    if (item.status === 'running')
      item.status = status === 'completed' ? 'completed' : 'failed';
  });
  view.messages.forEach((item) => {
    item.isStreaming = false;
  });
}

function displayName(node?: Node) {
  const data = node?.data;
  return typeof data?.name === 'string' && data.name.trim()
    ? data.name
    : typeof data?.label === 'string' && data.label.trim()
      ? data.label
      : (node?.id ?? '');
}

function truncate(value: string) {
  return value.length <= 200_000
    ? value
    : `[Earlier output truncated]\n${value.slice(-200_000)}`;
}
