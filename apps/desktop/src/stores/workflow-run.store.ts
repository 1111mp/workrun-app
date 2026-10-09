import type { Node } from '@xyflow/react';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import type {
  WorkflowRunEvent,
  WorkflowRunEventEnvelope,
  WorkflowRunExecution,
  WorkflowRunMessage,
  WorkflowRunNode,
  WorkflowRunStatus,
  WorkflowRunThought,
  WorkflowRunTurn,
  WorkflowRunView,
} from '@/services/workflow';

export type WorkflowRunEventContext = {
  mode: WorkflowMode;
  nodes: Node[];
  turnId?: string;
  input?: Record<string, unknown>;
};

/**
 * The only runtime projection. Arrays carry stable render order; entity maps
 * let a delta update one row without replacing completed output rows.
 */
export type WorkflowRunProjection = {
  runId?: string;
  status: WorkflowRunStatus;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  activeNodeId?: string;
  totalSteps?: number;
  finalState?: Record<string, unknown>;
  error?: string;
  contextCompactionStage?: 'summarizing' | 'ready' | 'failed';
  eventSequence: number;
  nodeIds: string[];
  nodesById: Record<string, WorkflowRunNode>;
  executionIds: string[];
  executionsById: Record<string, WorkflowRunExecution>;
  thoughtIds: string[];
  thoughtsById: Record<string, WorkflowRunThought>;
  messageIds: string[];
  messagesById: Record<string, WorkflowRunMessage>;
  latestExecutionIdByNode: Record<string, string>;
  latestThoughtIdByNode: Record<string, string>;
  resumePendingNodeIds: Record<string, true>;
  activeMessageIdByNode: Record<string, string>;
  processLogsByNode: Record<
    string,
    { nodeId: string; name: string; stdout: string; stderr: string }
  >;
  turnsById: Record<string, WorkflowRunTurn>;
};

export type ActiveChatSession = {
  workflowId: string;
  sessionId: string;
};

export function createWorkflowRunProjection(
  runId?: string,
): WorkflowRunProjection {
  return {
    runId,
    status: 'idle',
    // Native run logs are zero-based. Start below the first valid sequence so
    // the initial node_start is not mistaken for a duplicate event.
    eventSequence: -1,
    nodeIds: [],
    nodesById: {},
    executionIds: [],
    executionsById: {},
    thoughtIds: [],
    thoughtsById: {},
    messageIds: [],
    messagesById: {},
    latestExecutionIdByNode: {},
    latestThoughtIdByNode: {},
    resumePendingNodeIds: {},
    activeMessageIdByNode: {},
    processLogsByNode: {},
    turnsById: {},
  };
}

/** Converts the normalized projection only at read-only component boundaries. */
export function workflowRunView(
  projection: WorkflowRunProjection,
): WorkflowRunView {
  return {
    runId: projection.runId,
    status: projection.status,
    startedAt: projection.startedAt,
    endedAt: projection.endedAt,
    durationMs: projection.durationMs,
    activeNodeId: projection.activeNodeId,
    totalSteps: projection.totalSteps,
    finalState: projection.finalState,
    error: projection.error,
    contextCompactionStage: projection.contextCompactionStage,
    nodes: projection.nodeIds
      .map((id) => projection.nodesById[id])
      .filter(Boolean),
    execution: projection.executionIds
      .map((id) => projection.executionsById[id])
      .filter(Boolean),
    thoughts: projection.thoughtIds
      .map((id) => projection.thoughtsById[id])
      .filter(Boolean),
    messages: projection.messageIds
      .map((id) => projection.messagesById[id])
      .filter(Boolean),
    processLogs: Object.values(projection.processLogsByNode),
    turnsById: projection.turnsById,
  };
}

export function replayWorkflowRunProjection(
  runId: string,
  events: WorkflowRunEventEnvelope[],
  context: WorkflowRunEventContext,
): WorkflowRunProjection {
  const projection = createWorkflowRunProjection(runId);
  if (context.mode === 'chat' && context.input) {
    // Live runs add the user bubble before native events arrive. Recreate it
    // for history so node executions have a visible chat turn to attach to.
    const id = `${runId}:input:${context.turnId ?? 0}`;
    projection.messageIds.push(id);
    projection.messagesById[id] = {
      id,
      nodeId: 'You',
      content:
        typeof context.input.input === 'string'
          ? context.input.input
          : JSON.stringify(context.input.input ?? ''),
      isStreaming: false,
      role: 'user',
      turnId: context.turnId,
    };
    if (context.turnId) {
      projection.turnsById[context.turnId] = {
        status: 'running',
      };
    }
  }
  for (const envelope of events)
    reduceWorkflowRunEvent(projection, envelope, context);
  return projection;
}

