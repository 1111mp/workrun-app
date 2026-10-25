import { invoke } from '@tauri-apps/api/core';

import type { WorkflowDocument } from './workflow';

export type WorkflowRevision = {
  id: string;
  workflowId: string;
  parentRevisionId: string | null;
  document: WorkflowDocument;
  createdAt: string;
  source: string;
  operationId: string | null;
};
export type WorkflowRevisionComparison = {
  beforeRevisionId?: string | null;
  afterRevisionId: string;
};
export type WorkflowComparison = {
  id: string;
  workflowId: string;
  createdAt: string;
  before: WorkflowDocument | null;
  after: WorkflowDocument;
};
export function getWorkflowRevision(id: string) {
  return invoke<WorkflowRevision>('get_workflow_revision', { id });
}
export async function compareWorkflowRevisions({
  beforeRevisionId,
  afterRevisionId,
}: WorkflowRevisionComparison): Promise<WorkflowComparison> {
  const [before, after] = await Promise.all([
    beforeRevisionId ? getWorkflowRevision(beforeRevisionId) : null,
    getWorkflowRevision(afterRevisionId),
  ]);
  if (before && before.workflowId !== after.workflowId)
    throw new Error('Workflow revisions belong to different workflows');
  return {
    id: after.id,
    workflowId: after.workflowId,
    createdAt: after.createdAt,
    before: before?.document ?? null,
    after: after.document,
  };
}
