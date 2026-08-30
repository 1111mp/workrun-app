import { Channel, invoke } from '@tauri-apps/api/core';
import type { Edge, Node } from '@xyflow/react';

const workflowDocumentStorageKey = 'workrun.workflow.document';

export type WorkflowDocument = {
  nodes: Node[];
  edges: Edge[];
  settings: WorkflowSettings;
};

export type StoredWorkflow = {
  id: string;
  createdAt: string;
  updatedAt: string;
  document: WorkflowDocument;
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

/** Complete observer view returned when a workflow stops. Node ACLs affect
 * execution inputs only; every node namespace is available for display. */
export type WorkflowFinalState = {
  global: Record<string, unknown>;
  nodes: Record<string, Record<string, unknown>>;
  workflow: Record<string, unknown>;
};

export type WorkflowRunResult = {
  plan: WorkflowPlan;
  state: WorkflowFinalState;
  interrupted: boolean;
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

export type WorkflowRunExecution = {
  nodeId: string;
  type: string;
  status: 'running' | 'completed' | 'failed';
  durationMs?: number;
  /** The chat turn this execution belongs to. */
  turnId?: string;
  [key: string]: unknown;
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
  execution: WorkflowRunExecution[];
  finalState?: Record<string, unknown>;
  error?: string;
};

/**
 * Removes React Flow-only fields (position, selection, dimensions, etc.) so
 * the desktop command receives a stable workflow runtime DSL.
 */
export function toWorkflowDsl(
  id: string,
  nodes: Node[],
  edges: Edge[],
  settings: WorkflowSettings,
): Workflow {
  return {
    id,
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

export function createWorkflowDocument(
  name = 'Untitled workflow',
): WorkflowDocument {
  return {
    nodes: [
      {
        id: 'start-node-default',
        type: 'start',
        position: { x: 100, y: 200 },
        data: { label: 'Start' },
      },
    ],
    edges: [],
    settings: {
      name,
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
  };
}

export function loadLegacyWorkflowDocument(): WorkflowDocument | null {
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

export function clearLegacyWorkflowDocument() {
  window.localStorage.removeItem(workflowDocumentStorageKey);
}

export function listWorkflows() {
  return invoke<StoredWorkflow[]>('workflow_catalog_list');
}

export function createWorkflow(document: WorkflowDocument) {
  return invoke<StoredWorkflow>('workflow_catalog_create', { document });
}

export function inspectWorkflow(id: string) {
  return invoke<StoredWorkflow>('workflow_catalog_inspect', { id });
}

export function updateWorkflow(id: string, document: WorkflowDocument) {
  return invoke<StoredWorkflow>('workflow_catalog_update', { id, document });
}

export function compileWorkflow(dsl: Workflow) {
  return invoke<WorkflowPlan>('workflow_compile', { dsl });
}

export function runWorkflow(
  dsl: Workflow,
  initialState: Record<string, unknown> = {},
  threadId?: string,
  resume = false,
  onEvent?: (event: WorkflowRunEvent) => void,
) {
  const channel = new Channel<WorkflowRunEvent>();
  channel.onmessage = (event) => onEvent?.(event);

  return invoke<WorkflowRunResult>('workflow_run', {
    dsl,
    initialState,
    threadId,
    resume,
    onEvent: channel,
  });
}

export function resolveToolApproval(
  requestId: string,
  fingerprint: string,
  approved: boolean,
) {
  return invoke('workflow_resolve_tool_approval', {
    requestId,
    fingerprint,
    approved,
  });
}

export function resolveHumanReview(
  dsl: Workflow,
  threadId: string,
  nodeId: string,
  approved: boolean,
  edits: Record<string, string> = {},
) {
  return invoke('workflow_resolve_human_review', {
    dsl,
    threadId,
    nodeId,
    approved,
    edits,
  });
}

export function resolveAskUserQuestion(
  dsl: Workflow,
  threadId: string,
  nodeId: string,
  optionId: string,
) {
  return invoke('workflow_resolve_ask_user_question', {
    dsl,
    threadId,
    nodeId,
    optionId,
  });
}
