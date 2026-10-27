import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { useConfirm } from '@/lib/confirm-context';
import { getWorkflow, type WorkflowDocument } from '@/services/workflow';
import {
  readWorkflowEditDraft,
  removeWorkflowEditDraft,
  workflowDocumentFingerprint,
  writeWorkflowEditDraft,
  type WorkflowEditDraft,
} from '@/services/workflow-edit-draft';

export function useWorkflowEditDraft({
  enabled,
  workflowId,
  document,
  savedDocument,
  savedRevisionId,
  onRestore,
}: {
  enabled: boolean;
  workflowId?: string;
  document: WorkflowDocument;
  savedDocument: string;
  savedRevisionId?: string;
  onRestore: (document: WorkflowDocument) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const scope = enabled ? (workflowId ?? 'new') : null;
  const [state, setState] = useState<{
    scope: string | null;
    record: WorkflowEditDraft | null;
    restored: boolean;
    loadFailed: boolean;
    loading: boolean;
  }>(() => ({
    scope,
    record: null,
    restored: false,
    loadFailed: false,
    loading: enabled,
  }));
  if (state.scope !== scope) {
    setState({
      scope,
      record: null,
      restored: false,
      loadFailed: false,
      loading: enabled,
    });
  }
  const { record, restored, loadFailed, loading } = state;
  const [busy, setBusy] = useState(false);
  const writing = useRef(false);
  const baseRevision = useRef<string | null>(savedRevisionId ?? null);

  useEffect(() => {
    let current = true;
    if (enabled) {
      void readWorkflowEditDraft(workflowId)
        .then((draft) => {
          if (current)
            setState({
              scope: workflowId ?? 'new',
              record: draft,
              restored: false,
              loadFailed: false,
              loading: false,
            });
        })
        .catch(() => {
          if (current)
            setState({
              scope: workflowId ?? 'new',
              record: null,
              restored: false,
              loadFailed: true,
              loading: false,
            });
        });
    }
    // A slow read for a previous workflow must not replace this editor's stash.
    return () => {
      current = false;
    };
  }, [enabled, workflowId]);

  useEffect(() => {
    if (!restored)
      baseRevision.current = workflowId ? (savedRevisionId ?? null) : null;
  }, [savedRevisionId, restored, workflowId]);
  const snapshot = workflowDocumentFingerprint(document);
  const pending = Boolean(record && !restored);
  const protectedSnapshot =
    record && restored
      ? workflowDocumentFingerprint(record.document)
      : savedDocument;
  const hasUnprotectedChanges =
    snapshot !== savedDocument && snapshot !== protectedSnapshot;

  const stash = async () => {
    if (!enabled || pending || loading || loadFailed || writing.current)
      throw new Error(t('workflowEditor.editDraft.resolveFirst'));
    writing.current = true;
    setBusy(true);
    try {
      // Protection is granted only after the native write transaction commits.
      const saved = await writeWorkflowEditDraft(
        workflowId,
        document,
        baseRevision.current,
      );
      setState((state) =>
        state.scope !== scope
          ? state
          : {
              ...state,
              record: saved,
              restored: true,
              loadFailed: false,
            },
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!enabled || !record || busy) return;
    if (
      snapshot !== savedDocument &&
      !(await confirm({
        title: t('workflowEditor.editDraft.restoreTitle'),
        description: t('workflowEditor.editDraft.restoreDescription'),
        confirmText: t('workflowEditor.editDraft.restore'),
      }))
    )
      return;
    baseRevision.current = record.baseRevisionId;
    onRestore(record.document);
    setState((state) =>
      state.scope !== scope ? state : { ...state, restored: true },
    );
  };

  const discard = async () => {
    if (!enabled || loading || busy) return;
    await confirm({
      title: t('workflowEditor.editDraft.discardTitle'),
      description: t('workflowEditor.editDraft.discardDescription'),
      confirmText: t('workflowEditor.editDraft.discard'),
      actionVariant: 'destructive',
      onConfirm: async () => {
        await removeWorkflowEditDraft(workflowId);
        if (restored) onRestore(JSON.parse(savedDocument) as WorkflowDocument);
        baseRevision.current = savedRevisionId ?? null;
        setState((state) =>
          state.scope !== scope
            ? state
            : {
                ...state,
                record: null,
                restored: false,
                loadFailed: false,
              },
        );
      },
    });
  };

  const confirmSave = async () => {
    if (!enabled) return {};
    if (loading || writing.current) return false;
    if (!workflowId) return {};
    const current = await getWorkflow(workflowId);
    if (
      baseRevision.current &&
      current.currentRevisionId === baseRevision.current
    )
      return { expectedRevisionId: current.currentRevisionId };
    const overwrite = await confirm({
      title: t('workflowEditor.editDraft.conflictTitle'),
      description: t('workflowEditor.editDraft.conflictDescription'),
      confirmText: t('workflowEditor.editDraft.overwrite'),
    });
    return overwrite
      ? { expectedRevisionId: current.currentRevisionId }
      : false;
  };

  const clearAfterSave = async (revisionId?: string) => {
    if (!enabled) return;
    baseRevision.current = revisionId ?? null;
    try {
      await removeWorkflowEditDraft(workflowId);
      setState((state) =>
        state.scope !== scope
          ? state
          : {
              ...state,
              record: null,
              restored: false,
              loadFailed: false,
            },
      );
    } catch {
      // A cleanup failure cannot turn an already committed workflow save into a failure.
      toast.error(t('workflowEditor.editDraft.cleanupFailed'), {
        toasterId: 'global',
      });
    }
  };

  return {
    enabled,
    record,
    pending,
    loadFailed,
    loading,
    busy,
    hasUnprotectedChanges,
    canRestore: Boolean(
      record && snapshot !== workflowDocumentFingerprint(record.document),
    ),
    canStash:
      enabled &&
      !loading &&
      !loadFailed &&
      !busy &&
      !pending &&
      hasUnprotectedChanges,
    baseChanged: Boolean(
      record &&
      workflowId &&
      record.baseRevisionId !== (savedRevisionId ?? null),
    ),
    stash,
    restore,
    discard,
    confirmSave,
    clearAfterSave,
  };
}
