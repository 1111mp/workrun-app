import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Empty,
  EmptyContent,
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
  ItemTitle,
  Progress,
  ProgressLabel,
  ProgressValue,
  Skeleton,
  Spinner,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import {
  ArrowLeftIcon,
  BoxIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  ClipboardIcon,
  CopyIcon,
  DownloadIcon,
  FilePenLineIcon,
  FolderOpenIcon,
  HistoryIcon,
  PackageSearchIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';

import {
  AppRunOutputContent,
  AppRunOutputPanel,
  restoreProcessNodeRun,
  type ProcessNodeOutput,
  type ProcessNodeRun,
} from '@/components/app-run-output-panel';
import { isTeamMode } from '@/lib/constant';
import {
  ensurePublishedProcessNode,
  getProcessNodes,
  startBackgroundProcessNodeRun,
  subscribeProcessNodeRun,
  type ProcessNode,
  type ProcessNodeInstallStatus,
  type ProcessNodeOutputChunk,
  type ProcessNodePreparationProgress,
} from '@/services/process-node';
import {
  inspectRunRecord,
  listRunHistoryPage,
  type RunHistoryCursor,
  type RunStatus,
} from '@/services/run-history';
import { useWorkrunStore } from '@/stores';

import { copyProjectPath, openProjectDirectory } from './project-path';

const MAX_OUTPUT_CHARS = 200_000;

type AppFilter = 'all' | ProcessNodeInstallStatus;
type AppPreparation = ProcessNodePreparationProgress & { error?: string };
type AppPreparationSummary = {
  outcome: 'current' | 'installed' | 'updated';
  version: string;
};

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

function appendOutput(current: string, chunk: string) {
  const next = current + chunk;
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return `[Earlier output truncated]\n${next.slice(-MAX_OUTPUT_CHARS)}`;
}

function StatusBadge({ status }: { status: ProcessNodeInstallStatus }) {
  const { t } = useTranslation();

  switch (status) {
    case 'installed':
      return (
        <Badge variant='secondary'>
          <CheckCircle2Icon data-icon='inline-start' />
          {t('apps.installStatus.installed')}
        </Badge>
      );
    case 'updateAvailable':
      return (
        <Badge variant='secondary'>
          <RefreshCwIcon data-icon='inline-start' />
          {t('apps.installStatus.updateAvailable')}
        </Badge>
      );
    case 'draft':
      return (
        <Badge variant='outline'>
          <FilePenLineIcon data-icon='inline-start' />
          {t('apps.installStatus.draft')}
        </Badge>
      );
    case 'invalid':
      return (
        <Badge variant='destructive'>
          <CircleAlertIcon data-icon='inline-start' />
          {t('apps.installStatus.invalid')}
        </Badge>
      );
    case 'notInstalled':
      return (
        <Badge variant='outline'>
          <DownloadIcon data-icon='inline-start' />
          {t('apps.installStatus.notInstalled')}
        </Badge>
      );
  }
}

function AppListSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
      {Array.from({ length: 3 }, (_, index) => (
        <Card key={index} size='sm'>
          <CardHeader>
            <Skeleton className='h-4 w-36' />
            <Skeleton className='h-4 w-24' />
            <CardAction>
              <Skeleton className='h-5 w-24 rounded-full' />
            </CardAction>
          </CardHeader>
          <CardContent>
            <Skeleton className='h-4 w-full' />
          </CardContent>
          <CardFooter>
            <Skeleton className='h-4 w-40' />
          </CardFooter>
        </Card>
      ))}
    </div>
  );
}

const appFilters: AppFilter[] = [
  'all',
  'draft',
  'installed',
  'updateAvailable',
  'notInstalled',
  'invalid',
];

