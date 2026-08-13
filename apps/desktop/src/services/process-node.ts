import { Channel, invoke } from '@tauri-apps/api/core';

import type { DependencySyncResult } from '@/services/runtime';

export type ProcessNodeInstallStatus = 'notInstalled' | 'installed' | 'invalid';

export type ProcessNodeDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
  createdAt: string;
  updatedAt: string;
  entry: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
};

export type ProcessNode = {
  definition: ProcessNodeDefinition;
  projectPath: string;
  installStatus: ProcessNodeInstallStatus;
  installError?: string;
};

export type CreateProcessNodeRequest = Pick<
  ProcessNodeDefinition,
  'name' | 'description'
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

export function listProcessNodes() {
  return invoke<ProcessNode[]>('process_node_list');
}

export function inspectProcessNode(id: string) {
  return invoke<ProcessNode>('process_node_inspect', { id });
}

export function openProcessNodeProject(id: string) {
  return invoke('process_node_open_project', { id });
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

/** Synchronize and run an installed Process Node using its catalog entrypoint. */
export function runProcessNode(
  id: string,
  onOutput: (chunk: ProcessNodeOutputChunk) => void,
) {
  const output = new Channel<ProcessNodeOutputChunk>();
  output.onmessage = onOutput;
  return invoke<ProcessNodeRunResult>('process_node_run', { id, output });
}
