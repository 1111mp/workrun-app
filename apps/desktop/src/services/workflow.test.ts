import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';

import configurationExamplesSource from '../../src-tauri/src/module/assistant/workflow_agent/reference/configuration-examples.json?raw';
import {
  deleteWorkflow,
  getExecutableWorkflow,
  getWorkflow,
  updateWorkflow,
  toWorkflowDocument,
  toWorkflowDsl,
  workflowDocumentFromSnapshot,
  type WorkflowDocument,
} from './workflow';

describe('workflowDocumentFromSnapshot', () => {
  it('uses the mode captured when a run started', () => {
    expect(
      workflowDocumentFromSnapshot({
        nodes: [],
        edges: [],
        settings: { mode: 'chat' },
      }),
    ).toMatchObject({ settings: { mode: 'chat' } });
  });

  it('rejects incomplete historical snapshots', () => {
    expect(workflowDocumentFromSnapshot({ settings: { mode: 'task' } })).toBe(
      undefined,
    );
  });
});

vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke: vi.fn() }));
vi.mock('@/lib/constant', () => ({ isTeamMode: vi.fn() }));
vi.mock('@/services/fetch-api', () => ({
  fetchApi: { delete: vi.fn(), get: vi.fn() },
}));

describe('deleteWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes from the local catalog in personal mode', async () => {
    vi.mocked(isTeamMode).mockReturnValue(false);
    await deleteWorkflow('workflow-1');
    expect(invoke).toHaveBeenCalledWith('delete_workflow', {
      id: 'workflow-1',
    });
    expect(fetchApi.delete).not.toHaveBeenCalled();
  });

  it('uses the author-scoped server endpoint in team mode', async () => {
    vi.mocked(isTeamMode).mockReturnValue(true);
    await deleteWorkflow('workflow-1');
    expect(fetchApi.delete).toHaveBeenCalledWith('/workflow/workflow-1');
    expect(invoke).not.toHaveBeenCalled();
  });
});

const configurationExamples = JSON.parse(configurationExamplesSource) as {
  id: string;
  document: WorkflowDocument;
}[];

describe('native configuration knowledge examples', () => {
  it.each(configurationExamples)(
    'preserves $id through editor loading and document serialization',
    async ({ document }) => {
      vi.mocked(isTeamMode).mockReturnValue(false);
      vi.mocked(invoke).mockResolvedValueOnce({
        id: 'example-workflow',
        document,
      });
      const loaded = await getWorkflow('example-workflow');
      const edited = toWorkflowDocument(
        loaded.document.nodes,
        loaded.document.edges,
        loaded.document.settings,
      );
      expect(edited).toEqual(document);
      const dsl = toWorkflowDsl(
        'example-workflow',
        edited.nodes,
        edited.edges,
        edited.settings,
      );
      expect(dsl.nodes.map((node) => node.data)).toEqual(
        document.nodes.map((node) => node.data),
      );
    },
  );
});

it('saves legacy Agent display names in the canonical name field without rewriting the source', () => {
  const document: WorkflowDocument = {
    settings: {
      name: 'Workflow',
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
    nodes: [
      {
        id: 'code',
        type: 'codeact_agent',
        position: { x: 0, y: 0 },
        data: {
          name: '',
          label: '销售指标计算',
          instruction: 'Keep this instruction',
        },
      },
    ],
    edges: [],
  };
  const saved = toWorkflowDocument(
    document.nodes,
    document.edges,
    document.settings,
  );
  expect(saved.nodes[0].data).toEqual({
    name: '销售指标计算',
    instruction: 'Keep this instruction',
  });
  expect(document.nodes[0].data).toHaveProperty('label', '销售指标计算');
});

describe('getExecutableWorkflow', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the latest saved definition in personal mode', async () => {
    vi.mocked(isTeamMode).mockReturnValue(false);
    await getExecutableWorkflow('workflow-1');
    expect(invoke).toHaveBeenCalledWith('get_workflow', { id: 'workflow-1' });
    expect(fetchApi.get).not.toHaveBeenCalled();
  });

  it('uses the published endpoint even for a Team author', async () => {
    vi.mocked(isTeamMode).mockReturnValue(true);
    await getExecutableWorkflow('workflow-1');
    expect(fetchApi.get).toHaveBeenCalledExactlyOnceWith(
      '/workflow/team/workflow-1',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not fall back to an author draft when no release is available', async () => {
    vi.mocked(isTeamMode).mockReturnValue(true);
    vi.mocked(fetchApi.get).mockRejectedValueOnce(
      new Error('No published release'),
    );
    await expect(getExecutableWorkflow('workflow-1')).rejects.toThrow(
      'No published release',
    );
    expect(fetchApi.get).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });
});

it('passes the checked revision to the native personal save without changing legacy callers', async () => {
  vi.clearAllMocks();
  vi.mocked(isTeamMode).mockReturnValue(false);
  const document = configurationExamples[0].document;
  await updateWorkflow('one', document, 'revision-1');
  expect(invoke).toHaveBeenLastCalledWith('update_workflow', {
    id: 'one',
    document,
    expectedRevisionId: 'revision-1',
  });
  await updateWorkflow('one', document);
  expect(invoke).toHaveBeenLastCalledWith('update_workflow', {
    id: 'one',
    document,
  });
});
