import { Channel, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { join, tempDir } from '@tauri-apps/api/path';
import { readFile, remove, writeFile } from '@tauri-apps/plugin-fs';
import { gt } from 'semver';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';
import type { DependencySyncResult } from '@/services/runtime';

export type ProcessNodeInstallStatus =
  | 'draft'
  | 'notInstalled'
  | 'installed'
  | 'updateAvailable'
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
  ownerId?: string;
};

export type ProcessNode = {
  definition: ProcessNodeDefinition;
  projectPath: string;
  installStatus: ProcessNodeInstallStatus;
  installError?: string;
  availableVersion?: string;
};

type ProcessNodeSourceArchive = {
  path: string;
  sha256: string;
  size: number;
};

type TeamApp = ProcessNodeDefinition & {
  catalogVersionId: string;
  publishedAt: string;
};

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

export type ProcessNodePreparationProgress =
  | { stage: 'checkingVersion' }
  | { stage: 'downloading'; downloadedBytes: number; totalBytes?: number }
  | {
      stage:
        | 'verifying'
        | 'extracting'
        | 'syncingDependencies'
        | 'activating'
        | 'savingCatalog'
        | 'completed';
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
    const [localNodes, remoteNodes] = await Promise.all([
      invoke<ProcessNode[]>('get_process_nodes'),
      getTeamAppCatalog(),
    ]);
    const nodes = new Map<string, ProcessNode>(
      remoteNodes.map((definition) => [
        definition.id,
        {
          definition: {
            ...definition,
            inputs: definition.inputs ?? {},
            outputs: definition.outputs ?? {},
          },
          projectPath: '',
          installStatus: 'notInstalled' as const,
          availableVersion: definition.version,
        },
      ]),
    );

    // A local App is authoritative for its project path and install state. Once
    // published, use its remote ID as the map key so it replaces, rather than
    // duplicates, the matching server catalog entry.
    localNodes.forEach((localNode) => {
      const key = localNode.definition.remoteAppId ?? localNode.definition.id;
      const catalogNode = nodes.get(key);
      const installStatus =
        localNode.installStatus === 'installed' &&
        catalogNode &&
        gt(catalogNode.definition.version, localNode.definition.version)
          ? 'updateAvailable'
          : localNode.installStatus;
      nodes.set(key, {
        ...localNode,
        installStatus,
        availableVersion: catalogNode?.definition.version,
      });
    });
    return [...nodes.values()];
  }

  return await invoke<ProcessNode[]>('get_process_nodes');
}

async function getTeamAppCatalog() {
  const items: TeamApp[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchApi.get<TeamAppList>(
      `/app/catalog?pageSize=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export function getProcessNode(id: string) {
  return invoke<ProcessNode>('get_process_node', { id });
}

export async function getPublishedProcessNode(
  id: string,
): Promise<ProcessNode> {
  const definition = await fetchApi.get<TeamApp>(`/app/catalog/${id}`);
  return {
    definition: {
      ...definition,
      inputs: definition.inputs ?? {},
      outputs: definition.outputs ?? {},
    },
    projectPath: '',
    installStatus: 'notInstalled',
    availableVersion: definition.version,
  };
}

/** Download with the authenticated webview session, then let native code verify and unpack it. */
export async function ensurePublishedProcessNode(
  node: ProcessNode,
  onProgress?: (progress: ProcessNodePreparationProgress) => void,
): Promise<ProcessNode> {
  onProgress?.({ stage: 'checkingVersion' });
  const id = node.definition.remoteAppId ?? node.definition.id;
  const remote = await getPublishedProcessNode(id);
  if (
    node.installStatus === 'installed' &&
    node.definition.version === remote.definition.version
  ) {
    return node;
  }

  const { stream, headers } = await fetchApi.downloadStream(
    `/app/catalog/${encodeURIComponent(id)}/source-archive`,
  );
  const sha256 = headers.get('x-workrun-sha256');
  if (!sha256)
    throw new Error('Downloaded App source archive is missing its SHA-256');
  const contentLength = Number(headers.get('content-length'));
  const totalBytes = Number.isFinite(contentLength) ? contentLength : undefined;
  let downloadedBytes = 0;
  const trackedStream = stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        downloadedBytes += chunk.byteLength;
        onProgress?.({ stage: 'downloading', downloadedBytes, totalBytes });
        controller.enqueue(chunk);
      },
    }),
  );

  const archivePath = await join(
    await tempDir(),
    `workrun-source-${crypto.randomUUID()}.tar.gz`,
  );
  try {
    // The filesystem plugin consumes the response stream incrementally, so a
    // large source archive never needs a second in-memory WebView copy.
    await writeFile(archivePath, trackedStream);
    const progress = new Channel<ProcessNodePreparationProgress>();
    if (onProgress) progress.onmessage = onProgress;
    return await invoke<ProcessNode>('process_node_install_archive', {
      request: { definition: remote.definition, archivePath, sha256 },
      progress,
    });
  } finally {
    // Native code has consumed the archive before this Promise settles.
    await remove(archivePath).catch(() => undefined);
  }
}

export function getProcessNodeProjectVersion(id: string) {
  return invoke<string | null>('process_node_project_version', { id });
}

export function setProcessNodeProjectVersion(id: string, version: string) {
  return invoke('process_node_set_project_version', { id, version });
}

export function getProcessNodeSourceArchive(id: string) {
  return invoke<ProcessNodeSourceArchive>('process_node_source_archive', {
    id,
  });
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
    ownerId: _ownerId,
    ...request
  } = definition;
  return request;
}

/** Creates the server-owned Draft that mirrors a newly initialized local App. */
export function createTeamProcessNodeDraft(definition: ProcessNodeDefinition) {
  return fetchApi.post<{ id: string }>(
    '/app',
    publishRequest(definition),
  );
}

export function updatePublishedProcessNode(
  remoteAppId: string,
  definition: ProcessNodeDefinition,
) {
  return fetchApi.patch<{ id: string }>(
    `/app/${remoteAppId}`,
    publishRequest(definition),
  );
}

export function deletePublishedProcessNode(remoteAppId: string) {
  return fetchApi.delete(`/app/${remoteAppId}`);
}

export function hasPublishedProcessNodeVersion(
  remoteAppId: string,
  version: string,
) {
  return fetchApi.get<{ exists: boolean }>(
    `/app/${remoteAppId}/versions/${encodeURIComponent(version)}`,
  );
}

export async function publishProcessNodeVersion(
  remoteAppId: string,
  localAppId: string,
  version: string,
  releaseNote: string,
  definition: ProcessNodeDefinition,
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
      `/app/${remoteAppId}/versions/${versionId}/resources/source-archive`,
      form,
    );
  } finally {
    // The archive is only an upload staging file and must not accumulate in temp.
    await remove(archive.path).catch(() => undefined);
  }
  await fetchApi.post<{ id: string }>(`/app/${remoteAppId}/versions`, {
    id: versionId,
    version,
    releaseNote,
    definition: publishRequest(definition),
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
