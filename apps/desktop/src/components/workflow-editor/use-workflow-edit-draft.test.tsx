import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { createMemoryRouter, RouterProvider, useNavigate } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { ConfirmProvider } from '@/components/confirm-dialog';
import { useUnsavedChangesGuard } from '@/hooks/use-unsaved-changes-guard';
import { createWorkflowDocument, getWorkflow } from '@/services/workflow';
import {
  readWorkflowEditDraft,
  removeWorkflowEditDraft,
  workflowDocumentFingerprint,
  writeWorkflowEditDraft,
  type WorkflowEditDraft,
} from '@/services/workflow-edit-draft';

import { useWorkflowEditDraft } from './use-workflow-edit-draft';

const storage = vi.hoisted(() => ({
  records: new Map<string, WorkflowEditDraft>(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/constant', () => ({
  isTeamMode: vi.fn().mockReturnValue(false),
}));
vi.mock('@/services/fetch-api', () => ({ fetchApi: { get: vi.fn() } }));
vi.mock('@/services/workflow', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflow')>()),
  getWorkflow: vi.fn(),
}));
vi.mock('@/services/workflow-edit-draft', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/workflow-edit-draft')>()),
  readWorkflowEditDraft: vi.fn(
    async (id?: string) => storage.records.get(id ?? 'new') ?? null,
  ),
  writeWorkflowEditDraft: vi.fn(async (id, document, baseRevisionId) => {
    const draft = {
      document,
      baseRevisionId,
      savedAt: new Date().toISOString(),
    };
    storage.records.set(id ?? 'new', draft);
    return draft;
  }),
  removeWorkflowEditDraft: vi.fn(async (id?: string) => {
    storage.records.delete(id ?? 'new');
  }),
}));

const saved = createWorkflowDocument('Saved');
const edited = createWorkflowDocument('Edited');
const baseline = workflowDocumentFingerprint(saved);
const stored = (baseRevisionId = 'revision-1'): WorkflowEditDraft => ({
  document: edited,
  baseRevisionId,
  savedAt: new Date().toISOString(),
});

beforeEach(() => {
  vi.restoreAllMocks();
  storage.records.clear();
  vi.clearAllMocks();
  vi.mocked(getWorkflow).mockResolvedValue({
    id: 'one',
    currentRevisionId: 'revision-1',
    document: saved,
  } as any);
});

async function setup(enabled = true) {
  const onRestore = vi.fn();
  const hook = renderHook(
    ({ document, workflowId }) =>
      useWorkflowEditDraft({
        enabled,
        workflowId,
        document,
        savedDocument: baseline,
        savedRevisionId: 'revision-1',
        onRestore,
      }),
    {
      initialProps: {
        document: edited,
        workflowId: 'one' as string | undefined,
      },
      wrapper: ConfirmProvider,
    },
  );
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return { ...hook, onRestore };
}

it('stashes a complete document independently of execution and protects only committed edits', async () => {
  const { result, rerender } = await setup();
  await act(() => result.current.stash());
  expect(storage.records.get('one')).toMatchObject({
    document: edited,
    baseRevisionId: 'revision-1',
  });
  expect(getWorkflow).not.toHaveBeenCalled();
  expect(result.current.hasUnprotectedChanges).toBe(false);
  rerender({
    document: createWorkflowDocument('Edited again'),
    workflowId: 'one',
  });
  expect(result.current.hasUnprotectedChanges).toBe(true);
  expect(result.current.canStash).toBe(true);
});

it('offers recovery after an asynchronous reload without automatically changing the canvas', async () => {
  storage.records.set('one', stored());
  const { result, rerender, onRestore } = await setup();
  expect(result.current.pending).toBe(true);
  expect(onRestore).not.toHaveBeenCalled();
  rerender({ document: saved, workflowId: 'one' });
  await act(() => result.current.restore());
  expect(onRestore).toHaveBeenCalledWith(edited);
  expect(result.current.pending).toBe(false);
});

