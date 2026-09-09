import { invoke } from '@tauri-apps/api/core';
import { readFile, remove } from '@tauri-apps/plugin-fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';

import {
  getProcessNodeProjectVersion,
  getProcessNodes,
  publishProcessNode,
  publishProcessNodeVersion,
} from './process-node';

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class {},
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn(), remove: vi.fn() }));
vi.mock('@/lib/constant', () => ({ isTeamMode: vi.fn() }));
vi.mock('@/services/fetch-api', () => ({
  fetchApi: { get: vi.fn(), post: vi.fn(), postForm: vi.fn() },
}));

const definition = {
  id: 'app-1',
  name: 'Shared App',
  description: '',
  version: '0.1.0',
  createdAt: '2026-09-08T00:00:00.000Z',
  updatedAt: '2026-09-08T00:00:00.000Z',
  entry: 'main.py',
  kind: 'workflow' as const,
  toolExecutionPolicy: 'ask_every_time' as const,
  inputs: {},
  outputs: {},
};

describe('getProcessNodes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the local catalog in personal mode', async () => {
    vi.mocked(isTeamMode).mockReturnValue(false);
    vi.mocked(invoke).mockResolvedValueOnce([]);

    await expect(getProcessNodes()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('get_process_nodes');
    expect(fetchApi.get).not.toHaveBeenCalled();
  });

  it('uses the local App in place of its published server catalog entry', async () => {
    vi.mocked(isTeamMode).mockReturnValue(true);
    vi.mocked(invoke).mockResolvedValueOnce([
      {
        definition: {
          ...definition,
          publicationStatus: 'published',
          remoteAppId: 'remote-app-1',
        },
        installStatus: 'installed',
        projectPath: '/team/default/process-nodes/app-1',
      },
    ]);
    vi.mocked(fetchApi.get).mockResolvedValueOnce({
      items: [{ ...definition, id: 'remote-app-1' }],
    });

    await expect(getProcessNodes()).resolves.toEqual([
      {
        definition: {
          ...definition,
          publicationStatus: 'published',
          remoteAppId: 'remote-app-1',
        },
        installStatus: 'installed',
        projectPath: '/team/default/process-nodes/app-1',
      },
    ]);
    expect(fetchApi.get).toHaveBeenCalledWith('/api/v1/app');
    expect(invoke).toHaveBeenCalledWith('get_process_nodes');
  });

  it('publishes only the server-owned App definition', async () => {
    vi.mocked(fetchApi.post).mockResolvedValueOnce({ id: 'remote-app-1' });

    await expect(
      publishProcessNode({
        ...definition,
        publicationStatus: 'draft',
        remoteAppId: 'remote-app-1',
        projectRoot: '/team/default/process-nodes',
      }),
    ).resolves.toEqual({ id: 'remote-app-1' });

    expect(fetchApi.post).toHaveBeenCalledWith('/api/v1/app', {
      name: definition.name,
      description: definition.description,
      version: definition.version,
      entry: definition.entry,
      kind: definition.kind,
      toolExecutionPolicy: definition.toolExecutionPolicy,
      inputs: definition.inputs,
      outputs: definition.outputs,
    });
  });

  it('reads the publish version from the local project manifest', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('1.2.3');

    await expect(getProcessNodeProjectVersion('app-1')).resolves.toBe('1.2.3');
    expect(invoke).toHaveBeenCalledWith('process_node_project_version', {
      id: 'app-1',
    });
  });

  it('uploads the source archive before creating the published version', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      path: '/tmp/workrun-source.tar.gz',
      sha256: 'a'.repeat(64),
      size: 3,
    });
    vi.mocked(readFile).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    vi.mocked(fetchApi.postForm).mockResolvedValueOnce({});
    vi.mocked(fetchApi.post).mockResolvedValueOnce({ id: 'version-1' });
    vi.mocked(remove).mockResolvedValueOnce(undefined);

    await publishProcessNodeVersion('remote-app-1', 'app-1', '1.2.3');

    const uploadPath = vi.mocked(fetchApi.postForm).mock.calls[0]?.[0];
    const versionId = uploadPath?.split('/')[6];
    expect(uploadPath).toMatch(
      /^\/api\/v1\/app\/remote-app-1\/versions\/[\w-]+\/resources\/source-archive$/,
    );
    expect(fetchApi.post).toHaveBeenCalledWith('/api/v1/app/remote-app-1/versions', {
      id: versionId,
      version: '1.2.3',
    });
    expect(fetchApi.postForm.mock.invocationCallOrder[0]).toBeLessThan(
      fetchApi.post.mock.invocationCallOrder[0]!,
    );
    expect(remove).toHaveBeenCalledWith('/tmp/workrun-source.tar.gz');
  });

  it('does not create a version when source archive upload fails', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
      path: '/tmp/workrun-source.tar.gz',
      sha256: 'a'.repeat(64),
      size: 3,
    });
    vi.mocked(readFile).mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    vi.mocked(fetchApi.postForm).mockRejectedValueOnce(new Error('upload failed'));
    vi.mocked(remove).mockResolvedValueOnce(undefined);

    await expect(
      publishProcessNodeVersion('remote-app-1', 'app-1', '1.2.3'),
    ).rejects.toThrow('upload failed');

    expect(fetchApi.post).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith('/tmp/workrun-source.tar.gz');
  });
});