type WorkflowRunStore = {
  lastRunInput?: Record<string, unknown>;
  runPanelOpen: boolean;
  projection: WorkflowRunProjection;
  runningNodeId: string | null;
  showRunOutput: boolean;
  activeChatSession?: ActiveChatSession;
  toolApproval?: Record<string, unknown>;
  humanReview?: Record<string, unknown>;
  askUserQuestion?: Record<string, unknown>;
  setLastRunInput: (input: Record<string, unknown> | undefined) => void;
  setRunPanelOpen: (open: boolean) => void;
  setRunningNodeId: (nodeId: string | null) => void;
  setShowRunOutput: (show: boolean) => void;
  setActiveChatSession: (session: ActiveChatSession | undefined) => void;
  resetRunView: () => void;
  startWorkflowRun: (
    runId: string,
    input: Record<string, unknown>,
    mode: WorkflowMode,
    turnId?: string,
  ) => void;
  restoreWorkflowRun: (projection: WorkflowRunProjection) => void;
  resumeWorkflowRun: () => void;
  applyRunEvents: (
    events: WorkflowRunEventEnvelope[],
    context: WorkflowRunEventContext,
  ) => void;
  projectFailedRun: (message: string) => void;
  clearRunningNode: () => void;
  clearToolApproval: () => void;
  clearHumanReview: () => void;
  clearAskUserQuestion: () => void;
};

export const useWorkflowRunStore = create<WorkflowRunStore>()(
  immer((set) => ({
    runPanelOpen: false,
    projection: createWorkflowRunProjection(),
    runningNodeId: null,
    showRunOutput: false,
    activeChatSession: undefined,
    setLastRunInput: (input) =>
      set((state) => {
        state.lastRunInput = input;
      }),
    setRunPanelOpen: (open) =>
      set((state) => {
        state.runPanelOpen = open;
      }),
    setRunningNodeId: (nodeId) =>
      set((state) => {
        state.runningNodeId = nodeId;
      }),
    setShowRunOutput: (show) =>
      set((state) => {
        state.showRunOutput = show;
      }),
    setActiveChatSession: (session) =>
      set((state) => {
        state.activeChatSession = session;
      }),
    resetRunView: () =>
      set((state) => {
        state.projection = createWorkflowRunProjection();
        state.runningNodeId = null;
      }),
    startWorkflowRun: (runId, input, mode, turnId) =>
      set((state) => {
        const projection =
          mode === 'chat' && state.projection.runId
            ? state.projection
            : createWorkflowRunProjection(runId);
        // A chat turn is a new run, but it belongs to the existing transcript.
        // Event sequence numbers are local to each durable run, so reset only
        // the live-run cursor and indexes rather than discarding prior turns.
        projection.runId = runId;
        projection.status = 'running';
        projection.startedAt = Date.now();
        projection.endedAt = undefined;
        projection.durationMs = undefined;
        projection.activeNodeId = undefined;
        projection.totalSteps = undefined;
        projection.finalState = undefined;
        projection.error = undefined;
        projection.contextCompactionStage = undefined;
        projection.eventSequence = -1;
        projection.latestExecutionIdByNode = {};
        projection.latestThoughtIdByNode = {};
        projection.resumePendingNodeIds = {};
        projection.activeMessageIdByNode = {};
        if (mode === 'chat') {
          const id = `${runId}:input:${turnId ?? 0}`;
          projection.messageIds.push(id);
          projection.messagesById[id] = {
            id,
            nodeId: 'You',
            content:
              typeof input.input === 'string'
                ? input.input
                : JSON.stringify(input.input ?? ''),
            isStreaming: false,
            role: 'user',
            turnId,
          };
          if (turnId) {
            projection.turnsById[turnId] = {
              status: 'running',
              startedAt: projection.startedAt,
            };
          }
        }
        state.lastRunInput = input;
        state.projection = projection;
        state.runningNodeId = null;
        state.runPanelOpen = true;
        state.showRunOutput = true;
      }),
    restoreWorkflowRun: (projection) =>
      set((state) => {
        state.projection = projection;
        state.runningNodeId = projection.activeNodeId ?? null;
        state.showRunOutput = true;
        state.runPanelOpen = true;
      }),
    resumeWorkflowRun: () =>
      set((state) => {
        state.projection.status = 'running';
        state.projection.endedAt = undefined;
        state.projection.error = undefined;
        state.projection.finalState = undefined;
      }),
    applyRunEvents: (events, context) =>
      set((state) => {
        for (const event of events)
          reduceWorkflowRunEvent(state.projection, event, context, state);
      }),
    projectFailedRun: (message) =>
      set((state) => {
        projectTerminal(
          state.projection,
          'failed',
          undefined,
          message,
          state.projection.messageIds.at(-1)
            ? state.projection.messagesById[state.projection.messageIds.at(-1)!]
                ?.turnId
            : undefined,
        );
        state.runningNodeId = null;
      }),
    clearRunningNode: () =>
      set((state) => {
        state.runningNodeId = null;
      }),
    clearToolApproval: () =>
      set((state) => {
        state.toolApproval = undefined;
      }),
    clearHumanReview: () =>
      set((state) => {
        state.humanReview = undefined;
      }),
    clearAskUserQuestion: () =>
      set((state) => {
        state.askUserQuestion = undefined;
      }),
  })),
);

