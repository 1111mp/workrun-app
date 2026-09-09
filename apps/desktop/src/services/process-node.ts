import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { readFile, remove } from '@tauri-apps/plugin-fs';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';
import type { DependencySyncResult } from '@/services/runtime';

export type ProcessNodeInstallStatus =
  | 'draft'
  | 'notInstalled'
  | 'installed'
  | 'invalid';
export type ProcessNodeKind = 'workflow' | 'tool';
export type ToolExecutionPolicy = 'ask_every_time' | 'auto';
export type ToolRiskLevel = 'low' | 'medium' | 'high';
export type ProcessNodePublicationStatus = 'draft' | 'published';

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
  publicationStatus?: ProcessNodePublicationStatus;
  remoteAppId?: string;
};

export type ProcessNode = {
  definition: ProcessNodeDefinition;
  projectPath: string;
  installStatus: ProcessNodeInstallStatus;
  installError?: string;
};

type ProcessNodeSourceArchive = {
  path: string;
  sha256: string;
  size: number;
};

type TeamApp = ProcessNodeDefinition;

type TeamAppList = {
  items: TeamApp[];
  nextCursor?: string;
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

export async function getProcessNodes() {
  if (isTeamMode()) {
    const [localNodes, remote] = await Promise.all([
      invoke<ProcessNode[]>('get_process_nodes'),
      fetchApi.get<TeamAppList>('/api/v1/app'),
    ]);
    const nodes = new Map<string, ProcessNode>(
      remote.items.map((definition) => [
        definition.id,
        {
          definition: {
            ...definition,
            inputs: definition.inputs ?? {},
            outputs: definition.outputs ?? {},
          },
          projectPath: '',
          installStatus: 'notInstalled' as const,
        },
      ]),
    );

    // A local App is authoritative for its project path and install state. Once
    // published, use its remote ID as the map key so it replaces, rather than
    // duplicates, the matching server catalog entry.
    localNodes.forEach((node) => {
      nodes.set(node.definition.remoteAppId ?? node.definition.id, node);
    });
    return [...nodes.values()];
  }

  return await invoke<ProcessNode[]>('get_process_nodes');
}

export function getProcessNode(id: string) {
  return invoke<ProcessNode>('get_process_node', { id });
}

export function getProcessNodeProjectVersion(id: string) {
  return invoke<string | null>('process_node_project_version', { id });
}

export function setProcessNodeProjectVersion(id: string, version: string) {
  return invoke('process_node_set_project_version', { id, version });
}

export function getProcessNodeSourceArchive(id: string) {
  return invoke<ProcessNodeSourceArchive>('process_node_source_archive', { id });
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
  return invoke<ProcessNode>('create_process_node', { request, progress });
}

export function updateProcessNode(definition: ProcessNodeDefinition) {
  return invoke<ProcessNode>('update_process_node', { definition });
}

function publishRequest(definition: ProcessNodeDefinition) {
  // These fields identify local authoring state and are not part of the
  // server-owned App definition.
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    projectRoot: _projectRoot,
    publicationStatus: _publicationStatus,
    remoteAppId: _remoteAppId,
    ...request
  } = definition;
  return request;
}

export function publishProcessNode(definition: ProcessNodeDefinition) {
  return fetchApi.post<{ id: string }>('/api/v1/app', publishRequest(definition));
}

export function updatePublishedProcessNode(
  remoteAppId: string,
  definition: ProcessNodeDefinition,
) {
  return fetchApi.patch<{ id: string }>(
    `/api/v1/app/${remoteAppId}`,
    publishRequest(definition),
  );
}

export function hasPublishedProcessNodeVersion(remoteAppId: string, version: string) {
  return fetchApi.get<{ exists: boolean }>(
    `/api/v1/app/${remoteAppId}/versions/${encodeURIComponent(version)}`,
  );
}

export async function publishProcessNodeVersion(
  remoteAppId: string,
  localAppId: string,
  version: string,
) {
  const versionId = crypto.randomUUID();
  const archive = await getProcessNodeSourceArchive(localAppId);
  try {
    // Read the native archive directly; Base64 would allocate another full copy
    // in both the IPC payload and the webview before the upload begins.
    const bytes = await readFile(archive.path);
    const form = new FormData();
    form.set('format', 'tar.gz');
    form.set('sha256', archive.sha256);
    form.set(
      'archive',
      new Blob([bytes], { type: 'application/gzip' }),
      `${version}.tar.gz`,
    );
    await fetchApi.postForm(
      `/api/v1/app/${remoteAppId}/versions/${versionId}/resources/source-archive`,
      form,
    );
  } finally {
    // The archive is only an upload staging file and must not accumulate in temp.
    await remove(archive.path).catch(() => undefined);
  }
  await fetchApi.post<{ id: string }>(`/api/v1/app/${remoteAppId}/versions`, {
    id: versionId,
    version,
  });
}

export function deleteProcessNode(id: string, deleteProjectFiles: boolean) {
  return invoke('delete_process_node', { id, deleteProjectFiles });
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
