import { invoke } from '@tauri-apps/api/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isTeamMode } from '@/lib/constant';
import { fetchApi } from '@/services/fetch-api';

import configurationExamplesSource from '../../src-tauri/src/module/assistant/workflow_agent/reference/configuration-examples.json?raw';
import {
  deleteWorkflow,
  getWorkflow,
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
vi.mock('@/services/fetch-api', () => ({ fetchApi: { delete: vi.fn() } }));

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