function reduceWorkflowRunEvent(
  projection: WorkflowRunProjection,
  envelope: WorkflowRunEventEnvelope,
  context: WorkflowRunEventContext,
  transient?: Pick<
    WorkflowRunStore,
    'runningNodeId' | 'toolApproval' | 'humanReview' | 'askUserQuestion'
  >,
) {
  const event = envelope.event;
  if (
    event.type === 'custom' &&
    event.event_type === 'workflow.context_compaction'
  ) {
    const stage =
      typeof event.data === 'object' && event.data !== null
        ? (event.data as Record<string, unknown>).stage
        : undefined;
    if (stage === 'summarizing' || stage === 'ready' || stage === 'failed')
      projection.contextCompactionStage = stage;
    return;
  }
  if (envelope.sequence <= projection.eventSequence) return;
  projection.eventSequence = envelope.sequence;
  if (event.type === 'node_start') {
    const node = context.nodes.find((item) => item.id === event.node);
    const current = projection.nodesById[event.node];
    projection.nodesById[event.node] = {
      id: event.node,
      name: displayName(node),
      status: 'running',
      durationMs: current?.durationMs,
    };
    if (!current) projection.nodeIds.push(event.node);
    projection.activeNodeId = event.node;
    if (transient) transient.runningNodeId = event.node;
    const resuming = projection.resumePendingNodeIds[event.node] === true;
    delete projection.resumePendingNodeIds[event.node];
    const executionId = projection.latestExecutionIdByNode[event.node];
    const thoughtId = projection.latestThoughtIdByNode[event.node];
    if (resuming && executionId && thoughtId) {
      // A dynamic interrupt re-enters the same graph node after its action is
      // resolved. Keep one user-visible execution rather than rendering the
      // approval preflight and the resumed work as duplicate node rows.
      Object.assign(projection.executionsById[executionId], {
        status: 'running',
        durationMs: undefined,
      });
      Object.assign(projection.thoughtsById[thoughtId], {
        status: 'running',
        durationMs: undefined,
      });
    } else {
      const nextExecutionId = `${projection.runId ?? envelope.runId}:execution:${envelope.sequence}`;
      const nextThoughtId = `${projection.runId ?? envelope.runId}:thought:${envelope.sequence}`;
      projection.executionIds.push(nextExecutionId);
      projection.thoughtIds.push(nextThoughtId);
      projection.executionsById[nextExecutionId] = {
        nodeId: event.node,
        step: event.step,
        type: node?.type ?? 'node',
        status: 'running',
        turnId: context.turnId,
      };
      projection.thoughtsById[nextThoughtId] = {
        id: nextThoughtId,
        nodeId: event.node,
        status: 'running',
        turnId: context.turnId,
      };
      projection.latestExecutionIdByNode[event.node] = nextExecutionId;
      projection.latestThoughtIdByNode[event.node] = nextThoughtId;
    }
    return;
  }
  if (event.type === 'message')
    return appendMessage(projection, envelope, event, context);
  if (event.type === 'resumed') {
    projection.status = 'running';
    projection.error = undefined;
    if (context.turnId && projection.turnsById[context.turnId]) {
      projection.turnsById[context.turnId].status = 'running';
      projection.turnsById[context.turnId].error = undefined;
      projection.turnsById[context.turnId].endedAt = undefined;
    }
    // Only an explicit input interruption can merge execution rows. Recovery
    // after a failed attempt creates a new row even at the same graph frontier.
    return;
  }
  if (event.type === 'node_end') {
    const node = projection.nodesById[event.node];
    if (node)
      Object.assign(node, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    const execution = latestExecution(projection, event.node);
    if (execution)
      Object.assign(execution, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    const thought = latestThought(projection, event.node);
    if (thought?.status === 'running')
      Object.assign(thought, {
        status: 'completed',
        durationMs: event.duration_ms,
      });
    if (projection.activeNodeId === event.node)
      projection.activeNodeId = undefined;
    if (transient?.runningNodeId === event.node) transient.runningNodeId = null;
    const messageId = projection.activeMessageIdByNode[event.node];
    if (messageId && projection.messagesById[messageId])
      projection.messagesById[messageId].isStreaming = false;
    return;
  }
  if (event.type === 'custom')
    return applyCustom(projection, event, transient, context.turnId);
  if (event.type === 'done') {
    projectTerminal(
      projection,
      'completed',
      event.state,
      undefined,
      context.turnId,
    );
    projection.totalSteps = event.total_steps;
    if (context.turnId && projection.turnsById[context.turnId])
      projection.turnsById[context.turnId].totalSteps = event.total_steps;
  } else if (event.type === 'error') {
    // Attribute only explicit runtime errors; unrelated running parallel nodes
    // must not receive another node's traceback.
    const nodeId =
      event.node ??
      /Node ['`]([^'`]+)['`] execution failed/.exec(event.message)?.[1];
    const execution = nodeId ? latestExecution(projection, nodeId) : undefined;
    if (execution) {
      execution.status = 'failed';
      execution.error = event.message.replace(
        /Node ['`]([^'`]+)['`] execution failed/g,
        (match, id: string) => {
          const node = context.nodes.find((item) => item.id === id);
          return node ? `Node '${displayName(node)}' execution failed` : match;
        },
      );
    }
    projectTerminal(
      projection,
      'failed',
      undefined,
      event.message,
      context.turnId,
    );
  } else if (event.type === 'interrupted') {
    const awaitingInput = Boolean(
      transient?.toolApproval ||
      transient?.humanReview ||
      transient?.askUserQuestion,
    );
    if (event.node) projection.resumePendingNodeIds[event.node] = true;
    // A dynamic interrupt is the runtime's checkpoint signal for an approval
    // or review. It is not a failed workflow and must not surface its internal
    // reason as an error banner while the corresponding action is pending.
    projectTerminal(
      projection,
      'interrupted',
      undefined,
      awaitingInput ? undefined : event.message,
      context.turnId,
    );
  }
}

function latestExecution(projection: WorkflowRunProjection, nodeId: string) {
  const id = projection.latestExecutionIdByNode[nodeId];
  return id ? projection.executionsById[id] : undefined;
}
function latestThought(projection: WorkflowRunProjection, nodeId: string) {
  const id = projection.latestThoughtIdByNode[nodeId];
  return id ? projection.thoughtsById[id] : undefined;
}

function appendMessage(
  projection: WorkflowRunProjection,
  envelope: WorkflowRunEventEnvelope,
  event: Extract<WorkflowRunEvent, { type: 'message' }>,
  context: WorkflowRunEventContext,
) {
  const execution = latestExecution(projection, event.node);
  if (execution) {
    // Node messages belong to the execution that produced them in both task
    // and chat modes. Chat renders that execution directly below the user
    // turn, preventing all node responses from accumulating at the bottom.
    const messages = Array.isArray(execution.messages)
      ? execution.messages
      : [];
    const last = messages.at(-1) as Record<string, unknown> | undefined;
    if (typeof last?.content === 'string') last.content += event.content;
    else messages.push({ role: 'assistant', content: event.content });
    execution.messages = messages;
    return;
  }
  // Keep a normal assistant bubble only for transports that do not identify a
  // workflow node, because there is no execution row that can own the text.
  if (context.mode !== 'chat') return;
  const activeId = projection.activeMessageIdByNode[event.node];
  const active = activeId ? projection.messagesById[activeId] : undefined;
  if (active?.isStreaming) {
    active.content += event.content;
    active.isStreaming = !event.is_final;
    return;
  }
  const id = `${projection.runId ?? envelope.runId}:message:${envelope.sequence}`;
  projection.messageIds.push(id);
  projection.messagesById[id] = {
    id,
    nodeId: event.node,
    content: event.content,
    isStreaming: !event.is_final,
    role: 'assistant',
    turnId: context.turnId,
  };
  if (!event.is_final) projection.activeMessageIdByNode[event.node] = id;
}

function applyCustom(
  projection: WorkflowRunProjection,
  event: Extract<WorkflowRunEvent, { type: 'custom' }>,
  transient?: Pick<
    WorkflowRunStore,
    'toolApproval' | 'humanReview' | 'askUserQuestion'
  >,
  turnId?: string,
) {
  if (event.event_type === 'workflow.attempt_started') {
    // Keep previous outputs and execution rows; only the task's live status is
    // reset when another attempt starts within the same business task.
    projection.status = 'running';
    projection.error = undefined;
    projection.endedAt = undefined;
    projection.durationMs = undefined;
    projection.finalState = undefined;
    projection.activeNodeId = undefined;
    if (turnId && projection.turnsById[turnId]) {
      projection.turnsById[turnId].status = 'running';
      projection.turnsById[turnId].error = undefined;
    }
    return;
  }
  if (event.event_type === 'workflow.run_cancelled')
    return projectTerminal(
      projection,
      'cancelled',
      undefined,
      undefined,
      turnId,
    );
  if (typeof event.data !== 'object' || event.data === null) return;
  if (event.event_type === 'agent.tool_approval_required') {
    if (transient)
      transient.toolApproval = event.data as Record<string, unknown>;
    return;
  }
  if (event.event_type === 'workflow.human_review_required') {
    if (transient)
      transient.humanReview = event.data as Record<string, unknown>;
    return;
  }
  if (event.event_type === 'workflow.ask_user_question_required') {
    if (transient)
      transient.askUserQuestion = event.data as Record<string, unknown>;
    return;
  }
  if (event.event_type === 'remote.lifecycle') {
    const data = event.data as Record<string, unknown>;
    const execution =
      projection.executionIds
        .map((id) => projection.executionsById[id])
        .findLast(
          (item) => item.nodeId === event.node && item.step === data.ownerStep,
        ) ?? latestExecution(projection, event.node);
    if (!execution || typeof data.remoteRecordId !== 'string') return;
    const messages = Array.isArray(execution.messages)
      ? execution.messages
      : [];
    const existing = messages.find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).remoteLifecycle &&
        (
          (item as Record<string, unknown>).remoteLifecycle as Record<
            string,
            unknown
          >
        ).remoteRecordId === data.remoteRecordId,
    ) as Record<string, unknown> | undefined;
    const message = {
      role: 'assistant',
      content: `Remote task: ${String(data.status)}`,
      remoteLifecycle: data,
    };
    if (existing) Object.assign(existing, message);
    else messages.push(message);
    execution.messages = messages;
    return;
  }
  if (event.event_type === 'process.compensation') {
    const cleanup = event.data as Record<string, unknown>;
    const execution =
      projection.executionIds
        .map((id) => projection.executionsById[id])
        .findLast(
          (item) =>
            item.nodeId === event.node && item.step === cleanup.ownerStep,
        ) ?? latestExecution(projection, event.node);
    if (!execution || typeof cleanup.operationId !== 'string') return;
    const messages = Array.isArray(execution.messages)
      ? execution.messages
      : [];
    const existing = messages.find(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).compensation &&
        (
          (item as Record<string, unknown>).compensation as Record<
            string,
            unknown
          >
        ).operationId === cleanup.operationId,
    ) as Record<string, unknown> | undefined;
    const content = `Compensation · ${String(cleanup.appName)} · ${String(cleanup.entry)}: ${String(cleanup.status)}`;
    if (existing) {
      existing.content = content;
      existing.compensation = {
        ...(existing.compensation as Record<string, unknown>),
        ...cleanup,
        output:
          cleanup.output ??
          (existing.compensation as Record<string, unknown>).output,
      };
    } else messages.push({ role: 'assistant', content, compensation: cleanup });
    execution.messages = messages;
    return;
  }
  const execution = latestExecution(projection, event.node);
  if (!execution) return;
  if (
    event.event_type === 'agent.tool_result' ||
    event.event_type === 'agent.tool_denied'
  ) {
    const call = event.data as Record<string, unknown>;
    const tool = typeof call.tool === 'string' ? call.tool : undefined;
    const pending = Array.isArray(execution.pendingToolOutput)
      ? execution.pendingToolOutput
      : [];
    const output = pending.filter(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        (item as Record<string, unknown>).tool === tool,
    );
    execution.pendingToolOutput = pending.filter(
      (item) =>
        typeof item !== 'object' ||
        item === null ||
        (item as Record<string, unknown>).tool !== tool,
    );
    execution.toolCalls = [
      ...(Array.isArray(execution.toolCalls) ? execution.toolCalls : []),
      output.length ? { ...call, output } : call,
    ];
  } else if (event.event_type === 'agent.tool_output') {
    const { data, stream, tool } = event.data as Record<string, unknown>;
    if (
      (stream !== 'stdout' && stream !== 'stderr') ||
      typeof data !== 'string'
    )
      return;
    execution.pendingToolOutput = [
      ...(Array.isArray(execution.pendingToolOutput)
        ? execution.pendingToolOutput
        : []),
      {
        tool: typeof tool === 'string' ? tool : 'Tool',
        stream,
        data: truncate(data),
      },
    ];
  } else if (event.event_type === 'workflow.node_result') {
    const messages = execution.messages;
    const toolCalls = execution.toolCalls;
    Object.assign(execution, event.data);
    if (Array.isArray(messages) && messages.length)
      execution.messages = messages;
    if (Array.isArray(toolCalls) && toolCalls.length)
      execution.toolCalls = toolCalls;
  } else if (event.event_type === 'process.output') {
    const { stream, data, name } = event.data as Record<string, unknown>;
    if (
      (stream !== 'stdout' && stream !== 'stderr') ||
      typeof data !== 'string'
    )
      return;
    execution[stream] = truncate(
      `${(execution[stream] as string) ?? ''}${data}`,
    );
    const log = projection.processLogsByNode[event.node] ?? {
      nodeId: event.node,
      name: typeof name === 'string' ? name : event.node,
      stdout: '',
      stderr: '',
    };
    log[stream] = truncate(log[stream] + data);
    projection.processLogsByNode[event.node] = log;
  }
}

