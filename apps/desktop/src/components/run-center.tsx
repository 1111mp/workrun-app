import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  ScrollArea,
} from '@workspace/ui/components';
import {
  AppWindowIcon,
  ChevronUpIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  Clock3Icon,
  ListTodoIcon,
  PlayIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useLocation } from 'react-router';
import { toast } from 'sonner';

import { cancelBackgroundProcessNodeRun } from '@/services/process-node';
import {
  listActiveRuns,
  listPendingActions,
  type PendingAction,
  type RunRecordSummary,
} from '@/services/run-history';
import { cancelBackgroundWorkflowRun } from '@/services/workflow';
import { useRunWorkspaceStore } from '@/stores';

const statusLabel = {
  queued: 'Queued',
  running: 'Running',
  waiting_for_input: 'Needs attention',
} as const;

function elapsed(startedAt: string) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0
    ? `${minutes}m ${remainingSeconds}s`
    : `${remainingSeconds}s`;
}

function ActiveRunRow({
  run,
  onCancel,
  onOpenHistory,
}: {
  run: RunRecordSummary;
  onCancel?: () => void;
  onOpenHistory: () => void;
}) {
  const isWaiting = run.status === 'waiting_for_input';
  return (
    <div className='hover:bg-muted/70 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors'>
      <button
        className='focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2'
        type='button'
        onClick={onOpenHistory}
      >
        {isWaiting ? (
          <CircleAlertIcon className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />
        ) : (
          <PlayIcon className='size-4 shrink-0 text-sky-600 dark:text-sky-400' />
        )}
        <span className='min-w-0 flex-1'>
          <span className='block truncate font-medium'>{run.targetName}</span>
          <span className='text-muted-foreground mt-0.5 block text-xs'>
            {run.targetType === 'workflow' ? 'Workflow' : 'App'} · started{' '}
            {elapsed(run.startedAt)} ago
          </span>
        </span>
      </button>
      <Badge variant={isWaiting ? 'outline' : 'secondary'}>
        {statusLabel[run.status as keyof typeof statusLabel] ?? run.status}
      </Badge>
      {onCancel ? (
        <Button size='sm' variant='ghost' onClick={onCancel}>
          Cancel
        </Button>
      ) : null}
    </div>
  );
}

function actionLabel(action: PendingAction) {
  switch (action.kind) {
    case 'tool_approval':
      return 'Approve tool use';
    case 'human_review':
      return 'Review workflow step';
    case 'ask_user_question':
      return 'Answer workflow question';
  }
}

/**
 * A shell-level observer for runs. It intentionally reads the durable archive
 * instead of a page's local state, so closing an output drawer never hides a
 * task from the rest of the application.
 */
