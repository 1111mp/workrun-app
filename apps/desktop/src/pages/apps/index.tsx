import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
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
import { Link } from 'react-router';
import { toast } from 'sonner';

import {
  AppRunOutputContent,
  AppRunOutputPanel,
  type ProcessNodeOutput,
  type ProcessNodeRun,
} from '@/components/app-run-output-panel';
import {
  listProcessNodes,
  runProcessNode,
  type ProcessNode,
  type ProcessNodeInstallStatus,
  type ProcessNodeOutputChunk,
} from '@/services/process-node';
import {
  appendRunEvents,
  createRunRecord,
  finalizeRunRecord,
  inspectRunRecord,
  listRunHistoryPage,
  type RunHistoryCursor,
  type RunStatus,
} from '@/services/run-history';

import { copyProjectPath, openProjectDirectory } from './project-path';

const MAX_OUTPUT_CHARS = 200_000;

type AppFilter = 'all' | ProcessNodeInstallStatus;

const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  completed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  interrupted:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

function appendOutput(current: string, chunk: string) {
  const next = current + chunk;
  if (next.length <= MAX_OUTPUT_CHARS) return next;
  return `[Earlier output truncated]\n${next.slice(-MAX_OUTPUT_CHARS)}`;
}

function statusBadge(status: ProcessNodeInstallStatus) {
  switch (status) {
    case 'installed':
      return (
        <Badge variant='secondary'>
          <CheckCircle2Icon data-icon='inline-start' />
          Installed
        </Badge>
      );
    case 'invalid':
      return (
        <Badge variant='destructive'>
          <CircleAlertIcon data-icon='inline-start' />
          Needs attention
        </Badge>
      );
    case 'notInstalled':
      return (
        <Badge variant='outline'>
          <DownloadIcon data-icon='inline-start' />
          Not installed
        </Badge>
      );
  }
}

function AppListSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[80rem]:grid-cols-4'>
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

const appFilters: { value: AppFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'installed', label: 'Ready' },
  { value: 'notInstalled', label: 'Not installed' },
  { value: 'invalid', label: 'Needs attention' },
];

