import { invoke } from '@tauri-apps/api/core';
import type { Edge, Node } from '@xyflow/react';

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

/**
 * Removes React Flow-only fields (position, selection, dimensions, etc.) so
 * the desktop command receives a stable, persistable workflow DSL.
 */
export function toWorkflowDsl(nodes: Node[], edges: Edge[]): Workflow {
  return {
    id: 'workflow',
    name: 'Untitled workflow',
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

export function compileWorkflow(dsl: Workflow) {
  return invoke<WorkflowPlan>('workflow_compile', { dsl });
}

export function runWorkflow(
  dsl: Workflow,
  initialState: Record<string, unknown> = {},
  threadId?: string,
) {
  return invoke<WorkflowRunResult>('workflow_run', {
    dsl,
    initialState,
    threadId,
  });
}
