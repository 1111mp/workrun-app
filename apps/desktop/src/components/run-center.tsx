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
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
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
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';

import { cancelBackgroundProcessNodeRun } from '@/services/process-node';
import {
  runCenterEntries,
  runDetailsPath,
  type RunCenterEntry,
} from '@/services/run-center';
import {
  listActiveRuns,
  listPendingActions,
  type PendingAction,
  type RunRecordSummary,
  type RunStatus,
} from '@/services/run-history';
import { cancelBackgroundWorkflowRun } from '@/services/workflow';
import { useRunWorkspaceStore, useWorkrunStore } from '@/stores';

function elapsed(startedAt: string, t: ReturnType<typeof useTranslation>['t']) {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
  );
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return minutes > 0
    ? t('runCenter.elapsedWithMinutes', { minutes, seconds: remainingSeconds })
    : t('runCenter.elapsedSeconds', { seconds: remainingSeconds });
}

const statusTone: Record<RunStatus, { icon: string; badge: string }> = {
  waiting_for_input: {
    icon: 'text-amber-600 dark:text-amber-400',
    badge:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
  running: {
    icon: 'text-sky-600 dark:text-sky-400',
    badge: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  },
  queued: {
    icon: 'text-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
  completed: {
    icon: 'text-emerald-600 dark:text-emerald-400',
    badge:
      'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  },
  failed: {
    icon: 'text-destructive',
    badge: 'border-destructive/30 bg-destructive/10 text-destructive',
  },
  cancelled: {
    icon: 'text-muted-foreground',
    badge: 'bg-muted text-muted-foreground',
  },
  interrupted: {
    icon: 'text-amber-600 dark:text-amber-400',
    badge:
      'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  },
};

function ActiveRunRow({
  entry,
  onCancel,
  onOpen,
}: {
  entry: RunCenterEntry;
  onCancel?: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const { run, actions, runCount } = entry;
  const status = actions.length ? 'waiting_for_input' : run.status;
  const tone = statusTone[status];
  const Icon =
    status === 'waiting_for_input'
      ? CircleAlertIcon
      : status === 'queued'
        ? Clock3Icon
        : PlayIcon;
  return (
    <div className='hover:bg-muted/70 flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors'>
      <button
        className='focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 text-left outline-none focus-visible:ring-2'
        type='button'
        onClick={onOpen}
      >
        <Icon className={cn('size-4 shrink-0', tone.icon)} />
        <span className='min-w-0 flex-1'>
          <span className='block truncate font-medium'>{run.targetName}</span>
          <span className='text-muted-foreground mt-0.5 block text-xs'>
            {run.targetType === 'workflow' ? t('runs.workflow') : t('apps.app')}{' '}
            · {t('runCenter.started', { elapsed: elapsed(run.startedAt, t) })}
            {actions[0] ? ` · ${actionLabel(actions[0], t)}` : ''}
            {actions.length > 1
              ? ` · ${t('runCenter.attentionCount', { count: actions.length })}`
              : ''}
            {runCount > 1
              ? ` · ${t('runCenter.concurrentCount', { count: runCount })}`
              : ''}
          </span>
        </span>
      </button>
      <Badge variant='outline' className={tone.badge}>
        {t(`runs.runStatus.${status}`)}
      </Badge>
      {onCancel ? (
        <Button size='sm' variant='ghost' onClick={onCancel}>
          {t('runCenter.cancel')}
        </Button>
      ) : null}
    </div>
  );
}

function actionLabel(
  action: PendingAction,
  t: ReturnType<typeof useTranslation>['t'],
) {
  switch (action.kind) {
    case 'tool_approval':
      return t('runCenter.actions.toolApproval');
    case 'human_review':
      return t('runCenter.actions.humanReview');
    case 'ask_user_question':
      return t('runCenter.actions.askQuestion');
  }
}

/**
 * A shell-level observer for runs. It intentionally reads the durable archive
 * instead of a page's local state, so closing an output drawer never hides a
 * task from the rest of the application.
 */
function RunCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cancellingRunId, setCancellingRunId] = useState<string>();

  const { pathname } = useLocation();
  const navigate = useNavigate();

  const isRunSurface =
    pathname.startsWith('/workflows') || pathname.startsWith('/apps');

  const workspaceMode = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );

  const activeRuns = useQuery({
    queryKey: ['run-history', 'active', workspaceMode],
    queryFn: listActiveRuns,
    enabled: isRunSurface,
  });
  const pendingActions = useQuery({
    queryKey: ['run-history', 'pending-actions', workspaceMode],
    queryFn: () => listPendingActions(),
    enabled: isRunSurface,
  });

  if (!isRunSurface) return null;

  const entries = runCenterEntries(
    activeRuns.data ?? [],
    pendingActions.data ?? [],
  );
  const waitingEntries = entries.filter(
    (entry) => entry.actions.length || entry.run.status === 'waiting_for_input',
  );
  const attentionCount = waitingEntries.length;
  const runningCount = entries.filter(
    (entry) => entry.run.status === 'running' && !entry.actions.length,
  ).length;
  const queuedCount = entries.filter(
    (entry) => entry.run.status === 'queued' && !entry.actions.length,
  ).length;
  const isIdle = entries.length === 0;

  const openRun = (entry: RunCenterEntry) => {
    setOpen(false);
    const action = entry.actions.find(
      (action) => action.runId === entry.run.id,
    );
    const workspace = useRunWorkspaceStore.getState();
    workspace.setOpen(false);
    workspace.requestAction(action?.id);
    void navigate(runDetailsPath(entry.run));
  };

  const cancelRun = async (run: RunRecordSummary) => {
    setCancellingRunId(run.id);
    try {
      if (run.targetType === 'workflow')
        await cancelBackgroundWorkflowRun(run.id);
      else await cancelBackgroundProcessNodeRun(run.id);
      toast.success(
        t('runCenter.cancelled', {
          targetType:
            run.targetType === 'workflow' ? t('runs.workflow') : t('apps.app'),
        }),
        { toasterId: 'global' },
      );
    } catch (error) {
      toast.error(t('runCenter.cancelFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCancellingRunId(undefined);
    }
  };

  const runList = (filter: 'all' | 'pending') => (
    <ScrollArea className='min-h-0 flex-1 px-3 py-3'>
      {isIdle || (filter === 'pending' && attentionCount === 0) ? (
        <div className='flex min-h-52 flex-col items-center justify-center px-5 py-8 text-center'>
          <span className='mb-4 flex size-11 items-center justify-center rounded-2xl border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'>
            <CircleCheckIcon className='size-5' />
          </span>
          <p className='text-sm font-medium'>
            {t(
              filter === 'pending'
                ? 'runCenter.noPending'
                : 'runCenter.emptyTitle',
            )}
          </p>
          <p className='text-muted-foreground mt-1 max-w-sm text-sm leading-5'>
            {t(
              filter === 'pending'
                ? 'runCenter.noPendingDescription'
                : 'runCenter.emptyDescription',
            )}
          </p>
          <div className='text-muted-foreground mt-5 flex items-center gap-4 text-xs'>
            <span className='flex items-center gap-1.5'>
              <WorkflowIcon className='size-3.5 text-sky-600 dark:text-sky-400' />
              {t('runs.targetFilters.workflow')}
            </span>
            <span className='flex items-center gap-1.5'>
              <AppWindowIcon className='size-3.5 text-violet-600 dark:text-violet-400' />
              {t('runs.targetFilters.app')}
            </span>
          </div>
        </div>
      ) : null}
      {(filter === 'pending' ? waitingEntries : entries).map((entry) => (
        <ActiveRunRow
          key={`${entry.run.targetType}:${entry.run.targetId}`}
          entry={entry}
          onCancel={
            cancellingRunId !== entry.run.id
              ? () => void cancelRun(entry.run)
              : undefined
          }
          onOpen={() => openRun(entry)}
        />
      ))}
    </ScrollArea>
  );

  return (
    <>
      <button
        aria-label={t('runCenter.open')}
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
          <span className='shrink-0 text-sm font-medium'>
            {t('runCenter.title')}
          </span>
          <span className='text-muted-foreground truncate text-xs'>
            {attentionCount > 0
              ? t('runCenter.needsAttention', { count: attentionCount })
              : isIdle
                ? t('runCenter.idleSummary')
                : queuedCount > 0
                  ? t('runCenter.activeSummaryWithQueue', {
                      running: runningCount,
                      queued: queuedCount,
                    })
                  : t('runCenter.activeSummary', { running: runningCount })}
          </span>
        </span>
        <span className='hidden items-center gap-1.5 sm:flex'>
          {attentionCount > 0 ? (
            <Badge
              className='border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              variant='outline'
            >
              {t('runCenter.attentionCount', { count: attentionCount })}
            </Badge>
          ) : isIdle ? (
            <Badge
              className='border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              variant='outline'
            >
              {t('runCenter.ready')}
            </Badge>
          ) : (
            <Badge variant='secondary'>
              {t('runCenter.activeCount', { count: entries.length })}
            </Badge>
          )}
        </span>
        <span className='text-muted-foreground flex shrink-0 items-center gap-1 text-xs'>
          <span className='hidden sm:inline'>{t('runCenter.view')}</span>{' '}
          <ChevronUpIcon className='size-3.5' />
        </span>
      </button>
      <Drawer open={open} onOpenChange={setOpen} snapPoints={['31rem']}>
        <DrawerContent>
          <DrawerHeader className='border-b px-5 py-4 text-left'>
            <DrawerTitle className='flex items-center gap-2 text-base'>
              <ListTodoIcon className='size-4' /> {t('runCenter.title')}
            </DrawerTitle>
            <DrawerDescription>{t('runCenter.description')}</DrawerDescription>
          </DrawerHeader>
          <Tabs defaultValue='all' className='min-h-0 flex-1'>
            <TabsList className='mx-5 mt-3'>
              <TabsTrigger value='all'>{t('runCenter.all')}</TabsTrigger>
              <TabsTrigger value='pending'>
                {t('runCenter.pending')} · {attentionCount}
              </TabsTrigger>
            </TabsList>
            <TabsContent value='all' className='flex min-h-0 flex-1'>
              {runList('all')}
            </TabsContent>
            <TabsContent value='pending' className='flex min-h-0 flex-1'>
              {runList('pending')}
            </TabsContent>
          </Tabs>
          <div className='flex shrink-0 justify-end border-t px-5 py-3'>
            <Button variant='outline' onClick={() => setOpen(false)}>
              {t('apps.close')}
            </Button>
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}

export { RunCenter };
