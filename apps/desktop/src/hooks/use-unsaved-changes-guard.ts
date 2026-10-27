import { FileWarningIcon } from 'lucide-react';
import { createElement, useEffect, useEffectEvent, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router';

import { useConfirm } from '@/lib/confirm-context';

export type UnsavedChangesGuardOptions = {
  hasUnsavedChanges: boolean;
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  alternativeText?: string;
  onAlternative?: () => void | Promise<void>;
};

/** Requires a React Router data router and ConfirmProvider. Guards in-app navigation. */
export function useUnsavedChangesGuard({
  hasUnsavedChanges,
  title,
  description,
  confirmText,
  cancelText,
  alternativeText,
  onAlternative,
}: UnsavedChangesGuardOptions) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const blocker = useBlocker(hasUnsavedChanges);
  const confirming = useRef(false);
  const settledBlocker = useRef<typeof blocker | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const resolveNavigation = useEffectEvent((leave: boolean) => {
    if (
      !mounted.current ||
      blocker.state !== 'blocked' ||
      settledBlocker.current === blocker
    )
      return;
    // An async save can both clean the document and resolve its dialog in the
    // same commit. Either path may release navigation, but never both.
    settledBlocker.current = blocker;
    // A second navigation can replace the destination while the dialog is
    // open. Apply the answer to the current blocker, not its old closure.
    if (leave || !hasUnsavedChanges) blocker.proceed();
    else blocker.reset();
  });

  useEffect(() => {
    if (blocker.state !== 'blocked') {
      confirming.current = false;
      return;
    }
    // Saving a new workflow can navigate before the clean state is committed.
    if (!hasUnsavedChanges) {
      resolveNavigation(true);
      return;
    }
    if (confirming.current) return;
    confirming.current = true;
    void confirm({
      icon: createElement(FileWarningIcon),
      title: title ?? t('unsavedChanges.title'),
      description: description ?? t('unsavedChanges.description'),
      cancelText: cancelText ?? t('unsavedChanges.stay'),
      confirmText: confirmText ?? t('unsavedChanges.leave'),
      alternativeText,
      onAlternative,
    }).then((leave) => {
      resolveNavigation(leave);
    });
  }, [
    blocker,
    hasUnsavedChanges,
    confirm,
    t,
    title,
    description,
    confirmText,
    cancelText,
    alternativeText,
    onAlternative,
  ]);
}
