import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from '@workspace/ui/components';
import { DownloadIcon, EllipsisIcon, LinkIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { DeeplinkDialog } from '@/components/deeplink-dialog';
import { WorkflowExportButton } from '@/components/workflow-share-dialog';
import { isTeamMode } from '@/lib/constant';
import { deleteWorkflow, type StoredWorkflow } from '@/services/workflow';

export function WorkflowActionsMenu({
  workflow,
  canDelete,
  exportDisabled,
}: {
  workflow: StoredWorkflow;
  canDelete: boolean;
  exportDisabled: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [deeplinkOpened, setDeeplinkOpened] = useState(false);
  const [exportOpened, setExportOpened] = useState(false);
  const [deleteOpened, setDeleteOpened] = useState(false);
  const personal = !isTeamMode();
  const deletion = useMutation({
    mutationFn: () => deleteWorkflow(workflow.id),
    onSuccess: () => {
      setDeleteOpened(false);
      void queryClient.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflows.deleted'), { toasterId: 'global' });
      void navigate('/workflows', { replace: true });
    },
    onError: (error) =>
      toast.error(t('workflows.deleteFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant='outline'
              size='icon-sm'
              aria-label={t('workflows.actions')}
              title={t('workflows.actions')}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent className='min-w-36'>
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={exportDisabled}
              title={
                exportDisabled ? t('workflows.share.saveFirst') : undefined
              }
              onClick={() => setDeeplinkOpened(true)}
            >
              <LinkIcon />
              {t('deeplink.title')}
            </DropdownMenuItem>
            {personal ? (
              <DropdownMenuItem
                disabled={exportDisabled}
                title={
                  exportDisabled ? t('workflows.share.saveFirst') : undefined
                }
                onClick={() => setExportOpened(true)}
              >
                <DownloadIcon />
                {t('workflows.share.export')}
              </DropdownMenuItem>
            ) : null}
            {canDelete ? <DropdownMenuSeparator /> : null}
            {canDelete ? (
              <DropdownMenuItem
                variant='destructive'
                onClick={() => setDeleteOpened(true)}
              >
                <Trash2Icon />
                {t('workflows.delete')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Keep dialogs outside the menu so closing its popup does not unmount them. */}
      {deeplinkOpened ? (
        <DeeplinkDialog
          targetType='workflows'
          targetId={workflow.id}
          open={deeplinkOpened}
          onOpenChange={setDeeplinkOpened}
        />
      ) : null}
      {personal && exportOpened ? (
        <WorkflowExportButton
          id={workflow.id}
          disabled={exportDisabled}
          open={exportOpened}
          onOpenChange={setExportOpened}
        />
      ) : null}
      <AlertDialog
        open={deleteOpened}
        onOpenChange={(next) => {
          if (!deletion.isPending) setDeleteOpened(next);
        }}
      >
        <AlertDialogContent className='max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl! gap-0 overflow-y-auto p-0'>
          <div className='via-background from-destructive/12 to-muted/50 relative overflow-hidden border-b bg-linear-to-br px-5 pt-5 pb-4 sm:px-6 sm:pt-6'>
            <div className='bg-destructive/10 absolute -top-12 -right-10 size-36 rounded-full blur-2xl' />
            <AlertDialogHeader className='relative grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-3 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
              <AlertDialogMedia className='border-destructive/20 bg-destructive/10 text-destructive mb-0 size-10 rounded-xl border shadow-sm'>
                <Trash2Icon className='size-5' />
              </AlertDialogMedia>
              <div className='flex min-w-0 flex-col gap-1.5'>
                <AlertDialogTitle className='text-lg font-semibold tracking-tight wrap-break-word'>
                  {t('workflows.deleteTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription className='text-sm leading-5 wrap-break-word'>
                  {t(
                    personal
                      ? 'workflows.deleteDescription'
                      : 'workflows.deleteTeamDescription',
                    { name: workflow.document.settings.name },
                  )}
                </AlertDialogDescription>
              </div>
            </AlertDialogHeader>
          </div>
          <AlertDialogFooter className='mx-0 mb-0 px-5 py-4 sm:px-6'>
            <AlertDialogCancel disabled={deletion.isPending}>
              {t('apps.share.cancel')}
            </AlertDialogCancel>
            <Button
              variant='destructive'
              disabled={deletion.isPending}
              onClick={() => deletion.mutate()}
            >
              {deletion.isPending ? (
                <Spinner data-icon='inline-start' />
              ) : (
                <Trash2Icon data-icon='inline-start' />
              )}
              {t('workflows.delete')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
