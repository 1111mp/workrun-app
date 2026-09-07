import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { DependencySyncResult } from '@/services/runtime';

export type ProcessNodeInstallStatus = 'notInstalled' | 'installed' | 'invalid';
export type ProcessNodeKind = 'workflow' | 'tool';
export type ToolExecutionPolicy = 'ask_every_time' | 'auto';
export type ToolRiskLevel = 'low' | 'medium' | 'high';

export type ProcessNodeDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
  projectRoot?: string;
  kind: ProcessNodeKind;
  toolExecutionPolicy: ToolExecutionPolicy;
  toolRiskLevel?: ToolRiskLevel;
  toolPermissions?: string[];
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

export type ProcessNode = {
  definition: ProcessNodeDefinition;
  projectPath: string;
  installStatus: ProcessNodeInstallStatus;
  installError?: string;
};

export type ProcessNodeWorkflowReference = {
  id: string;
  name: string;
};

export type CreateProcessNodeRequest = Pick<
  ProcessNodeDefinition,
  'name' | 'description' | 'kind' | 'projectRoot'
>;

export type ProcessNodeCreateStage =
  | 'creatingProject'
  | 'addingSdkDependency'
  | 'initializingEnvironment'
  | 'savingApp'
  | 'completed';

export type ProcessNodeCreateProgress = {
  stage: ProcessNodeCreateStage;
};

export type ProcessNodeOutputStream = 'stdout' | 'stderr';

export type ProcessNodeOutputChunk = {
  stream: ProcessNodeOutputStream;
  data: string;
};

export type ProcessNodeRunResult = {
  sync: DependencySyncResult;
  execution: {
    scriptPath: string;
    exitCode: number | null;
  };
};

export type BackgroundProcessNodeRunRequest = {
  runId: string;
  targetId: string;
  targetName: string;
  outputView: unknown;
  targetSnapshot: unknown;
};

export type ProcessNodeRunEvent =
  | { type: 'output'; stream: ProcessNodeOutputStream; data: string }
  | { type: 'app_done'; execution: ProcessNodeRunResult['execution'] }
  | { type: 'app_cancelled' }
  | { type: 'error'; message: string };

export function listProcessNodes() {
  return invoke<ProcessNode[]>('process_node_list');
}

export function inspectProcessNode(id: string) {
  return invoke<ProcessNode>('process_node_inspect', { id });
}

export function openProcessNodeProject(id: string) {
  return invoke('process_node_open_project', { id });
}

export function getProcessNodeDefaultRoot() {
  return invoke<string>('process_node_default_root');
}

export function createProcessNode(
  request: CreateProcessNodeRequest,
  onProgress: (progress: ProcessNodeCreateProgress) => void,
) {
  const progress = new Channel<ProcessNodeCreateProgress>();
  progress.onmessage = onProgress;
  return invoke<ProcessNode>('process_node_create', { request, progress });
}

export function updateProcessNode(definition: ProcessNodeDefinition) {
  return invoke<ProcessNode>('process_node_update', { definition });
}

export function deleteProcessNode(id: string, deleteProjectFiles: boolean) {
  return invoke('process_node_delete', { id, deleteProjectFiles });
}

export function listProcessNodeWorkflowReferences(id: string) {
  return invoke<ProcessNodeWorkflowReference[]>(
    'process_node_workflow_references',
    { id },
  );
}

/** Synchronize and run an installed Process Node using its catalog entrypoint. */
export function runProcessNode(
  id: string,
  onOutput: (chunk: ProcessNodeOutputChunk) => void,
) {
  const output = new Channel<ProcessNodeOutputChunk>();
  output.onmessage = onOutput;
  return invoke<ProcessNodeRunResult>('process_node_run', { id, output });
}

export function startBackgroundProcessNodeRun(
  request: BackgroundProcessNodeRunRequest,
) {
  return invoke('process_node_run_start', { request });
}

export function cancelBackgroundProcessNodeRun(runId: string) {
  return invoke('process_node_run_cancel', { runId });
}

export function subscribeProcessNodeRun(
  runId: string,
  onEvent: (event: ProcessNodeRunEvent) => void,
): Promise<UnlistenFn> {
  return listen<{ runId: string; event: ProcessNodeRunEvent }>(
    'run-event',
    ({ payload }) => {
      if (payload.runId === runId) onEvent(payload.event);
    },
  );
}
