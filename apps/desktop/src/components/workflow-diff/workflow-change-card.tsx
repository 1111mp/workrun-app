import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Spinner,
} from '@workspace/ui/components';
import { GitCompareArrowsIcon } from 'lucide-react';
import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  compareWorkflowRevisions,
  type WorkflowRevisionComparison,
} from '@/services/workflow-revision';

import { diffWorkflow } from './diff';

const WorkflowDiffView = lazy(() =>
  import('./workflow-diff-view').then((module) => ({
    default: module.WorkflowDiffView,
  })),
);

export function WorkflowChangeCard({
  beforeRevisionId,
  afterRevisionId,
}: WorkflowRevisionComparison) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const query = useQuery({
    queryKey: ['workflowComparison', beforeRevisionId ?? null, afterRevisionId],
    queryFn: () =>
      compareWorkflowRevisions({ beforeRevisionId, afterRevisionId }),
    staleTime: Infinity,
    retry: false,
  });
  const changes = useMemo(
    () =>
      query.data
        ? diffWorkflow(
            query.data.before ?? {
              nodes: [],
              edges: [],
              settings: query.data.after.settings,
            },
            query.data.after,
          )
        : [],
    [query.data],
  );
  const semantic = changes.filter((change) => change.kind !== 'layout');
  return (
    <div className='flex w-full flex-wrap items-center gap-2 rounded-lg border p-3'>
      <GitCompareArrowsIcon className='text-muted-foreground size-4' />
      <div className='flex min-w-0 flex-1 flex-col gap-1'>
        <p className='font-medium'>{t('workflowDiff.saved')}</p>
        <p className='text-muted-foreground text-xs'>
          {query.data
            ? semantic.length
              ? t('workflowDiff.summary', {
                  added: semantic.filter((item) => item.status === 'added')
                    .length,
                  modified: semantic.filter(
                    (item) => item.status === 'modified',
                  ).length,
                  removed: semantic.filter((item) => item.status === 'removed')
                    .length,
                })
              : t(
                  changes.length
                    ? 'workflowDiff.layoutOnly'
                    : 'workflowDiff.noChanges',
                )
            : t(
                query.isError
                  ? 'workflowDiff.loadError'
                  : 'workflowDiff.loading',
              )}
        </p>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger render={<Button variant='outline' size='sm' />}>
          {t('workflowDiff.view')}
        </DialogTrigger>
        <DialogContent className='workrun-shell workrun-editor-panel flex h-[92dvh] max-w-[calc(100%-1rem)] flex-col sm:max-w-[min(90rem,calc(100%-3rem))]'>
          <DialogHeader className='workrun-topbar shrink-0 pr-8 pb-4'>
            <DialogTitle>
              {query.data?.after.settings.name ?? t('workflowDiff.title')}
            </DialogTitle>
            <DialogDescription>{t('workflowDiff.title')}</DialogDescription>
          </DialogHeader>
          {query.data ? (
            <Suspense fallback={<Spinner />}>
              <WorkflowDiffView
                key={`${beforeRevisionId ?? ''}:${afterRevisionId}`}
                comparison={query.data}
              />
            </Suspense>
          ) : (
            <div className='flex flex-1 flex-col items-center justify-center gap-3'>
              {query.isPending ? (
                <Spinner />
              ) : (
                <>
                  <p>{t('workflowDiff.loadError')}</p>
                  <Button
                    variant='outline'
                    onClick={() => void query.refetch()}
                  >
                    {t('workflowDiff.retry')}
                  </Button>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