function AppItem({
  node,
  run,
  runsArePending,
  onRun,
  onViewOutput,
  onOpenHistory,
}: {
  node: ProcessNode;
  run?: ProcessNodeRun;
  runsArePending: boolean;
  onRun: () => void;
  onViewOutput: () => void;
  onOpenHistory: () => void;
}) {
  const { definition } = node;
  const isToolApp = definition.kind === 'tool';
  const inputCount = Object.keys(definition.inputs).length;
  const outputCount = Object.keys(definition.outputs).length;
  const hasRun = Boolean(run);
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
          {definition.description || 'No description provided.'}
        </CardDescription>
        <CardAction className='flex flex-col items-end gap-2'>
          {statusBadge(node.installStatus)}
          {run?.isRunning ? (
            <Badge variant='outline'>
              <Spinner data-icon='inline-start' />
              Running
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
            {isToolApp ? 'Tool App' : 'App'}
          </Badge>
          <span>{inputCount} inputs</span>
          <span>{outputCount} outputs</span>
        </div>
        {node.installStatus === 'invalid' && node.installError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>Local installation is invalid</AlertTitle>
            <AlertDescription>{node.installError}</AlertDescription>
          </Alert>
        ) : null}
        <div className='mt-auto flex min-w-0 items-end gap-2'>
          <div className='min-w-0 flex-1'>
            <span className='text-muted-foreground text-xs'>Node ID</span>
            <code className='block truncate'>{definition.id}</code>
          </div>
          <div className='flex shrink-0 items-center gap-1'>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Open project directory'
              onClick={() => void openProjectDirectory(definition.id)}
            >
              <FolderOpenIcon />
            </Button>
            <Button
              variant='ghost'
              size='icon-sm'
              aria-label='Copy project path'
              onClick={() => void copyProjectPath(node.projectPath)}
            >
              <CopyIcon />
            </Button>
          </div>
        </div>
      </CardContent>
      <CardFooter className='flex-wrap justify-end gap-1'>
        <Button
          variant='outline'
          size='sm'
          nativeButton={false}
          render={<Link to={`/apps/${definition.id}`} />}
        >
          <FilePenLineIcon data-icon='inline-start' />
          Details
        </Button>
        {!isToolApp ? (
          <Button variant='outline' size='sm' onClick={onOpenHistory}>
            <HistoryIcon data-icon='inline-start' />
            History
          </Button>
        ) : null}
        {hasRun ? (
          <Button variant='outline' size='sm' onClick={onViewOutput}>
            <TerminalIcon data-icon='inline-start' />
            Output
          </Button>
        ) : null}
        {node.installStatus === 'installed' &&
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
            {run?.isRunning ? 'Running' : 'Run'}
          </Button>
        ) : null}
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
        onSelectedRunChange(record.outputView as ProcessNodeRun);
      }
    } catch (error) {
      toast.error('Could not load run output', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
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
            {selectedRun ? 'Run output' : 'Run history'}
            {node ? ` · ${node.definition.name}` : ''}
          </DrawerTitle>
          <DrawerDescription>
            {selectedRun
              ? 'Saved output is read-only.'
              : 'Select a run to inspect its output.'}
          </DrawerDescription>
        </DrawerHeader>
        {selectedRun ? (
          <AppRunOutputContent key={selectedRun.runId} run={selectedRun} />
        ) : (
          <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3'>
            {history.isLoading ? (
              <div className='text-muted-foreground flex items-center gap-2 py-6 text-sm'>
                <Spinner /> Loading history…
              </div>
            ) : historyItems.length ? (
              <>
                <ItemGroup>
                  {historyItems.map((record) => (
                    <Item key={record.id} variant='outline'>
                      <ItemContent>
                        <ItemTitle>
                          {new Date(record.startedAt).toLocaleString()}
                        </ItemTitle>
                        <ItemDescription>
                          {record.durationMs !== undefined
                            ? `${(record.durationMs / 1000).toFixed(1)}s`
                            : 'Duration unavailable'}
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Badge
                          variant='outline'
                          className={RUN_STATUS_STYLES[record.status]}
                        >
                          {record.status}
                        </Badge>
                        <Button
                          size='sm'
                          onClick={() => void viewOutput(record.id)}
                        >
                          View output
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
                      Load more
                    </Button>
                  </div>
                ) : (
                  <p className='text-muted-foreground pt-3 text-center text-xs'>
                    All runs loaded
                  </p>
                )}
              </>
            ) : (
              <p className='text-muted-foreground py-6 text-sm'>
                No saved runs yet.
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
              <ArrowLeftIcon data-icon='inline-start' /> Back to history
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
              <ClipboardIcon data-icon='inline-start' /> Copy all
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function AppsPage() {
  const [filter, setFilter] = useState<AppFilter>('all');
  const [query, setQuery] = useState('');
  const [runs, setRuns] = useState<Record<string, ProcessNodeRun>>({});
  const [outputOpen, setOutputOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [historyNode, setHistoryNode] = useState<ProcessNode>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySelectedRun, setHistorySelectedRun] =
    useState<ProcessNodeRun>();
  const pendingOutput = useRef<Record<string, ProcessNodeOutput>>({});
  const frames = useRef<Record<string, number | undefined>>({});
  const runMetadata = useRef<
    Record<string, { eventSequence: number; runId: string }>
  >({});
  const apps = useQuery({
    queryKey: ['apps'],
    queryFn: listProcessNodes,
  });

  useEffect(
    () => () => {
      Object.values(frames.current).forEach((frame) => {
        if (frame !== undefined) cancelAnimationFrame(frame);
      });
    },
    [],
  );

  const receiveOutput = (id: string, chunk: ProcessNodeOutputChunk) => {
    const output = pendingOutput.current[id] ?? { stdout: '', stderr: '' };
    pendingOutput.current[id] = {
      ...output,
      [chunk.stream]: appendOutput(output[chunk.stream], chunk.data),
    };
    const metadata = runMetadata.current[id];
    if (metadata) {
      metadata.eventSequence += 1;
      void appendRunEvents(metadata.runId, [
        {
          sequence: metadata.eventSequence,
          event: { type: 'output', ...chunk },
          createdAt: new Date().toISOString(),
        },
      ]);
      setRuns((current) => ({
        ...current,
        [id]: { ...current[id], eventSequence: metadata.eventSequence },
      }));
    }
    if (frames.current[id] !== undefined) return;
    frames.current[id] = requestAnimationFrame(() => {
      frames.current[id] = undefined;
      setRuns((current) => {
        const run = current[id];
        if (!run) return current;
        return {
          ...current,
          [id]: { ...run, output: pendingOutput.current[id] },
        };
      });
    });
  };

  const run = useMutation({
    mutationFn: (node: ProcessNode) =>
      runProcessNode(node.definition.id, (chunk) =>
        receiveOutput(node.definition.id, chunk),
      ),
    onMutate: async (node) => {
      const id = node.definition.id;
      const runId = crypto.randomUUID();
      const startedAt = Date.now();
      runMetadata.current[id] = { runId, eventSequence: 0 };
      pendingOutput.current[id] = { stdout: '', stderr: '' };
      setRuns((current) => ({
        ...current,
        [id]: {
          isRunning: true,
          node,
          output: pendingOutput.current[id],
          runId,
          startedAt,
          eventSequence: 0,
        },
      }));
      setSelectedRunId(id);
      try {
        await createRunRecord({
          id: runId,
          targetType: 'app',
          targetId: id,
          targetName: node.definition.name,
          status: 'running',
          startedAt: new Date(startedAt).toISOString(),
          outputView: {
            isRunning: true,
            node,
            output: pendingOutput.current[id],
          },
          targetSnapshot: node.definition,
        });
      } catch (error) {
        delete runMetadata.current[id];
        toast.error('Run history could not be saved', {
          toasterId: 'global',
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    onSuccess: (result, node) => {
      const id = node.definition.id;
      setRuns((current) => {
        const next = {
          ...current[id],
          output: pendingOutput.current[id],
          execution: result.execution,
          isRunning: false,
        };
        if (next.runId) {
          const endedAt = Date.now();
          void finalizeRunRecord(next.runId, {
            status: result.execution.exitCode === 0 ? 'completed' : 'failed',
            endedAt: new Date(endedAt).toISOString(),
            durationMs: Math.max(0, endedAt - (next.startedAt ?? endedAt)),
            outputView: next,
          });
        }
        return { ...current, [id]: next };
      });
      if (result.execution.exitCode === 0) {
        toast.success(`${node.definition.name} completed`, {
          toasterId: 'global',
        });
        return;
      }
      toast.error(`${node.definition.name} failed`, {
        toasterId: 'global',
        description: `Exited with code ${result.execution.exitCode ?? 'unknown'}.`,
      });
    },
    onError: (error, node) => {
      const message = error instanceof Error ? error.message : String(error);
      const id = node.definition.id;
      setRuns((current) => {
        const next = {
          ...current[id],
          output: pendingOutput.current[id],
          error: message,
          isRunning: false,
        };
        if (next.runId) {
          const endedAt = Date.now();
          void finalizeRunRecord(next.runId, {
            status: 'failed',
            endedAt: new Date(endedAt).toISOString(),
            durationMs: Math.max(0, endedAt - (next.startedAt ?? endedAt)),
            outputView: next,
            error: message,
          });
        }
        return { ...current, [id]: next };
      });
      toast.error(`${node.definition.name} could not start`, {
        toasterId: 'global',
        description: message,
      });
    },
  });

  const filteredApps = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    return apps.data?.filter((app) => {
      const matchesFilter = filter === 'all' || app.installStatus === filter;
      const matchesQuery =
        !normalizedQuery ||
        [
          app.definition.name,
          app.definition.description,
          app.definition.id,
        ].some((value) => value.toLowerCase().includes(normalizedQuery));

      return matchesFilter && matchesQuery;
    });
  }, [apps.data, filter, query]);

  const installedCount = apps.data?.filter(
    (app) => app.installStatus === 'installed',
  ).length;
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
            <h1 className='text-lg font-semibold tracking-tight'>Apps</h1>
            <span className='text-muted-foreground text-xs whitespace-nowrap'>
              {installedCount ?? '—'} of {apps.data?.length ?? '—'} ready
            </span>
          </div>
          <InputGroup className='order-last w-full sm:order-0 sm:ml-auto sm:w-64'>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder='Search apps'
              aria-label='Search apps'
            />
          </InputGroup>
          <div className='flex items-center gap-1 overflow-x-auto pb-1 sm:pb-0'>
            {appFilters.map((item) => (
              <Button
                key={item.value}
                variant={filter === item.value ? 'secondary' : 'ghost'}
                size='sm'
                onClick={() => setFilter(item.value)}
              >
                {item.label}
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
            Refresh
          </Button>
          <Button
            size='sm'
            nativeButton={false}
            render={<Link to='/apps/new' />}
          >
            <PlusIcon data-icon='inline-start' />
            Create App
          </Button>
        </section>

        {apps.isLoading ? <AppListSkeleton /> : null}

        {apps.isError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>Could not load Process Nodes</AlertTitle>
            <AlertDescription>
              {apps.error instanceof Error
                ? apps.error.message
                : 'The Process Node catalog could not be read.'}
            </AlertDescription>
            <AlertAction>
              <Button
                variant='outline'
                size='sm'
                onClick={() => void apps.refetch()}
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {apps.data?.length === 0 ? (
          <Empty className='via-card border border-dashed border-sky-200/70 bg-linear-to-br from-sky-500/[0.06] to-violet-500/[0.05] py-14 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <PackageSearchIcon />
              </EmptyMedia>
              <EmptyTitle>No apps in the catalog</EmptyTitle>
              <EmptyDescription>
                Create a Process Node to start a local, editable Python project.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button nativeButton={false} render={<Link to='/apps/new' />}>
                <PlusIcon data-icon='inline-start' />
                Create App
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
                run={runs[node.definition.id]}
                runsArePending={run.isPending}
                onRun={() => run.mutate(node)}
                onViewOutput={() => selectRun(node.definition.id)}
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
          <Empty className='bg-card/70 min-h-64 rounded-xl border border-dashed border-sky-200/70 dark:border-sky-400/15'>
            <EmptyHeader>
              <EmptyTitle>No matching apps</EmptyTitle>
              <EmptyDescription>
                Try a different search term or status filter.
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
                Clear filters
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
        onRunAgain={() => selectedRun && run.mutate(selectedRun.node)}
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
