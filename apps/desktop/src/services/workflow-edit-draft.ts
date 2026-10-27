import { invoke } from '@tauri-apps/api/core';

import {
  toWorkflowDocument,
  workflowDocumentFromSnapshot,
  type WorkflowDocument,
} from './workflow';

export type WorkflowEditDraft = {
  document: WorkflowDocument;
  baseRevisionId: string | null;
  savedAt: string;
};

// Read-only compatibility namespace. New stashes are stored through native SQLite commands.
const key = (workflowId?: string) =>
  `workrun.personal.workflow-edit-draft:${workflowId ?? 'new'}`;

export function workflowDocumentFingerprint(document: WorkflowDocument) {
  return JSON.stringify(
    toWorkflowDocument(document.nodes, document.edges, document.settings),
  );
}

function editableDocument(value: unknown): WorkflowDocument | undefined {
  const document = workflowDocumentFromSnapshot(value);
  if (
    !document ||
    typeof document.settings.name !== 'string' ||
    !Array.isArray(document.settings.inputSchema?.fields) ||
    document.nodes.some(
      (node) =>
        !node ||
        typeof node.id !== 'string' ||
        !node.data ||
        typeof node.data !== 'object' ||
        !Number.isFinite(node.position?.x) ||
        !Number.isFinite(node.position?.y),
    ) ||
    document.edges.some(
      (edge) =>
        !edge ||
        typeof edge.id !== 'string' ||
        typeof edge.source !== 'string' ||
        typeof edge.target !== 'string',
    )
  )
    return undefined;
  return document;
}

function normalizeDraft(value: WorkflowEditDraft): WorkflowEditDraft {
  if (
    !editableDocument(value.document) ||
    (value.baseRevisionId !== null &&
      typeof value.baseRevisionId !== 'string') ||
    !Number.isFinite(Date.parse(value.savedAt))
  ) {
    throw new Error('Invalid workflow edit draft');
  }
  return {
    ...value,
    document: JSON.parse(workflowDocumentFingerprint(value.document)),
  };
}

function legacyValue(workflowId?: string): string | null {
  // Disabled browser storage must not prevent use of the SQLite store.
  try {
    return window.localStorage.getItem(key(workflowId));
  } catch {
    return null;
  }
}

function removeLegacy(workflowId?: string) {
  if (legacyValue(workflowId) !== null)
    window.localStorage.removeItem(key(workflowId));
}

function cleanupMigratedLegacy(workflowId?: string) {
  try {
    removeLegacy(workflowId);
  } catch {
    // SQLite is authoritative after a successful import; cleanup can retry on read.
  }
}

export async function readWorkflowEditDraft(
  workflowId?: string,
): Promise<WorkflowEditDraft | null> {
  const existing = await invoke<WorkflowEditDraft | null>(
    'get_workflow_edit_draft',
    { workflowId: workflowId ?? null },
  );
  if (existing) {
    const draft = normalizeDraft(existing);
    cleanupMigratedLegacy(workflowId);
    return draft;
  }
  const raw = legacyValue(workflowId);
  if (!raw) return null;
  const legacy = JSON.parse(raw) as {
    version?: number;
    document?: WorkflowDocument;
    baseDocument?: string;
    savedAt?: string;
  };
  const document = editableDocument(legacy?.document);
  const base =
    typeof legacy?.baseDocument === 'string'
      ? editableDocument(JSON.parse(legacy.baseDocument))
      : undefined;
  if (
    legacy?.version !== 1 ||
    !document ||
    !base ||
    typeof legacy.savedAt !== 'string' ||
    !Number.isFinite(Date.parse(legacy.savedAt))
  ) {
    throw new Error('Invalid legacy workflow edit draft');
  }
  // The native import is insert-only so concurrent/retried migration cannot
  // overwrite a newer database stash. Delete browser data only after commit.
  const migrated = normalizeDraft(
    await invoke<WorkflowEditDraft>('import_workflow_edit_draft', {
      workflowId: workflowId ?? null,
      document: JSON.parse(workflowDocumentFingerprint(document)),
      baseDocument: JSON.parse(workflowDocumentFingerprint(base)),
      savedAt: legacy.savedAt,
    }),
  );
  cleanupMigratedLegacy(workflowId);
  return migrated;
}

export async function writeWorkflowEditDraft(
  workflowId: string | undefined,
  document: WorkflowDocument,
  baseRevisionId: string | null,
): Promise<WorkflowEditDraft> {
  const saved = normalizeDraft(
    await invoke<WorkflowEditDraft>('save_workflow_edit_draft', {
      workflowId: workflowId ?? null,
      document,
      baseRevisionId,
    }),
  );
  cleanupMigratedLegacy(workflowId);
  return saved;
}

export async function removeWorkflowEditDraft(workflowId?: string) {
  // Remove an accessible legacy copy first so it cannot resurrect a discarded stash.
  removeLegacy(workflowId);
  await invoke('remove_workflow_edit_draft', {
    workflowId: workflowId ?? null,
  });
}
