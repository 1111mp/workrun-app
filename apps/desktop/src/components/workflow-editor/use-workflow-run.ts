import { useMutation } from '@tanstack/react-query';
import type { Edge, Node } from '@xyflow/react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  resolveToolApproval,
  runWorkflow,
  toWorkflowDsl,
  type WorkflowRunEvent,
  type WorkflowRunView,
} from '@/services/workflow';

const initialRunView: WorkflowRunView = {
  status: 'idle',
  nodes: [],
  messages: [],
  thoughts: [],
  processLogs: [],
  execution: [],
};

const MAX_PROCESS_LOG_CHARS = 200_000;

function appendProcessLog(current: string, chunk: string) {
  const next = current + chunk;
  return next.length <= MAX_PROCESS_LOG_CHARS
    ? next
    : `[Earlier output truncated]\n${next.slice(-MAX_PROCESS_LOG_CHARS)}`;
}

function latestExecutionIndex(
  execution: WorkflowRunView['execution'],
  nodeId: string,
) {
  return execution.reduce(
    (lastIndex, entry, index) => (entry.nodeId === nodeId ? index : lastIndex),
    -1,
  );
}

function runningNode(
  nodes: WorkflowRunView['nodes'],
  nodeId: string,
  name: string,
): WorkflowRunView['nodes'] {
  const existing = nodes.find((node) => node.id === nodeId);
  if (existing) {
    return nodes.map((node) =>
      node.id === nodeId ? { ...node, status: 'running' } : node,
    );
  }

  return [...nodes, { id: nodeId, name, status: 'running' }];
}

