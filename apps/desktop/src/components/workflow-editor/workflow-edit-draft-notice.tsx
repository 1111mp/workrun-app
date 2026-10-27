import { Alert, AlertDescription, Button } from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import type { useWorkflowEditDraft } from './use-workflow-edit-draft';

export function WorkflowEditDraftNotice({
  draft,
  disabled = false,
}: {
  draft: ReturnType<typeof useWorkflowEditDraft>;
  disabled?: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (!draft.enabled || (!draft.record && !draft.loadFailed)) return null;
  return (
    <Alert className='mx-4 mb-2 w-auto'>
      <AlertDescription className='flex flex-wrap items-center gap-2'>
        <span className='flex-1'>
          {draft.loadFailed
            ? t('workflowEditor.editDraft.loadFailed')
            : t(
                draft.pending
                  ? 'workflowEditor.editDraft.available'
                  : draft.canRestore
                    ? 'workflowEditor.editDraft.different'
                    : 'workflowEditor.editDraft.protected',
                {
                  time: new Date(draft.record!.savedAt).toLocaleString(
                    i18n.language,
                  ),
                },
              )}
          {draft.pending && draft.baseChanged
            ? ` ${t('workflowEditor.editDraft.baseChanged')}`
            : ''}
        </span>
        {draft.pending || draft.canRestore ? (
          <Button
            variant='outline'
            size='sm'
            disabled={disabled || draft.busy || draft.loading}
            onClick={() => void draft.restore()}
          >
            {t('workflowEditor.editDraft.restore')}
          </Button>
        ) : null}
        <Button
          variant='ghost'
          size='sm'
          disabled={disabled || draft.busy || draft.loading}
          onClick={() => void draft.discard()}
        >
          {t('workflowEditor.editDraft.discard')}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
