import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Spinner,
} from '@workspace/ui/components';
import { HistoryIcon, PlayIcon } from 'lucide-react';

import type { RunRecordSummary, RunStatus } from '@/services/run-history';

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

function WorkflowHistory({
  runs,
  isLoading,
  hasMore,
  isLoadingMore,
  onLoadMore,
  onView,
}: {
  runs: RunRecordSummary[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  onView: (id: string) => void;
}) {
  return (
    <div className='bg-muted/20 flex min-h-0 flex-1 flex-col overflow-y-auto bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_95%_93%/0.5),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_95%_94%/0.24),transparent)] p-5 sm:p-7 dark:bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_70%_20%/0.32),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_70%_18%/0.18),transparent)]'>
      <div className='mx-auto flex w-full max-w-4xl flex-col gap-5'>
        <div>
          <div className='text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
            <HistoryIcon className='size-3.5' /> Run history
          </div>
          <h2 className='text-xl font-semibold tracking-tight'>
            Workflow executions
          </h2>
          <p className='text-muted-foreground mt-1 text-sm'>
            Review past runs without leaving this workflow.
          </p>
        </div>
        {isLoading ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner /> Loading runs…
          </div>
        ) : runs.length ? (
          <>
            <ItemGroup>
              {runs.map((run) => (
                <Item
                  key={run.id}
                  variant='outline'
                  className='bg-card/50 border-l-4 border-l-violet-400/60'
                >
                  <ItemContent>
                    <ItemTitle>
                      {new Date(run.startedAt).toLocaleString()}
                    </ItemTitle>
                    <ItemDescription>
                      {run.durationMs !== undefined
                        ? `${(run.durationMs / 1000).toFixed(1)}s`
                        : 'Duration unavailable'}
                      {run.error ? ` · ${run.error}` : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge
                      variant='outline'
                      className={RUN_STATUS_STYLES[run.status]}
                    >
                      {run.status}
                    </Badge>
                    <Button size='sm' onClick={() => onView(run.id)}>
                      <PlayIcon data-icon='inline-start' /> View output
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
            {hasMore ? (
              <div className='flex justify-center'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={isLoadingMore}
                  onClick={onLoadMore}
                >
                  {isLoadingMore ? <Spinner data-icon='inline-start' /> : null}
                  Load more
                </Button>
              </div>
            ) : (
              <p className='text-muted-foreground text-center text-xs'>
                All runs loaded
              </p>
            )}
          </>
        ) : (
          <Empty className='min-h-64 border border-dashed'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>No runs yet</EmptyTitle>
              <EmptyDescription>
                Run this workflow to create its first record.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

export { WorkflowHistory };