it('supports a separate new-workflow slot and clears it on creation', async () => {
  const { result, rerender } = await setup();
  rerender({ document: edited, workflowId: undefined });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(() => result.current.stash());
  expect(storage.records.get('new')).toMatchObject({ document: edited });
  expect(storage.records.has('one')).toBe(false);
  await act(() => result.current.clearAfterSave('created-revision'));
  expect(storage.records.has('new')).toBe(false);
  expect(getWorkflow).not.toHaveBeenCalled();
});

it('keeps edits unprotected and the old stash intact when SQLite writing fails', async () => {
  const { result } = await setup();
  vi.mocked(writeWorkflowEditDraft).mockRejectedValueOnce(
    new Error('Disk full'),
  );
  await act(async () => {
    await expect(result.current.stash()).rejects.toThrow('Disk full');
  });
  expect(result.current.hasUnprotectedChanges).toBe(true);
  expect(result.current.record).toBeNull();
  expect(result.current.busy).toBe(false);
});

it('waits for SQLite commit before considering edits protected', async () => {
  const { result } = await setup();
  let commit!: (draft: WorkflowEditDraft) => void;
  vi.mocked(writeWorkflowEditDraft).mockReturnValueOnce(
    new Promise((resolve) => {
      commit = resolve;
    }),
  );
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.stash();
  });
  expect(result.current.busy).toBe(true);
  expect(result.current.hasUnprotectedChanges).toBe(true);
  expect(result.current.canStash).toBe(false);
  await act(async () => {
    commit(stored());
    await saving;
  });
  expect(result.current.hasUnprotectedChanges).toBe(false);
});

it('does not access personal SQLite stashes in Team or execution views', async () => {
  const { result } = await setup(false);
  expect(readWorkflowEditDraft).not.toHaveBeenCalled();
  await expect(result.current.stash()).rejects.toThrow();
  expect(await result.current.confirmSave()).toEqual({});
  expect(getWorkflow).not.toHaveBeenCalled();
});

it('warns when the formal revision changed and preserves the stash on cancelled overwrite', async () => {
  const { result } = await setup();
  await act(() => result.current.stash());
  vi.mocked(getWorkflow).mockResolvedValueOnce({
    id: 'one',
    currentRevisionId: 'revision-2',
    document: saved,
  } as any);
  let decision!: ReturnType<typeof result.current.confirmSave>;
  act(() => {
    decision = result.current.confirmSave();
  });
  fireEvent.click(await screen.findByText('confirm.cancel'));
  await expect(decision).resolves.toBe(false);
  expect(storage.records.has('one')).toBe(true);
});

it('requires explicit discard and restores the saved canvas only after deletion succeeds', async () => {
  const { result, onRestore } = await setup();
  await act(() => result.current.stash());
  act(() => {
    void result.current.discard();
  });
  fireEvent.click(await screen.findByText('workflowEditor.editDraft.discard'));
  await waitFor(() => expect(result.current.record).toBeNull());
  expect(onRestore).toHaveBeenCalledWith(saved);
  expect(storage.records.has('one')).toBe(false);
});

it('detects stale/unknown imported baselines and confirms before replacing current edits', async () => {
  storage.records.set('one', { ...stored(), baseRevisionId: null });
  const { result, onRestore } = await setup();
  expect(result.current.baseChanged).toBe(true);
  act(() => {
    void result.current.restore();
  });
  fireEvent.click(await screen.findByText('confirm.cancel'));
  await waitFor(() =>
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument(),
  );
  expect(onRestore).not.toHaveBeenCalled();
  expect(result.current.pending).toBe(true);
});

it('keeps the saved canvas available when database loading fails', async () => {
  vi.mocked(readWorkflowEditDraft).mockRejectedValueOnce(
    new Error('Database unavailable'),
  );
  const { result, onRestore } = await setup();
  expect(result.current.loadFailed).toBe(true);
  expect(onRestore).not.toHaveBeenCalled();
});

it('clears only this workflow stash after a successful save', async () => {
  const { result } = await setup();
  await act(() => result.current.stash());
  storage.records.set('other', stored());
  expect(await result.current.confirmSave()).toEqual({
    expectedRevisionId: 'revision-1',
  });
  await act(() => result.current.clearAfterSave('revision-2'));
  expect(storage.records.has('one')).toBe(false);
  expect(storage.records.has('other')).toBe(true);
  expect(result.current.record).toBeNull();
});

