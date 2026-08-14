import { Channel, invoke } from '@tauri-apps/api/core';
import type { Edge, Node } from '@xyflow/react';

const workflowDocumentStorageKey = 'workrun.workflow.document';

export type WorkflowDocument = {
  nodes: Node[];
  edges: Edge[];
  settings: WorkflowSettings;
};

type WorkflowPlanEdge = {
  source: string;
  target: string;
  route?: string;
};

export type WorkflowPlan = {
  workflowId: string;
  workflowName: string;
  executableNodes: string[];
  edges: WorkflowPlanEdge[];
};

export type WorkflowRunResult = {
  plan: WorkflowPlan;
  state: Record<string, unknown>;
};

/** Ordered runtime events emitted while a workflow is executing. */
export type WorkflowRunEvent =
  | { type: 'state'; state: Record<string, unknown>; step: number }
  | {
      type: 'updates';
      node: string;
      updates: Record<string, unknown>;
    }
  | { type: 'node_start'; node: string; step: number }
  | { type: 'node_end'; node: string; step: number; duration_ms: number }
  | { type: 'message'; node: string; content: string; is_final: boolean }
  | { type: 'custom'; node: string; event_type: string; data: unknown }
  | { type: 'debug'; event_type: string; data: unknown }
  | { type: 'step_complete'; step: number; nodes_executed: string[] }
  | { type: 'interrupted'; node: string; message: string }
  | { type: 'resumed'; step: number; pending_nodes: string[] }
  | { type: 'done'; state: Record<string, unknown>; total_steps: number }
  | { type: 'error'; message: string; node: string | null }
  | { type: 'route_dispatched'; source: string; targets: string[] };

export type WorkflowRunStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type WorkflowRunMessage = {
  id: string;
  nodeId: string;
  content: string;
  isStreaming: boolean;
  role?: 'user' | 'assistant';
  /** Groups a chat message with the execution steps that produced it. */
  turnId?: string;
};

export type WorkflowRunThought = {
  id: string;
  nodeId: string;
  status: 'running' | 'completed' | 'failed';
  durationMs?: number;
  /** The chat turn this step belongs to. */
  turnId?: string;
};

export type WorkflowRunNode = {
  id: string;
  name?: string;
  status: 'running' | 'completed' | 'failed';
  durationMs?: number;
};

export type WorkflowProcessLog = {
  nodeId: string;
  name: string;
  stdout: string;
  stderr: string;
};

export type WorkflowRunView = {
  status: WorkflowRunStatus;
  startedAt?: number;
  endedAt?: number;
  activeNodeId?: string;
  totalSteps?: number;
  nodes: WorkflowRunNode[];
  messages: WorkflowRunMessage[];
  thoughts: WorkflowRunThought[];
  processLogs: WorkflowProcessLog[];
  finalState?: Record<string, unknown>;
  error?: string;
};

/**
 * Removes React Flow-only fields (position, selection, dimensions, etc.) so
 * the desktop command receives a stable workflow runtime DSL.
 */
export function toWorkflowDsl(
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
): Workflow {
  return {
    id: 'workflow',
    name: settings.name,
    description: settings.description || undefined,
    mode: settings.mode,
    inputSchema: settings.inputSchema,
    nodes: nodes.map(({ id, type, data }) => ({
      id,
      type: type as WorkflowNodeType,
      data,
    })) as WorkflowNode[],
    edges: edges.map(({ source, target, sourceHandle }) => ({
      source,
      target,
      sourceHandle,
    })),
  };
}

/**
 * Creates the editor document used for local persistence. Runtime-only React
 * Flow fields are excluded so opening a saved workflow does not look dirty.
 */
export function toWorkflowDocument(
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
): WorkflowDocument {
  return {
    nodes: nodes.map(
      ({
        selected: _selected,
        width: _width,
        height: _height,
        measured: _measured,
        ...node
      }) => node as Node,
    ),
    edges: edges.map(({ selected: _selected, ...edge }) => edge as Edge),
    settings,
  };
}

export function loadWorkflowDocument(): WorkflowDocument | null {
  try {
    const saved = window.localStorage.getItem(workflowDocumentStorageKey);
    if (!saved) return null;

    const document: unknown = JSON.parse(saved);
    if (
      typeof document !== 'object' ||
      document === null ||
      !Array.isArray((document as WorkflowDocument).nodes) ||
      !Array.isArray((document as WorkflowDocument).edges) ||
      typeof (document as WorkflowDocument).settings !== 'object' ||
      (document as WorkflowDocument).settings === null
    ) {
      return null;
    }

    return document as WorkflowDocument;
  } catch {
    return null;
  }
}

export function saveWorkflowDocument(document: WorkflowDocument) {
  window.localStorage.setItem(
    workflowDocumentStorageKey,
    JSON.stringify(document),
  );
}

export function compileWorkflow(dsl: Workflow) {
  return invoke<WorkflowPlan>('workflow_compile', { dsl });
}

export function runWorkflow(
  dsl: Workflow,
  initialState: Record<string, unknown> = {},
  threadId?: string,
  onEvent?: (event: WorkflowRunEvent) => void,
) {
  console.log('dsl', dsl);
  const channel = new Channel<WorkflowRunEvent>();
  channel.onmessage = (event) => onEvent?.(event);

  return invoke<WorkflowRunResult>('workflow_run', {
    dsl,
    initialState,
    threadId,
    onEvent: channel,
  });
}
