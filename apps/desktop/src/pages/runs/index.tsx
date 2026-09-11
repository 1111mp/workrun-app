import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  Spinner,
} from '@workspace/ui/components';
import {
  AppWindowIcon,
  HistoryIcon,
  Info,
  ListFilterIcon,
  RefreshCwIcon,
  SearchIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import {
  ensurePublishedProcessNode,
  getPublishedProcessNodeRelease,
} from '@/services/process-node';
import {
  getReplayMissingDependencies,
  listRunHistoryPage,
  replayRun,
  type RunHistoryCursor,
  type RunRecordSummary,
  type RunStatus,
  type RunTargetType,
} from '@/services/run-history';
import { useRunWorkspaceStore } from '@/stores';

const targetFilters: RunTargetType[] = ['workflow', 'app'];

const statusFilters: RunStatus[] = [
  'queued',
  'running',
  'waiting_for_input',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  queued: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  completed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  cancelled: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  interrupted:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  waiting_for_input:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

const REPLAYABLE_RUN_STATUSES: RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

function RunsPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const openWorkspaceRun = useRunWorkspaceStore((state) => state.openRun);
  const [runToReplay, setRunToReplay] = useState<RunRecordSummary>();
  const targetType = searchParams.get('targetType') as RunTargetType | null;
  const targetId = searchParams.get('targetId') ?? undefined;
  const status = searchParams.get('status') as RunStatus | null;
  const nameQuery = searchParams.get('q') ?? '';
  const runs = useInfiniteQuery({
    queryKey: ['run-history', targetType, targetId, status, nameQuery],
    queryFn: ({ pageParam }) =>
      listRunHistoryPage({
        targetType: targetType ?? undefined,
        targetId,
        status: status ?? undefined,
        query: nameQuery,
        pageSize: 30,
        cursor: pageParam,
      }),
    initialPageParam: undefined as RunHistoryCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
  });
  const historyItems = useMemo(
    () => runs.data?.pages.flatMap((page) => page.items) ?? [],
    [runs.data],
  );
  const completedCount = historyItems.filter(
    (run) => run.status === 'completed',
  ).length;
  const replay = useMutation({
    mutationFn: async (sourceRunId: string) => {
      const missing = await getReplayMissingDependencies(sourceRunId);
      const toastId = `replay-dependencies-${sourceRunId}`;
      try {
        for (const dependency of missing) {
          const release = await getPublishedProcessNodeRelease(
            dependency.remoteAppId,
            dependency.releaseId,
          );
          if (
            release.definition.remoteArchiveSha256 !== dependency.archiveSha256
          ) {
            throw new Error(
              `Team App ${dependency.remoteAppId} v${dependency.version} no longer matches this run`,
            );
          }
          await ensurePublishedProcessNode(
            release,
            (progress) => {
              toast.loading('Restoring Team App release', {
                id: toastId,
                toasterId: 'global',
                description: `${dependency.remoteAppId} · v${dependency.version} — ${progress.stage}`,
              });
            },
            dependency.installationScope,
          );
        }
      } finally {
        toast.dismiss(toastId);
      }
      return replayRun(sourceRunId);
    },
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ['run-history'] });
      openWorkspaceRun(run);
    },
    onError: (error) => {
      toast.error(t('runs.replayFailed'), {
        description: error instanceof Error ? error.message : String(error),
        toasterId: 'global',
      });
    },
  });

  const updateFilter = (name: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next);
  };

  return (
    <div className='size-full overflow-y-auto'>
      <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8'>
        <section className='via-card relative overflow-hidden rounded-2xl border border-sky-200/70 bg-linear-to-br from-sky-500/12 to-violet-500/10 shadow-sm dark:border-sky-400/15'>
          <div className='pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(214_90%_60%/0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[28px_28px]' />
          <div className='relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between'>
            <div className='max-w-xl'>
              <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
                <HistoryIcon className='size-3.5' />
                {t('runs.eyebrow')}
              </div>
              <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                {t('runs.title')}
              </h1>
              <p className='text-muted-foreground mt-2 text-sm leading-6'>
                {t('runs.description')}
              </p>
            </div>
            <div className='bg-background/70 flex divide-x divide-sky-200/70 rounded-xl border border-sky-200/70 shadow-xs backdrop-blur-sm dark:divide-sky-400/15 dark:border-sky-400/15'>
              <Metric
                label={t('runs.loaded')}
                value={t('runs.count', { count: historyItems.length })}
              />
              <Metric
                label={t('runs.completed')}
                value={t('runs.count', { count: completedCount })}
              />
            </div>
          </div>
        </section>

        <section className='bg-card rounded-xl border p-3 shadow-sm sm:p-4'>
          <div className='flex flex-col gap-3 lg:flex-row lg:items-center'>
            <InputGroup className='lg:max-w-sm'>
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label={t('runs.searchLabel')}
                placeholder={t('runs.searchPlaceholder')}
                value={nameQuery}
                onChange={(event) => updateFilter('q', event.target.value)}
              />
            </InputGroup>
            <div className='flex flex-wrap items-center gap-1'>
              <ListFilterIcon className='text-muted-foreground mr-1 size-4' />
              <Button
                size='sm'
                variant={targetType === null ? 'secondary' : 'ghost'}
                onClick={() => updateFilter('targetType')}
              >
                {t('runs.targetFilters.all')}
              </Button>
              {targetFilters.map((filter) => (
                <Button
                  key={filter}
                  size='sm'
                  variant={targetType === filter ? 'secondary' : 'ghost'}
                  onClick={() => updateFilter('targetType', filter)}
                >
                  {t(`runs.targetFilters.${filter}`)}
                </Button>
              ))}
            </div>
            <div className='flex flex-wrap items-center gap-1 lg:ml-auto'>
              <Button
                size='sm'
                variant={status === null ? 'secondary' : 'ghost'}
                onClick={() => updateFilter('status')}
              >
                {t('runs.statusFilters.all')}
              </Button>
              {statusFilters.map((filter) => (
                <Button
                  key={filter}
                  size='sm'
                  variant={status === filter ? 'secondary' : 'ghost'}
                  onClick={() => updateFilter('status', filter)}
                >
                  {t(`runs.runStatus.${filter}`)}
                </Button>
              ))}
              <Button
                aria-label={t('runs.refresh')}
                size='icon-sm'
                variant='ghost'
                disabled={runs.isFetching}
                onClick={() => void runs.refetch()}
              >
                {runs.isFetching ? <Spinner /> : <RefreshCwIcon />}
              </Button>
            </div>
          </div>
        </section>

        <div>
          <h2 className='text-sm font-semibold'>{t('runs.savedExecutions')}</h2>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('runs.loadedCount', { count: historyItems.length })}
          </p>
        </div>

        {runs.isPending ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner /> {t('runs.loading')}
          </div>
        ) : null}
        {runs.isError ? (
          <p className='text-destructive text-sm'>{t('runs.loadError')}</p>
        ) : null}
        {!runs.isPending && historyItems.length === 0 ? (
          <Empty className='min-h-64 border border-dashed'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>
                {status || nameQuery || targetType || targetId
                  ? t('runs.noMatchesTitle')
                  : t('runs.emptyTitle')}
              </EmptyTitle>
              <EmptyDescription>
                {status || nameQuery || targetType || targetId
                  ? t('runs.noMatchesDescription')
                  : t('runs.emptyDescription')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <ItemGroup className='gap-2'>
          {historyItems.map((run) => {
            const isWorkflow = run.targetType === 'workflow';
            const Icon = isWorkflow ? WorkflowIcon : AppWindowIcon;
            const canReplay = REPLAYABLE_RUN_STATUSES.includes(run.status);
            return (
              <Item
                key={run.id}
                variant='outline'
                size='sm'
                className='border-l-4 border-l-violet-400/60 bg-violet-500/[0.035] hover:bg-violet-500/6.5 dark:border-l-violet-400/40'
              >
                <ItemMedia
                  variant='icon'
                  className='size-8 rounded-md border border-violet-200/70 bg-violet-500/12 text-violet-700 dark:border-violet-400/15 dark:text-violet-300'
                >
                  <Icon />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{run.targetName}</ItemTitle>
                  <ItemDescription>
                    {isWorkflow ? t('runs.workflow') : t('apps.app')} ·{' '}
                    {new Date(run.startedAt).toLocaleString(i18n.language)}
                    {run.releaseVersion ? ` · v${run.releaseVersion}` : ''}
                    {run.durationMs !== undefined
                      ? t('runs.duration', {
                          seconds: (run.durationMs / 1000).toFixed(1),
                        })
                      : ''}
                    {run.error ? ` · ${run.error}` : ''}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className='ml-auto'>
                  <Badge
                    variant='outline'
                    className={RUN_STATUS_STYLES[run.status]}
                  >
                    {t(`runs.runStatus.${run.status}`)}
                  </Badge>
                  <Button
                    size='sm'
                    onClick={() => {
                      if (isWorkflow) {
                        void navigate(
                          `/workflows/${run.targetId}?runId=${run.id}`,
                        );
                      } else {
                        openWorkspaceRun(run);
                      }
                    }}
                  >
                    {t('runs.viewOutput')}
                  </Button>
                  {canReplay ? (
                    <Button
                      size='sm'
                      variant='secondary'
                      disabled={replay.isPending}
                      onClick={() => setRunToReplay(run)}
                    >
                      {run.error ===
                      'Execution did not start before Workrun restarted.'
                        ? t('runs.run')
                        : t('runs.rerun')}
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            );
          })}
        </ItemGroup>
        {runs.hasNextPage ? (
          <div className='flex justify-center pt-1'>
            <Button
              variant='outline'
              size='sm'
              disabled={runs.isFetchingNextPage}
              onClick={() => void runs.fetchNextPage()}
            >
              {runs.isFetchingNextPage ? (
                <Spinner data-icon='inline-start' />
              ) : null}
              {t('runs.loadMore')}
            </Button>
          </div>
        ) : historyItems.length ? (
          <p className='text-muted-foreground text-center text-xs'>
            {t('runs.allLoaded')}
          </p>
        ) : null}
      </div>
      <AlertDialog
        open={Boolean(runToReplay)}
        onOpenChange={(open) => {
          if (!open && !replay.isPending) setRunToReplay(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <Info />
            </AlertDialogMedia>
            <AlertDialogTitle>{t('runs.replayTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('runs.replayDescription', {
                name: runToReplay?.targetName,
                targetType:
                  runToReplay?.targetType === 'workflow'
                    ? t('runs.workflow')
                    : t('apps.app'),
              })}
              {runToReplay?.targetType === 'workflow'
                ? ` ${t('runs.replayWorkflowNote')}`
                : ''}{' '}
              {t('runs.replayRecordNote')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={replay.isPending}>
              {t('apps.new.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={replay.isPending}
              onClick={() => runToReplay && replay.mutate(runToReplay.id)}
            >
              {replay.isPending ? <Spinner data-icon='inline-start' /> : null}
              {t('runs.createNew')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className='px-4 py-2.5'>
      <div className='text-muted-foreground text-[11px] font-medium tracking-wide uppercase'>
        {label}
      </div>
      <div className='mt-0.5 text-sm font-semibold tabular-nums'>{value}</div>
    </div>
  );
}

export { RunsPage as Component };