function finishNode(
  nodes: WorkflowRunView['nodes'],
  nodeId: string,
  durationMs?: number,
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['nodes'] {
  const existing = nodes.find((node) => node.id === nodeId);
  if (existing) {
    return nodes.map((node) =>
      node.id === nodeId ? { ...node, status, durationMs } : node,
    );
  }

  return [{ id: nodeId, status, durationMs }, ...nodes];
}

function startThought(
  thoughts: WorkflowRunView['thoughts'],
  nodeId: string,
  turnId?: string,
): WorkflowRunView['thoughts'] {
  return [
    ...thoughts,
    { id: crypto.randomUUID(), nodeId, status: 'running', turnId },
  ];
}

function finishThought(
  thoughts: WorkflowRunView['thoughts'],
  nodeId: string,
  durationMs?: number,
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['thoughts'] {
  for (let index = thoughts.length - 1; index >= 0; index -= 1) {
    const thought = thoughts[index];
    if (thought.nodeId === nodeId && thought.status === 'running') {
      return thoughts.map((item, itemIndex) =>
        itemIndex === index ? { ...item, status, durationMs } : item,
      );
    }
  }

  return thoughts;
}

function settleThoughts(
  thoughts: WorkflowRunView['thoughts'],
  status: 'completed' | 'failed' = 'completed',
): WorkflowRunView['thoughts'] {
  return thoughts.map((thought) =>
    thought.status === 'running' ? { ...thought, status } : thought,
  );
}

function nodeDisplayName(nodes: Node[], nodeId: string) {
  const data = nodes.find((node) => node.id === nodeId)?.data;
  if (!data) return nodeId;
  if (typeof data.name === 'string' && data.name.trim()) return data.name;
  return typeof data.label === 'string' && data.label.trim()
    ? data.label
    : nodeId;
}

function useWorkflowRun(
  workflowId: string,
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
) {
  const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  const [showRunOutput, setShowRunOutput] = useState(false);
  const [runView, setRunView] = useState<WorkflowRunView>(initialRunView);
  const [lastRunInput, setLastRunInput] = useState<Record<string, unknown>>();
  const [toolApproval, setToolApproval] = useState<Record<string, unknown>>();
  const chatThreadId = useRef<string | undefined>(undefined);
  const chatTurnId = useRef<string | undefined>(undefined);

  const handleRunEvent = (event: WorkflowRunEvent) => {
    switch (event.type) {
      case 'node_start': {
        const name = nodeDisplayName(nodes, event.node);
        setRunningNodeId(event.node);
        setRunView((current) => ({
          ...current,
          activeNodeId: event.node,
          nodes: runningNode(current.nodes, event.node, name),
          execution: [
            ...current.execution,
            {
              nodeId: event.node,
              type:
                nodes.find((node) => node.id === event.node)?.type ?? 'node',
              status: 'running',
              turnId: chatTurnId.current,
            },
          ],
          thoughts: startThought(
            current.thoughts,
            event.node,
            chatTurnId.current,
          ),
        }));
        return;
      }
      case 'node_end':
        setRunView((current) => {
          const entryIndex = latestExecutionIndex(
            current.execution,
            event.node,
          );
          return {
            ...current,
            activeNodeId:
              current.activeNodeId === event.node
                ? undefined
                : current.activeNodeId,
            nodes: finishNode(current.nodes, event.node, event.duration_ms),
            execution: current.execution.map((entry, index) =>
              index === entryIndex
                ? {
                    ...entry,
                    status: 'completed',
                    durationMs: event.duration_ms,
                  }
                : entry,
            ),
            thoughts: finishThought(
              current.thoughts,
              event.node,
              event.duration_ms,
            ),
            messages: current.messages.map((message) =>
              message.nodeId === event.node
                ? { ...message, isStreaming: false }
                : message,
            ),
          };
        });
        return;
      case 'message':
        if (!event.content) return;
        if (settings.mode !== 'chat') {
          setRunView((current) => {
            const entryIndex = latestExecutionIndex(
              current.execution,
              event.node,
            );
            if (entryIndex === -1) return current;
            const entry = current.execution[entryIndex];
            const messages = Array.isArray(entry.messages)
              ? [...entry.messages]
              : [];
            const lastMessage = messages.at(-1);
            if (
              typeof lastMessage === 'object' &&
              lastMessage !== null &&
              typeof (lastMessage as Record<string, unknown>).content ===
                'string'
            ) {
              messages[messages.length - 1] = {
                ...(lastMessage as Record<string, unknown>),
                content:
                  (lastMessage as Record<string, string>).content +
                  event.content,
              };
            } else {
              messages.push({ role: 'assistant', content: event.content });
            }
            return {
              ...current,
              execution: current.execution.map((item, index) =>
                index === entryIndex ? { ...item, messages } : item,
              ),
            };
          });
          return;
        }
        setRunView((current) => {
          const lastMessage = current.messages.at(-1);
          if (lastMessage?.nodeId === event.node && lastMessage.isStreaming) {
            return {
              ...current,
              messages: [
                ...current.messages.slice(0, -1),
                {
                  ...lastMessage,
                  content: lastMessage.content + event.content,
                  isStreaming: !event.is_final,
                  turnId: chatTurnId.current,
                },
              ],
            };
          }
          return {
            ...current,
            messages: [
              ...current.messages,
              {
                id: crypto.randomUUID(),
                nodeId: event.node,
                content: event.content,
                isStreaming: !event.is_final,
                role: 'assistant',
                turnId: chatTurnId.current,
              },
            ],
          };
        });
        return;
      case 'custom':
        if (typeof event.data !== 'object' || event.data === null) return;
        if (event.event_type === 'agent.tool_approval_required') {
          setToolApproval(event.data as Record<string, unknown>);
          return;
        }
        if (event.event_type === 'agent.tool_result') {
          const toolCall = event.data as Record<string, unknown>;
          setRunView((current) => {
            const entryIndex = latestExecutionIndex(
              current.execution,
              event.node,
            );
            if (entryIndex === -1) return current;
            const entry = current.execution[entryIndex];
            const toolCalls = Array.isArray(entry.toolCalls)
              ? entry.toolCalls
              : [];
            return {
              ...current,
              execution: current.execution.map((item, index) =>
                index === entryIndex
                  ? { ...item, toolCalls: [...toolCalls, toolCall] }
                  : item,
              ),
            };
          });
          return;
        }
        if (event.event_type === 'workflow.node_result') {
          const result = event.data as Record<string, unknown>;
          setRunView((current) => {
            const entryIndex = latestExecutionIndex(
              current.execution,
              event.node,
            );
            return {
              ...current,
              execution: current.execution.map((entry, index) =>
                index === entryIndex
                  ? {
                      ...entry,
                      ...result,
                      ...(Array.isArray(entry.messages) &&
                      entry.messages.length > 0
                        ? { messages: entry.messages }
                        : {}),
                    }
                  : entry,
              ),
            };
          });
          return;
        }
        if (event.event_type !== 'process.output') return;
        {
          const stream = (event.data as Record<string, unknown>).stream;
          const data = (event.data as Record<string, unknown>).data;
          const name = (event.data as Record<string, unknown>).name;
          if (
            (stream !== 'stdout' && stream !== 'stderr') ||
            typeof data !== 'string'
          )
            return;
          setRunView((current) => {
            const entryIndex = latestExecutionIndex(
              current.execution,
              event.node,
            );
            const existing = current.processLogs.find(
              (log) => log.nodeId === event.node,
            );
            const log = existing ?? {
              nodeId: event.node,
              name: typeof name === 'string' ? name : event.node,
              stdout: '',
              stderr: '',
            };
            const updated = {
              ...log,
              [stream]: appendProcessLog(log[stream], data),
            };
            return {
              ...current,
              execution: current.execution.map((entry, index) =>
                index === entryIndex
                  ? {
                      ...entry,
                      [stream]: appendProcessLog(
                        String(entry[stream] ?? ''),
                        data,
                      ),
                    }
                  : entry,
              ),
              processLogs: existing
                ? current.processLogs.map((item) =>
                    item.nodeId === event.node ? updated : item,
                  )
                : [...current.processLogs, updated],
            };
          });
        }
        return;
      case 'done':
        setRunView((current) => ({
          ...current,
          status: 'completed',
          activeNodeId: undefined,
          endedAt: Date.now(),
          totalSteps: event.total_steps,
          finalState: event.state,
          thoughts: settleThoughts(current.thoughts),
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      case 'error':
        setRunView((current) => ({
          ...current,
          status: 'failed',
          activeNodeId: undefined,
          endedAt: Date.now(),
          error: event.message,
          nodes: event.node
            ? finishNode(current.nodes, event.node, undefined, 'failed')
            : current.nodes,
          thoughts: event.node
            ? finishThought(current.thoughts, event.node, undefined, 'failed')
            : current.thoughts,
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      case 'interrupted':
        setRunView((current) => ({
          ...current,
          status: 'interrupted',
          activeNodeId: undefined,
          endedAt: Date.now(),
          error: event.message,
          thoughts: settleThoughts(current.thoughts, 'failed'),
          messages: current.messages.map((message) => ({
            ...message,
            isStreaming: false,
          })),
        }));
        return;
      default:
        return;
    }
  };

  const runMutation = useMutation({
    mutationFn: (initialState: Record<string, unknown>) =>
      runWorkflow(
        toWorkflowDsl(workflowId, nodes, edges, settings),
        initialState,
        settings.mode === 'chat' ? chatThreadId.current : crypto.randomUUID(),
        handleRunEvent,
      ),
    onSuccess: (result) => {
      setRunView((current) => ({
        ...current,
        status: 'completed',
        activeNodeId: undefined,
        endedAt: current.endedAt ?? Date.now(),
        finalState: result.state,
        thoughts: settleThoughts(current.thoughts),
        messages: current.messages.map((message) => ({
          ...message,
          isStreaming: false,
        })),
      }));
      const lastNode = result.state['workflow.last_node'];
      toast.success('Workflow completed', {
        toasterId: 'global',
        description:
          typeof lastNode === 'string'
            ? `Finished at node ${lastNode}.`
            : undefined,
      });
    },
    onError: (error) => {
      setRunView((current) => ({
        ...current,
        status: 'failed',
        activeNodeId: undefined,
        endedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
        thoughts: settleThoughts(current.thoughts, 'failed'),
        messages: current.messages.map((message) => ({
          ...message,
          isStreaming: false,
        })),
      }));
      toast.error('Workflow failed', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
    onSettled: () => setRunningNodeId(null),
  });

  const startWorkflowRun = (initialState: Record<string, unknown>) => {
    const turnId = settings.mode === 'chat' ? crypto.randomUUID() : undefined;
    chatTurnId.current = turnId;
    const inputContent =
      typeof initialState.input === 'string'
        ? initialState.input
        : (JSON.stringify(initialState.input ?? '') ?? '');
    setLastRunInput(initialState);
    setRunView((current) =>
      settings.mode === 'chat'
        ? {
            ...current,
            status: 'running',
            startedAt: Date.now(),
            endedAt: undefined,
            activeNodeId: undefined,
            finalState: undefined,
            error: undefined,
            nodes: [],
            execution: [],
            messages: [
              ...current.messages,
              {
                id: crypto.randomUUID(),
                nodeId: 'You',
                content: inputContent,
                isStreaming: false,
                role: 'user',
                turnId,
              },
            ],
          }
        : {
            status: 'running',
            startedAt: Date.now(),
            nodes: [],
            messages: [],
            thoughts: [],
            processLogs: [],
            execution: [],
          },
    );
    setRunPanelOpen(true);
    setShowRunOutput(true);
    runMutation.mutate(initialState);
  };

  const startRun = () => {
    if (settings.mode === 'chat') {
      chatThreadId.current = crypto.randomUUID();
      setRunView(initialRunView);
      setRunPanelOpen(true);
      return;
    }
    if (settings.mode === 'task' && settings.inputSchema.fields.length === 0) {
      startWorkflowRun({});
      return;
    }
    setShowRunOutput(false);
    setRunPanelOpen(true);
  };

  const resolvePendingToolApproval = async (approved: boolean) => {
    const requestId = toolApproval?.requestId;
    if (typeof requestId !== 'string') return;
    setToolApproval(undefined);
    await resolveToolApproval(requestId, approved);
  };

  return {
    isRunning: runMutation.isPending,
    lastRunInput,
    runPanelOpen,
    runView,
    setRunPanelOpen,
    showRunOutput,
    startRun,
    startWorkflowRun,
    runningNodeId,
    toolApproval,
    resolvePendingToolApproval,
  };
}

export { useWorkflowRun };
