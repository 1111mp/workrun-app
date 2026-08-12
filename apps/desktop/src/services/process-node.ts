import { Channel, invoke } from '@tauri-apps/api/core';

import type { DependencySyncResult } from '@/services/runtime';

export type ProcessNodeInstallStatus = 'notInstalled' | 'installed' | 'invalid';

export type ProcessNodeDefinition = {
  id: string;
  name: string;
  description: string;
  version: string;
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

/** Synchronize and run an installed Process Node using its catalog entrypoint. */
export function runProcessNode(
  id: string,
  onOutput: (chunk: ProcessNodeOutputChunk) => void,
) {
  const output = new Channel<ProcessNodeOutputChunk>();
  output.onmessage = onOutput;
  return invoke<ProcessNodeRunResult>('process_node_run', { id, output });
}