function projectTerminal(
  projection: WorkflowRunProjection,
  status: WorkflowRunStatus,
  finalState?: Record<string, unknown>,
  error?: string,
  turnId?: string,
) {
  projection.status = status;
  projection.activeNodeId = undefined;
  projection.finalState = finalState;
  projection.error = error;
  if (turnId) {
    const startedAt = projection.turnsById[turnId]?.startedAt;
    const endedAt = Date.now();
    projection.turnsById[turnId] = {
      status,
      startedAt,
      endedAt,
      durationMs: startedAt ? endedAt - startedAt : undefined,
      finalState,
      error,
    };
  }
  const entityStatus =
    status === 'completed'
      ? 'completed'
      : status === 'cancelled'
        ? 'cancelled'
        : 'failed';
  for (const id of projection.nodeIds) {
    const node = projection.nodesById[id];
    if (node.status === 'running') node.status = entityStatus;
  }
  for (const id of projection.executionIds) {
    const execution = projection.executionsById[id];
    if (execution.status === 'running') execution.status = entityStatus;
  }
  for (const id of projection.thoughtIds) {
    const thought = projection.thoughtsById[id];
    if (thought.status === 'running') thought.status = entityStatus;
  }
  for (const id of projection.messageIds)
    projection.messagesById[id].isStreaming = false;
}

function displayName(node?: Node) {
  const data = node?.data;
  return typeof data?.workflowName === 'string' && data.workflowName.trim()
    ? data.workflowName
    : typeof data?.name === 'string' && data.name.trim()
      ? data.name
      : typeof data?.label === 'string' && data.label.trim()
        ? data.label
        : typeof data?.title === 'string' && data.title.trim()
          ? data.title
          : (node?.id ?? '');
}
function truncate(value: string) {
  return value.length <= 200_000
    ? value
    : `[Earlier output truncated]\n${value.slice(-200_000)}`;
}