function RunCenter() {
  const [open, setOpen] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string>();

  const { pathname } = useLocation();
  console.log('pathname', pathname);

  const isRunSurface = pathname === '/workflows' || pathname === '/apps';

  const openWorkspaceRun = useRunWorkspaceStore((state) => state.openRun);

  const activeRuns = useQuery({
    queryKey: ['run-history', 'active'],
    queryFn: listActiveRuns,
    enabled: isRunSurface,
  });
  const pendingActions = useQuery({
    queryKey: ['run-history', 'pending-actions'],
    queryFn: listPendingActions,
    enabled: isRunSurface,
  });

  if (!isRunSurface) return null;

  const runs = activeRuns.data ?? [];
  const attentionCount = pendingActions.data?.length ?? 0;
  const runningCount = runs.filter((run) => run.status === 'running').length;
  const queuedCount = runs.filter((run) => run.status === 'queued').length;
  const activeWorkCount = runs.filter(
    (run) => run.status !== 'waiting_for_input',
  ).length;
  const isIdle = runs.length === 0 && attentionCount === 0;

  const openRun = (run: RunRecordSummary) => {
    setOpen(false);
    openWorkspaceRun(run);
  };

  const cancelRun = async (run: RunRecordSummary) => {
    setCancellingRunId(run.id);
    try {
      if (run.targetType === 'workflow')
        await cancelBackgroundWorkflowRun(run.id);
      else await cancelBackgroundProcessNodeRun(run.id);
      toast.success(
        `${run.targetType === 'workflow' ? 'Workflow' : 'App'} cancelled`,
        { toasterId: 'global' },
      );
    } catch (error) {
      toast.error('Could not cancel run', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCancellingRunId(undefined);
    }
  };

  return (
    <>
      <button
        aria-label='Open Run Center'
        className='bg-background/30 hover:bg-muted/30 focus-visible:ring-ring flex h-10 shrink-0 items-center gap-2 border-t px-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-inset'
        type='button'
        onClick={() => setOpen(true)}
      >
        <span
          className={
            attentionCount > 0
              ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400'
              : isIdle
                ? 'flex size-7 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400'
          }
        >
          {attentionCount > 0 ? (
            <CircleAlertIcon className='size-3.5' />
          ) : isIdle ? (
            <CircleCheckIcon className='size-3.5' />
          ) : (
            <Clock3Icon className='size-3.5' />
          )}
        </span>
        <span className='flex min-w-0 flex-1 items-center gap-2'>
          <span className='shrink-0 text-sm font-medium'>Run Center</span>
          <span className='text-muted-foreground truncate text-xs'>
            {attentionCount > 0
              ? `${attentionCount} item${attentionCount === 1 ? '' : 's'} need your attention`
              : isIdle
                ? 'Ready for your next Workflow or App run'
                : `${runningCount} running${queuedCount > 0 ? ` · ${queuedCount} queued` : ''}`}
          </span>
        </span>
        <span className='hidden items-center gap-1.5 sm:flex'>
          {attentionCount > 0 ? (
            <Badge
              className='border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              variant='outline'
            >
              {attentionCount} attention
            </Badge>
          ) : isIdle ? (
            <Badge
              className='border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              variant='outline'
            >
              Ready
            </Badge>
          ) : (
            <Badge variant='secondary'>{runs.length} active</Badge>
          )}
        </span>
        <span className='text-muted-foreground flex shrink-0 items-center gap-1 text-xs'>
          <span className='hidden sm:inline'>View</span>{' '}
          <ChevronUpIcon className='size-3.5' />
        </span>
      </button>
      <Drawer open={open} onOpenChange={setOpen} snapPoints={['31rem']}>
        <DrawerContent>
          <DrawerHeader className='border-b px-5 py-4 text-left'>
            <DrawerTitle className='flex items-center gap-2 text-base'>
              <ListTodoIcon className='size-4' /> Run Center
            </DrawerTitle>
            <DrawerDescription>
              Active work stays here when its originating page or output panel
              is closed.
            </DrawerDescription>
          </DrawerHeader>
          <ScrollArea className='min-h-0 flex-1 px-3 py-3'>
            {isIdle ? (
              <div className='flex min-h-52 flex-col items-center justify-center px-5 py-8 text-center'>
                <span className='mb-4 flex size-11 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'>
                  <CircleCheckIcon className='size-5' />
                </span>
                <p className='text-sm font-medium'>Nothing running right now</p>
                <p className='text-muted-foreground mt-1 max-w-sm text-sm leading-5'>
                  Start a run from Workflows or Apps. Its progress and any
                  requests for input will show up here.
                </p>
                <div className='text-muted-foreground mt-5 flex items-center gap-4 text-xs'>
                  <span className='flex items-center gap-1.5'>
                    <WorkflowIcon className='size-3.5 text-sky-600 dark:text-sky-400' />
                    Workflows
                  </span>
                  <span className='flex items-center gap-1.5'>
                    <AppWindowIcon className='size-3.5 text-violet-600 dark:text-violet-400' />
                    Apps
                  </span>
                </div>
              </div>
            ) : null}
            {attentionCount > 0 ? (
              <section className='mb-4'>
                <div className='text-muted-foreground mb-1.5 px-2 text-xs font-medium tracking-wide uppercase'>
                  Needs attention · {attentionCount}
                </div>
                {runs
                  .filter((run) => run.status === 'waiting_for_input')
                  .map((run) => (
                    <ActiveRunRow
                      key={run.id}
                      run={run}
                      onCancel={
                        run.targetType === 'workflow' &&
                        cancellingRunId !== run.id
                          ? () => void cancelRun(run)
                          : undefined
                      }
                      onOpenHistory={() => openRun(run)}
                    />
                  ))}
              </section>
            ) : null}
            {activeWorkCount > 0 ? (
              <section>
                <div className='text-muted-foreground mb-1.5 px-2 text-xs font-medium tracking-wide uppercase'>
                  Active runs · {activeWorkCount}
                </div>
                {runs
                  .filter((run) => run.status !== 'waiting_for_input')
                  .map((run) => (
                    <ActiveRunRow
                      key={run.id}
                      run={run}
                      onCancel={
                        run.targetType === 'app' && cancellingRunId !== run.id
                          ? () => void cancelRun(run)
                          : undefined
                      }
                      onOpenHistory={() => openRun(run)}
                    />
                  ))}
              </section>
            ) : null}
            {attentionCount > 0 ? (
              <section className='mt-4 border-t pt-4'>
                <div className='text-muted-foreground mb-1.5 px-2 text-xs font-medium tracking-wide uppercase'>
                  Approval queue · choose one to handle
                </div>
                {(pendingActions.data ?? []).map((action) => {
                  const run = runs.find((item) => item.id === action.runId);
                  if (!run) return null;
                  return (
                    <button
                      key={action.id}
                      className='hover:bg-muted/70 focus-visible:ring-ring flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2'
                      type='button'
                      onClick={() => openRun(run)}
                    >
                      <CircleAlertIcon className='size-4 shrink-0 text-amber-600 dark:text-amber-400' />
                      <span className='min-w-0 flex-1'>
                        <span className='block font-medium'>
                          {actionLabel(action)}
                        </span>
                        <span className='text-muted-foreground mt-0.5 block truncate text-xs'>
                          {run.targetName}
                        </span>
                      </span>
                      <Badge variant='outline'>Waiting</Badge>
                    </button>
                  );
                })}
              </section>
            ) : null}
          </ScrollArea>
          <div className='flex shrink-0 justify-end border-t px-5 py-3'>
            <Button variant='outline' onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export { RunCenter };