it('ignores late reads for a previously opened workflow', async () => {
  let finish!: (draft: WorkflowEditDraft) => void;
  vi.mocked(readWorkflowEditDraft).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const hook = renderHook(
    ({ id }) =>
      useWorkflowEditDraft({
        enabled: true,
        workflowId: id,
        document: saved,
        savedDocument: baseline,
        savedRevisionId: 'revision-1',
        onRestore: vi.fn(),
      }),
    { initialProps: { id: 'one' }, wrapper: ConfirmProvider },
  );
  expect(hook.result.current.canStash).toBe(false);
  hook.rerender({ id: 'two' });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => {
    finish(stored());
  });
  expect(hook.result.current.record).toBeNull();
});

it('commits the actual SQLite write before completing stash-and-leave navigation', async () => {
  const errors = vi.spyOn(console, 'error');
  function Editor() {
    const navigate = useNavigate();
    const draft = useWorkflowEditDraft({
      enabled: true,
      workflowId: 'one',
      document: edited,
      savedDocument: baseline,
      savedRevisionId: 'revision-1',
      onRestore: vi.fn(),
    });
    useUnsavedChangesGuard({
      hasUnsavedChanges: draft.hasUnprotectedChanges,
      alternativeText: draft.canStash ? 'Stash and leave' : undefined,
      onAlternative: draft.stash,
    });
    return (
      <button disabled={draft.loading} onClick={() => void navigate('/other')}>
        Leave editor
      </button>
    );
  }
  const router = createMemoryRouter(
    [
      { path: '/edit', Component: Editor },
      { path: '/other', element: <p>Other page</p> },
    ],
    { initialEntries: ['/edit'] },
  );
  render(
    <ConfirmProvider>
      <RouterProvider router={router} />
    </ConfirmProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText('Leave editor')).not.toBeDisabled(),
  );
  fireEvent.click(screen.getByText('Leave editor'));
  fireEvent.click(await screen.findByText('Stash and leave'));
  await screen.findByText('Other page');
  expect(storage.records.get('one')?.document).toEqual(edited);
  expect(getWorkflow).not.toHaveBeenCalled();
  expect(removeWorkflowEditDraft).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

it('requires overwrite confirmation after restoring an imported stash with an unknown baseline', async () => {
  storage.records.set('one', { ...stored(), baseRevisionId: null });
  const { result, rerender } = await setup();
  rerender({ document: saved, workflowId: 'one' });
  await act(() => result.current.restore());
  let decision!: ReturnType<typeof result.current.confirmSave>;
  act(() => {
    decision = result.current.confirmSave();
  });
  expect(await screen.findByRole('alertdialog')).toHaveAccessibleName(
    'workflowEditor.editDraft.conflictTitle',
  );
  fireEvent.click(screen.getByText('confirm.cancel'));
  await expect(decision).resolves.toBe(false);
  expect(storage.records.has('one')).toBe(true);
});

it('does not apply a late stash write to a different workflow scope', async () => {
  const { result, rerender } = await setup();
  let finish!: (draft: WorkflowEditDraft) => void;
  vi.mocked(writeWorkflowEditDraft).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  let saving!: Promise<void>;
  act(() => {
    saving = result.current.stash();
  });
  rerender({ document: saved, workflowId: 'two' });
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    finish(stored());
    await saving;
  });
  expect(result.current.record).toBeNull();
  expect(result.current.pending).toBe(false);
});

it('binds an explicitly confirmed overwrite to the revision the user reviewed', async () => {
  const { result } = await setup();
  vi.mocked(getWorkflow).mockResolvedValueOnce({
    id: 'one',
    currentRevisionId: 'revision-2',
    document: saved,
  } as any);
  let decision!: ReturnType<typeof result.current.confirmSave>;
  act(() => {
    decision = result.current.confirmSave();
  });
  fireEvent.click(
    await screen.findByText('workflowEditor.editDraft.overwrite'),
  );
  await expect(decision).resolves.toEqual({ expectedRevisionId: 'revision-2' });
});