function AppItem({
  node,
  run,
  preparation,
  preparationSummary,
  runsArePending,
  onRun,
  onViewOutput,
  onOpenHistory,
}: {
  node: ProcessNode;
  run?: ProcessNodeRun;
  preparation?: AppPreparation;
  preparationSummary?: AppPreparationSummary;
  runsArePending: boolean;
  onRun: () => void;
  onViewOutput: () => void;
  onOpenHistory: () => void;
}) {
  const { t } = useTranslation();
  const { definition } = node;
  const isToolApp = definition.kind === 'tool';
  const inputCount = Object.keys(definition.inputs).length;
  const outputCount = Object.keys(definition.outputs).length;
  const hasRun = Boolean(run);
  const isLocalApp = node.installStatus !== 'notInstalled';

  const preparationPercent =
    preparation?.stage === 'downloading' && preparation.totalBytes
      ? Math.min(
          100,
          Math.floor(
            (preparation.downloadedBytes / preparation.totalBytes) * 100,
          ),
        )
      : undefined;
  const preparationLabel = preparation
    ? preparation.error
      ? t('apps.preparation.failed')
      : preparation.stage === 'downloading'
        ? t('apps.preparation.downloadingUnknown')
        : t(`apps.preparation.${preparation.stage}`)
    : undefined;

  return (
    <Card
      size='sm'
      className={cn(
        'h-full transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:shadow-md',
        isToolApp
          ? 'border-sky-500/35 bg-sky-500/5 hover:border-sky-500/55'
          : 'border-violet-500/35 bg-violet-500/5 hover:border-violet-500/55',
      )}
    >
      <CardHeader>
        <div className='flex items-center gap-2'>
          <div
            className={cn(
              'flex size-8 items-center justify-center rounded-lg border',
              isToolApp
                ? 'border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300',
            )}
          >
            <BoxIcon className='size-4' />
          </div>
          <CardTitle>{definition.name}</CardTitle>
        </div>
        <CardDescription
          className='line-clamp-2 min-h-10'
          title={definition?.description}
        >
          {definition.description || t('apps.noDescription')}
        </CardDescription>
        <CardAction className='flex flex-col items-end gap-2'>
          <StatusBadge status={node.installStatus} />
          {run?.isRunning ? (
            <Badge variant='outline'>
              <Spinner data-icon='inline-start' />
              {t('apps.running')}
            </Badge>
          ) : null}
          {preparationSummary ? (
            <Badge variant='secondary'>
              <CheckCircle2Icon data-icon='inline-start' />
              {t(`apps.preparation.${preparationSummary.outcome}`, {
                version: preparationSummary.version,
              })}
            </Badge>
          ) : null}
        </CardAction>
      </CardHeader>
      <CardContent className='flex flex-1 flex-col gap-3'>
        <div className='text-muted-foreground flex items-center gap-2 text-xs'>
          <BoxIcon />
          <span>v{definition.version}</span>
          <Badge
            variant='outline'
            className={cn(
              isToolApp
                ? 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300'
                : 'border-violet-500/35 bg-violet-500/10 text-violet-700 dark:text-violet-300',
            )}
          >
            {isToolApp ? (
              <WrenchIcon data-icon='inline-start' />
            ) : (
              <BoxIcon data-icon='inline-start' />
            )}
            {isToolApp ? t('apps.toolApp') : t('apps.app')}
          </Badge>
          <span>{t('apps.inputCount', { count: inputCount })}</span>
          <span>{t('apps.outputCount', { count: outputCount })}</span>
        </div>
        {node.installStatus === 'invalid' && node.installError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>{t('apps.invalidInstallTitle')}</AlertTitle>
            <AlertDescription>{node.installError}</AlertDescription>
          </Alert>
        ) : null}
        <div className='mt-auto flex min-w-0 items-end gap-2'>
          <div className='min-w-0 flex-1'>
            <span className='text-muted-foreground text-xs'>
              {t('apps.nodeId')}
            </span>
            <code className='block truncate'>{definition.id}</code>
          </div>
          {isLocalApp ? (
            <div className='flex shrink-0 items-center gap-1'>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label={t('apps.openProjectDirectory')}
                onClick={() => void openProjectDirectory(definition.id)}
              >
                <FolderOpenIcon />
              </Button>
              <Button
                variant='ghost'
                size='icon-sm'
                aria-label={t('apps.copyProjectPath')}
                onClick={() => void copyProjectPath(node.projectPath)}
              >
                <CopyIcon />
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
      <CardFooter
        className={cn(
          'min-h-14 flex-nowrap gap-1',
          !preparation && 'justify-end',
        )}
      >
        {preparation ? (
          preparation.error ? (
            <div className='text-destructive flex min-w-0 flex-1 items-center gap-2 text-xs'>
              <CircleAlertIcon className='size-3.5 shrink-0' />
              <span className='truncate' title={preparation.error}>
                {preparation.error}
              </span>
              <Button
                variant='outline'
                size='sm'
                className='ml-auto shrink-0'
                onClick={onRun}
              >
                {t('apps.retry')}
              </Button>
            </div>
          ) : preparation.stage === 'checkingVersion' ? (
            <div className='flex min-w-0 flex-1 items-center gap-2 text-sm'>
              <Spinner className='text-muted-foreground size-3.5 shrink-0' />
              <span className='truncate font-medium'>{preparationLabel}</span>
            </div>
          ) : (
            <div className='flex min-w-0 flex-1 items-center gap-2'>
              <Spinner className='text-muted-foreground size-3.5 shrink-0' />
              <Progress
                value={preparationPercent ?? 0}
                className='w-full gap-0'
              >
                <ProgressLabel>{preparationLabel}</ProgressLabel>
                <ProgressValue />
              </Progress>
            </div>
          )
        ) : (
          <>
            {!isToolApp && isLocalApp ? (
              <Button
                variant='outline'
                size='icon-sm'
                aria-label={t('apps.history.title')}
                title={t('apps.history.title')}
                onClick={onOpenHistory}
              >
                <HistoryIcon />
              </Button>
            ) : null}
            <Button
              variant='outline'
              size='sm'
              nativeButton={false}
              render={
                <Link
                  to={`/apps/${definition.id}${isLocalApp ? '' : '?catalog=true'}`}
                  viewTransition
                />
              }
            >
              <FilePenLineIcon data-icon='inline-start' />
              {t('apps.details')}
            </Button>
            {hasRun ? (
              <Button variant='outline' size='sm' onClick={onViewOutput}>
                <TerminalIcon data-icon='inline-start' />
                {t('apps.output')}
              </Button>
            ) : null}
            {(node.installStatus === 'installed' ||
              node.installStatus === 'updateAvailable' ||
              // A catalog App will be installed by the future run-on-demand flow.
              node.installStatus === 'notInstalled' ||
              node.installStatus === 'draft') &&
            definition.kind === 'workflow' ? (
              <Button
                size='sm'
                className='min-w-24'
                data-process-node-id={definition.id}
                disabled={runsArePending}
                onClick={onRun}
              >
                {run?.isRunning ? (
                  <Spinner data-icon='inline-start' />
                ) : (
                  <PlayIcon data-icon='inline-start' />
                )}
                {run?.isRunning
                  ? t('apps.running')
                  : t('apps.run')}
              </Button>
            ) : null}
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function AppHistoryDrawer({
  node,
  open,
  onOpenChange,
  selectedRun,
  onSelectedRunChange,
}: {
  node?: ProcessNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedRun?: ProcessNodeRun;
  onSelectedRunChange: (run?: ProcessNodeRun) => void;
}) {
  const { t, i18n } = useTranslation();
  const history = useInfiniteQuery({
    queryKey: ['run-history', 'app', node?.definition.id],
    queryFn: ({ pageParam }) =>
      listRunHistoryPage({
        targetType: 'app',
        targetId: node?.definition.id,
        pageSize: 20,
        cursor: pageParam,
      }),
    initialPageParam: undefined as RunHistoryCursor | undefined,
    getNextPageParam: (page) => page.nextCursor,
    enabled: open && Boolean(node),
  });
  const historyItems = history.data?.pages.flatMap((page) => page.items) ?? [];

  const viewOutput = async (id: string) => {
    try {
      const record = await inspectRunRecord(id);
      if (record.targetType === 'app') {
        onSelectedRunChange(restoreProcessNodeRun(record, node));
      }
    } catch (error) {
      toast.error(t('apps.history.loadOutputFailed'), {
        toasterId: 'global',
        description:
          error instanceof Error &&
          error.message === 'The saved App definition is unavailable.'
            ? t('apps.history.definitionUnavailable')
            : error instanceof Error
              ? error.message
              : String(error),
      });
    }
  };

  const copyAll = async () => {
    if (!selectedRun) return;
    const text = [
      selectedRun.output.stdout && `stdout\n${selectedRun.output.stdout}`,
      selectedRun.output.stderr && `stderr\n${selectedRun.output.stderr}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (text) await navigator.clipboard.writeText(text);
  };

  return (
    <Drawer
      modal={false}
      open={open}
      showSwipeHandle
      onOpenChange={onOpenChange}
    >
      <DrawerContent className='h-[min(34rem,calc(100dvh-4rem))]'>
        <DrawerHeader>
          <DrawerTitle>
            {selectedRun
              ? t('apps.history.outputTitle')
              : t('apps.history.title')}
            {node ? ` · ${node.definition.name}` : ''}
          </DrawerTitle>
          <DrawerDescription>
            {selectedRun
              ? t('apps.history.readOnlyDescription')
              : t('apps.history.selectRunDescription')}
          </DrawerDescription>
        </DrawerHeader>
        {selectedRun ? (
          <AppRunOutputContent key={selectedRun.runId} run={selectedRun} />
        ) : (
          <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3'>
            {history.isLoading ? (
              <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm'>
                <Spinner /> {t('apps.history.loading')}
              </div>
            ) : historyItems.length ? (
              <>
                <ItemGroup className='gap-2'>
                  {historyItems.map((record) => (
                    <Item key={record.id} size='sm' variant='outline'>
                      <ItemContent className='min-w-0 flex-row items-center gap-3'>
                        <ItemTitle className='shrink-0 tabular-nums'>
                          <time dateTime={record.startedAt}>
                            {new Date(record.startedAt).toLocaleString(
                              i18n.language,
                            )}
                          </time>
                        </ItemTitle>
                        <ItemDescription className='line-clamp-1 text-xs'>
                          {record.durationMs !== undefined
                            ? t('apps.history.duration', {
                                seconds: (record.durationMs / 1000).toFixed(1),
                              })
                            : t('apps.history.durationUnavailable')}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions className='ml-auto shrink-0 gap-2'>
                        <Badge
                          variant='outline'
                          className={cn(
                            'px-2 text-xs',
                            RUN_STATUS_STYLES[record.status],
                          )}
                        >
                          {t(`apps.runStatus.${record.status}`)}
                        </Badge>
                        <Button
                          size='sm'
                          onClick={() => void viewOutput(record.id)}
                        >
                          {t('apps.history.viewOutput')}
                        </Button>
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
                {history.hasNextPage ? (
                  <div className='flex justify-center pt-3'>
                    <Button
                      variant='outline'
                      size='sm'
                      disabled={history.isFetchingNextPage}
                      onClick={() => void history.fetchNextPage()}
                    >
                      {history.isFetchingNextPage ? (
                        <Spinner data-icon='inline-start' />
                      ) : null}
                      {t('apps.history.loadMore')}
                    </Button>
                  </div>
                ) : (
                  <p className='text-muted-foreground pt-3 text-center text-xs'>
                    {t('apps.history.allLoaded')}
                  </p>
                )}
              </>
            ) : (
              <p className='text-muted-foreground py-6 text-sm'>
                {t('apps.history.empty')}
              </p>
            )}
          </div>
        )}
        <DrawerFooter className='flex-row justify-end'>
          {selectedRun ? (
            <Button
              variant='outline'
              onClick={() => onSelectedRunChange(undefined)}
            >
              <ArrowLeftIcon data-icon='inline-start' />
              {t('apps.history.back')}
            </Button>
          ) : null}
          {selectedRun ? (
            <Button
              variant='outline'
              disabled={
                !selectedRun.output.stdout && !selectedRun.output.stderr
              }
              onClick={() => void copyAll()}
            >
              <ClipboardIcon data-icon='inline-start' /> {t('apps.copyAll')}
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>{t('apps.close')}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function AppsPage() {
  const [filter, setFilter] = useState<AppFilter>('all');
  const [query, setQuery] = useState<string>('');
  const [runs, setRuns] = useState<Record<string, ProcessNodeRun>>({});
  const [preparations, setPreparations] = useState<
    Record<string, AppPreparation>
  >({});
  const [preparationSummaries, setPreparationSummaries] = useState<
    Record<string, AppPreparationSummary>
  >({});
  const [outputOpen, setOutputOpen] = useState<boolean>(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [historyNode, setHistoryNode] = useState<ProcessNode>();
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [historySelectedRun, setHistorySelectedRun] =
    useState<ProcessNodeRun>();

  const pendingOutput = useRef<Record<string, ProcessNodeOutput>>({});
  const frames = useRef<Record<string, number | undefined>>({});
  const unlistenRuns = useRef<Record<string, () => void>>({});
  const preparationSummaryTimers = useRef<Record<string, number | undefined>>(
    {},
  );
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const teamServerUrl = useWorkrunStore((s) => s.config?.team?.server_url);

  const queryClient = useQueryClient();

  const apps = useQuery({
    // A team catalog must never reuse the personal catalog cached under the
    // same route while the workspace mode changes.
    queryKey: ['apps', workspaceMode, teamServerUrl],
    queryFn: getProcessNodes,
  });

  const { t } = useTranslation();

  useEffect(
    () => () => {
      Object.values(frames.current).forEach((frame) => {
        if (frame !== undefined) cancelAnimationFrame(frame);
      });
      Object.values(unlistenRuns.current).forEach((unlisten) => unlisten());
      Object.values(preparationSummaryTimers.current).forEach((timer) => {
        if (timer !== undefined) window.clearTimeout(timer);
      });
    },
    [],
  );

  const receiveOutput = (runId: string, chunk: ProcessNodeOutputChunk) => {
    const output = pendingOutput.current[runId] ?? { stdout: '', stderr: '' };
    pendingOutput.current[runId] = {
      ...output,
      [chunk.stream]: appendOutput(output[chunk.stream], chunk.data),
    };
    if (frames.current[runId] !== undefined) return;
    frames.current[runId] = requestAnimationFrame(() => {
      frames.current[runId] = undefined;
      setRuns((current) => {
        const run = current[runId];
        if (!run) return current;
        return {
          ...current,
          [runId]: { ...run, output: pendingOutput.current[runId] },
        };
      });
    });
  };

  const startRun = async (node: ProcessNode) => {
    let runnableNode = node;
    if (isTeamMode() && node.installStatus !== 'draft') {
      const preparationId = node.definition.id;
      setPreparations((current) => ({
        ...current,
        [preparationId]: { stage: 'checkingVersion' },
      }));

      try {
        runnableNode = await ensurePublishedProcessNode(node, (progress) => {
          setPreparations((current) => ({
            ...current,
            [preparationId]: progress,
          }));
        });
        await queryClient.invalidateQueries({ queryKey: ['apps'] });
        setPreparations((current) => {
          const { [preparationId]: _completed, ...remaining } = current;
          return remaining;
        });
        const outcome =
          node.installStatus === 'notInstalled'
            ? 'installed'
            : node.installStatus === 'updateAvailable'
              ? 'updated'
              : 'current';
        setPreparationSummaries((current) => ({
          ...current,
          [preparationId]: {
            outcome,
            version: runnableNode.definition.version,
          },
        }));
        // Keep the terminal result visible while the Run starts immediately.
        // This preserves fast-path feedback without adding artificial latency.
        if (preparationSummaryTimers.current[preparationId] !== undefined) {
          window.clearTimeout(preparationSummaryTimers.current[preparationId]);
        }
        preparationSummaryTimers.current[preparationId] = window.setTimeout(() => {
          setPreparationSummaries((current) => {
            const { [preparationId]: _summary, ...remaining } = current;
            return remaining;
          });
          delete preparationSummaryTimers.current[preparationId];
        }, 2_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPreparations((current) => ({
          ...current,
          [preparationId]: { stage: 'checkingVersion', error: message },
        }));
        toast.error(t('apps.startFailed'), {
          toasterId: 'global',
          description: message,
        });
        return;
      }
    }

    const runId = crypto.randomUUID();
    pendingOutput.current[runId] = { stdout: '', stderr: '' };
    setRuns((current) => ({
      ...current,
      [runId]: {
        isRunning: true,
        node: runnableNode,
        output: pendingOutput.current[runId],
        runId,
        startedAt: Date.now(),
      },
    }));
    try {
      unlistenRuns.current[runId] = await subscribeProcessNodeRun(
        runId,
        (event) => {
          if (event.type === 'output') receiveOutput(runId, event);
          else if (event.type === 'app_done') {
            setRuns((current) => ({
              ...current,
              [runId]: {
                ...current[runId],
                execution: event.execution,
                isRunning: false,
              },
            }));
            unlistenRuns.current[runId]?.();
            delete unlistenRuns.current[runId];
          } else if (event.type === 'app_cancelled') {
            setRuns((current) => ({
              ...current,
              [runId]: { ...current[runId], cancelled: true, isRunning: false },
            }));
            unlistenRuns.current[runId]?.();
            delete unlistenRuns.current[runId];
          } else if (event.type === 'error') {
            setRuns((current) => ({
              ...current,
              [runId]: {
                ...current[runId],
                error: event.message,
                isRunning: false,
              },
            }));
          }
        },
      );
      await startBackgroundProcessNodeRun({
        runId,
        targetId: runnableNode.definition.id,
        targetName: runnableNode.definition.name,
        outputView: {
          isRunning: true,
          node: runnableNode,
          output: pendingOutput.current[runId],
        },
        targetSnapshot: runnableNode.definition,
      });
    } catch (error) {
      unlistenRuns.current[runId]?.();
      delete unlistenRuns.current[runId];
      setRuns((current) => ({
        ...current,
        [runId]: { ...current[runId], error: String(error), isRunning: false },
      }));
      toast.error(t('apps.startFailed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const filteredApps = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const statusOrder: Record<ProcessNodeInstallStatus, number> = {
      invalid: 0,
      updateAvailable: 1,
      installed: 2,
      notInstalled: 3,
      draft: 4,
    };

    return apps.data
      ?.filter((app) => {
        const matchesFilter = filter === 'all' || app.installStatus === filter;
        const matchesQuery =
          !normalizedQuery ||
          [
            app.definition.name,
            app.definition.description,
            app.definition.id,
          ].some((value) => value.toLowerCase().includes(normalizedQuery));

        return matchesFilter && matchesQuery;
      })
      .sort(
        (left, right) =>
          statusOrder[left.installStatus] - statusOrder[right.installStatus] ||
          right.definition.updatedAt.localeCompare(left.definition.updatedAt) ||
          right.definition.id.localeCompare(left.definition.id),
      );
  }, [apps.data, filter, query]);

  const installedCount = apps.data?.filter(
    (app) =>
      app.installStatus === 'installed' ||
      app.installStatus === 'updateAvailable',
  ).length;
  const latestRunByApp = useMemo(
    () =>
      Object.values(runs).reduce<Record<string, ProcessNodeRun>>(
        (latest, item) => {
          const id = item.node.definition.id;
          if (
            !latest[id] ||
            (item.startedAt ?? 0) > (latest[id].startedAt ?? 0)
          )
            latest[id] = item;
          return latest;
        },
        {},
      ),
    [runs],
  );
  const selectedRun = selectedRunId ? runs[selectedRunId] : undefined;

  const selectRun = (id: string) => {
    setSelectedRunId(id);
    setOutputOpen(true);
  };

  const clearSelectedOutput = () => {
    if (!selectedRunId) return;
    pendingOutput.current[selectedRunId] = { stdout: '', stderr: '' };
    setRuns((current) => ({
      ...current,
      [selectedRunId]: {
        ...current[selectedRunId],
        output: pendingOutput.current[selectedRunId],
      },
    }));
  };

  return (
    <div className='size-full overflow-y-auto'>
      <main className='mx-auto flex w-full flex-col gap-3 px-6 py-3'>
        <section className='flex min-w-0 flex-wrap items-center gap-2.5'>
          <div className='mr-1 flex items-baseline gap-2'>
            <h1 className='text-lg font-semibold tracking-tight'>
              {t('apps.title')}
            </h1>
            <span className='text-muted-foreground text-xs whitespace-nowrap'>
              {t('apps.readyCount', {
                installed: installedCount ?? '—',
                total: apps.data?.length ?? '—',
              })}
            </span>
          </div>
          <InputGroup className='order-last w-full sm:order-0 sm:ml-auto sm:w-64'>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('apps.searchPlaceholder')}
              aria-label={t('apps.searchLabel')}
            />
          </InputGroup>
          <div className='flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0'>
            {appFilters.map((item) => (
              <Button
                key={item}
                variant={filter === item ? 'secondary' : 'ghost'}
                size='sm'
                onClick={() => setFilter(item)}
              >
                {t(`apps.filters.${item}`)}
              </Button>
            ))}
          </div>
          <Button
            variant='outline'
            size='sm'
            disabled={apps.isFetching}
            onClick={() => void apps.refetch()}
          >
            {apps.isFetching ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <RefreshCwIcon data-icon='inline-start' />
            )}
            {t('apps.refresh')}
          </Button>
          <Button
            size='sm'
            nativeButton={false}
            render={<Link to='/apps/new' viewTransition />}
          >
            <PlusIcon data-icon='inline-start' />
            {t('apps.create')}
          </Button>
        </section>

        {apps.isLoading ? <AppListSkeleton /> : null}

        {apps.isError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>{t('apps.loadErrorTitle')}</AlertTitle>
            <AlertDescription>
              {apps.error instanceof Error
                ? apps.error.message
                : t('apps.loadErrorDescription')}
            </AlertDescription>
            <AlertAction>
              <Button
                variant='outline'
                size='sm'
                onClick={() => void apps.refetch()}
              >
                {t('apps.retry')}
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {apps.data?.length === 0 ? (
          <Empty className='via-card border border-dashed border-sky-200/70 bg-linear-to-br from-sky-500/6 to-violet-500/5 py-14 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <PackageSearchIcon />
              </EmptyMedia>
              <EmptyTitle>{t('apps.emptyTitle')}</EmptyTitle>
              <EmptyDescription>{t('apps.emptyDescription')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to='/apps/new' />}>
                <PlusIcon data-icon='inline-start' />
                {t('apps.create')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}

        {filteredApps?.length ? (
          <section className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4'>
            {filteredApps.map((node) => (
              <AppItem
                key={node.definition.id}
                node={node}
                run={latestRunByApp[node.definition.id]}
                preparation={preparations[node.definition.id]}
                preparationSummary={preparationSummaries[node.definition.id]}
                runsArePending={false}
                onRun={() => void startRun(node)}
                onViewOutput={() => {
                  const latest = latestRunByApp[node.definition.id];
                  if (latest?.runId) selectRun(latest.runId);
                }}
                onOpenHistory={() => {
                  setOutputOpen(false);
                  setHistoryNode(node);
                  setHistorySelectedRun(undefined);
                  setHistoryOpen(true);
                }}
              />
            ))}
          </section>
        ) : null}

        {apps.data?.length && filteredApps?.length === 0 ? (
          <Empty className='min-h-64 rounded-xl border border-dashed border-sky-200/70 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyTitle>{t('apps.noMatchesTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('apps.noMatchesDescription')}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant='outline'
                size='sm'
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
              >
                {t('apps.clearFilters')}
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
      </main>
      <AppRunOutputPanel
        open={outputOpen}
        run={selectedRun}
        onOpenChange={(open) => {
          setOutputOpen(open);
        }}
        onClear={clearSelectedOutput}
        onRunAgain={() => selectedRun && void startRun(selectedRun.node)}
      />
      <AppHistoryDrawer
        node={historyNode}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        selectedRun={historySelectedRun}
        onSelectedRunChange={setHistorySelectedRun}
      />
    </div>
  );
}

export { AppsPage as Component };
