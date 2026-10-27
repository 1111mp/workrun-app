import { invoke } from '@tauri-apps/api/core';
import { waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { createWorkflowDocument } from './workflow';
import {
  readWorkflowEditDraft,
  removeWorkflowEditDraft,
  workflowDocumentFingerprint,
  writeWorkflowEditDraft,
  type WorkflowEditDraft,
} from './workflow-edit-draft';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@/lib/constant', () => ({
  isTeamMode: vi.fn().mockReturnValue(false),
}));
vi.mock('@/services/fetch-api', () => ({ fetchApi: { get: vi.fn() } }));

const document = createWorkflowDocument('Editing');
const base = createWorkflowDocument('Official');
const key = 'workrun.personal.workflow-edit-draft:one';
const draft: WorkflowEditDraft = {
  document,
  baseRevisionId: 'revision-1',
  savedAt: '2026-10-27T00:00:00Z',
};
const legacy = () =>
  JSON.stringify({
    version: 1,
    document,
    baseDocument: workflowDocumentFingerprint(base),
    savedAt: draft.savedAt,
  });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  localStorage.clear();
});

it('writes one SQLite row through the native command without growing localStorage', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(draft);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  expect(await writeWorkflowEditDraft('one', document, 'revision-1')).toEqual(
    draft,
  );
  expect(invoke).toHaveBeenCalledExactlyOnceWith('save_workflow_edit_draft', {
    workflowId: 'one',
    document,
    baseRevisionId: 'revision-1',
  });
  expect(write).not.toHaveBeenCalled();
});

it('migrates an old stash only after SQLite commits and preserves its original timestamp', async () => {
  localStorage.setItem(key, legacy());
  let commit!: (value: WorkflowEditDraft) => void;
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        commit = resolve;
      }),
    );
  const loading = readWorkflowEditDraft('one');
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('import_workflow_edit_draft', {
    workflowId: 'one',
    document,
    baseDocument: base,
    savedAt: draft.savedAt,
  });
  commit(draft);
  expect(await loading).toEqual(draft);
  expect(localStorage.getItem(key)).toBeNull();
});

it('retains legacy data if the database import fails so migration can be retried', async () => {
  const raw = legacy();
  localStorage.setItem(key, raw);
  vi.mocked(invoke)
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error('Database full'));
  await expect(readWorkflowEditDraft('one')).rejects.toThrow('Database full');
  expect(localStorage.getItem(key)).toBe(raw);
});

it('prefers an existing SQLite stash over even a malformed legacy copy', async () => {
  localStorage.setItem(key, '{broken');
  vi.mocked(invoke).mockResolvedValueOnce(draft);
  expect(await readWorkflowEditDraft('one')).toEqual(draft);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(key)).toBeNull();
});

it('rejects incomplete legacy snapshots without deleting them or importing anything', async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      document: { nodes: [], edges: [], settings: { mode: 'task' } },
      baseDocument: '{}',
      savedAt: draft.savedAt,
    }),
  );
  vi.mocked(invoke).mockResolvedValueOnce(null);
  await expect(readWorkflowEditDraft('one')).rejects.toThrow('Invalid legacy');
  expect(localStorage.getItem(key)).not.toBeNull();
  expect(invoke).toHaveBeenCalledTimes(1);
});

it('uses a separate null workflow identifier for an unsaved new workflow', async () => {
  vi.mocked(invoke).mockResolvedValueOnce(null);
  expect(await readWorkflowEditDraft()).toBeNull();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('get_workflow_edit_draft', {
    workflowId: null,
  });
});

it('removes an accessible legacy copy before database deletion to prevent resurrection', async () => {
  localStorage.setItem(key, legacy());
  vi.mocked(invoke).mockImplementationOnce(async () => {
    expect(localStorage.getItem(key)).toBeNull();
  });
  await removeWorkflowEditDraft('one');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remove_workflow_edit_draft', {
    workflowId: 'one',
  });
});

it('keeps SQLite storage usable when browser storage is disabled', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('Browser storage unavailable');
  });
  vi.mocked(invoke).mockResolvedValueOnce(draft);
  expect(await readWorkflowEditDraft('one')).toEqual(draft);
});
