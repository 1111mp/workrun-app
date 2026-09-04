import { useInfiniteQuery } from '@tanstack/react-query';
import {
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
  BoxesIcon,
  HistoryIcon,
  ListFilterIcon,
  RefreshCwIcon,
  SearchIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import {
  AppRunOutputPanel,
  type ProcessNodeRun,
} from '@/components/app-run-output-panel';
import {
  inspectRunRecord,
  listRunHistoryPage,
  type RunHistoryCursor,
  type RunStatus,
  type RunTargetType,
} from '@/services/run-history';

const targetFilters: { label: string; value?: RunTargetType }[] = [
  { label: 'All' },
  { label: 'Workflows', value: 'workflow' },
  { label: 'Apps', value: 'app' },
];

const statusFilters: { label: string; value?: RunStatus }[] = [
  { label: 'Any status' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
  { label: 'Interrupted', value: 'interrupted' },
  { label: 'Running', value: 'running' },
];

const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  completed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  interrupted:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

function RunsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [appOutputRun, setAppOutputRun] = useState<ProcessNodeRun>();
  const [appOutputOpen, setAppOutputOpen] = useState(false);
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

  const updateFilter = (name: string, value?: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set(name, value);
    else next.delete(name);
    setSearchParams(next);
  };

  const viewAppOutput = async (id: string) => {
    try {
      const record = await inspectRunRecord(id);
      if (record.targetType !== 'app') return;
      setAppOutputRun(record.outputView as ProcessNodeRun);
      setAppOutputOpen(true);
    } catch (error) {
      toast.error('Could not load run output', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className='size-full overflow-y-auto'>
      <div className='mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:py-8'>
        <section className='via-card relative overflow-hidden rounded-2xl border border-sky-200/70 bg-linear-to-br from-sky-500/12 to-violet-500/10 shadow-sm dark:border-sky-400/15'>
          <div className='pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,hsl(214_90%_60%/0.14)_1px,transparent_1px),linear-gradient(to_bottom,hsl(214_90%_60%/0.14)_1px,transparent_1px)] [background-size:28px_28px]' />
          <div className='relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-end lg:justify-between'>
            <div className='max-w-xl'>
              <div className='text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
                <HistoryIcon className='size-3.5' />
                Local execution archive
              </div>
              <h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                Run history
              </h1>
              <p className='text-muted-foreground mt-2 text-sm leading-6'>
                Browse and replay saved Workflow and App executions from this device.
              </p>
            </div>
            <div className='bg-background/70 flex divide-x divide-sky-200/70 rounded-xl border border-sky-200/70 shadow-xs backdrop-blur-sm dark:divide-sky-400/15 dark:border-sky-400/15'>
              <Metric label='Loaded' value={`${historyItems.length} runs`} />
              <Metric label='Completed' value={`${completedCount} runs`} />
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
                aria-label='Filter by Workflow or App name'
                placeholder='Search Workflow or App name…'
                value={nameQuery}
                onChange={(event) => updateFilter('q', event.target.value)}
              />
            </InputGroup>
            <div className='flex flex-wrap items-center gap-1'>
              <ListFilterIcon className='text-muted-foreground mr-1 size-4' />
              {targetFilters.map((filter) => (
                <Button
                  key={filter.label}
                  size='sm'
                  variant={
                    targetType === (filter.value ?? null)
                      ? 'secondary'
                      : 'ghost'
                  }
                  onClick={() => updateFilter('targetType', filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
            <div className='flex flex-wrap items-center gap-1 lg:ml-auto'>
              {statusFilters.map((filter) => (
                <Button
                  key={filter.label}
                  size='sm'
                  variant={
                    status === (filter.value ?? null) ? 'secondary' : 'ghost'
                  }
                  onClick={() => updateFilter('status', filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
              <Button
                aria-label='Refresh run history'
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
          <h2 className='text-sm font-semibold'>Saved executions</h2>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {historyItems.length} loaded run
            {historyItems.length === 1 ? '' : 's'}
          </p>
        </div>

        {runs.isPending ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner /> Loading run history…
          </div>
        ) : null}
        {runs.isError ? (
          <p className='text-destructive text-sm'>Could not load run history.</p>
        ) : null}
        {!runs.isPending && historyItems.length === 0 ? (
          <Empty className='min-h-64 border border-dashed'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>
                {status || nameQuery || targetType || targetId
                  ? 'No matching runs'
                  : 'No runs yet'}
              </EmptyTitle>
              <EmptyDescription>
                {status || nameQuery || targetType || targetId
                  ? 'Try a different name, type, or status filter.'
                  : 'Run a Workflow or App to see its output here.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        <ItemGroup className='gap-2'>
          {historyItems.map((run) => {
            const isWorkflow = run.targetType === 'workflow';
            const Icon = isWorkflow ? WorkflowIcon : BoxesIcon;
            const target = `/workflows/${run.targetId}?runId=${run.id}`;
            return (
              <Item
                key={run.id}
                variant='outline'
                size='sm'
                className='border-l-4 border-l-violet-400/60 bg-violet-500/[0.035] hover:bg-violet-500/[0.065] dark:border-l-violet-400/40'
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
                    {isWorkflow ? 'Workflow' : 'App'} ·{' '}
                    {new Date(run.startedAt).toLocaleString()}
                    {run.durationMs !== undefined
                      ? ` · ${(run.durationMs / 1000).toFixed(1)}s`
                      : ''}
                    {run.error ? ` · ${run.error}` : ''}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className='ml-auto'>
                  <Badge
                    variant='outline'
                    className={RUN_STATUS_STYLES[run.status]}
                  >
                    {run.status}
                  </Badge>
                  {isWorkflow ? (
                    <Button
                      size='sm'
                      nativeButton={false}
                      render={<Link to={target} />}
                    >
                      View output
                    </Button>
                  ) : (
                    <Button
                      size='sm'
                      onClick={() => void viewAppOutput(run.id)}
                    >
                      View output
                    </Button>
                  )}
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
              {runs.isFetchingNextPage ? <Spinner data-icon='inline-start' /> : null}
              Load more
            </Button>
          </div>
        ) : historyItems.length ? (
          <p className='text-muted-foreground text-center text-xs'>
            All runs loaded
          </p>
        ) : null}
      </div>
      <AppRunOutputPanel
        open={appOutputOpen}
        run={appOutputRun}
        readOnly
        onOpenChange={setAppOutputOpen}
        onClear={() => undefined}
        onRunAgain={() => undefined}
      />
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
