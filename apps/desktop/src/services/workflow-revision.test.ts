import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';

import {
  compareWorkflowRevisions,
  type WorkflowRevision,
} from './workflow-revision';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
const revision = (id: string, workflowId = 'workflow'): WorkflowRevision => ({
  id,
  workflowId,
  parentRevisionId: null,
  createdAt: 'now',
  source: 'manual',
  operationId: null,
  document: {
    nodes: [],
    edges: [],
    settings: {
      name: id,
      description: '',
      mode: 'task',
      inputSchema: { fields: [] },
    },
  },
});
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
it('compares only the two immutable revisions instead of loading the current workflow', async () => {
  vi.mocked(invoke).mockImplementation(async (_command, args) =>
    revision((args as { id: string }).id),
  );
  const result = await compareWorkflowRevisions({
    beforeRevisionId: 'first',
    afterRevisionId: 'second',
  });
  expect(invoke).toHaveBeenCalledWith('get_workflow_revision', {
    id: 'first',
  });
  expect(invoke).toHaveBeenCalledWith('get_workflow_revision', {
    id: 'second',
  });
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(result.before?.settings.name).toBe('first');
  expect(result.after.settings.name).toBe('second');
});
it('supports the first version and rejects comparisons across workflows', async () => {
  vi.mocked(invoke).mockResolvedValue(revision('first'));
  const result = await compareWorkflowRevisions({ afterRevisionId: 'first' });
  expect(result.before).toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
  vi.mocked(invoke).mockImplementation(async (_command, args) =>
    revision((args as { id: string }).id, (args as { id: string }).id),
  );
  await expect(
    compareWorkflowRevisions({ beforeRevisionId: 'a', afterRevisionId: 'b' }),
  ).rejects.toThrow('different workflows');
});
