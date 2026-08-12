import { useMutation, useQuery } from '@tanstack/react-query';
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Skeleton,
  Spinner,
} from '@workspace/ui/components';
import {
  BoxIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  DownloadIcon,
  PackageSearchIcon,
  PlayIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  listProcessNodes,
  runProcessNode,
  type ProcessNode,
  type ProcessNodeInstallStatus,
  type ProcessNodeOutputChunk,
} from '@/services/process-node';

const MAX_OUTPUT_CHARS = 200_000;

type ProcessNodeOutput = Record<'stdout' | 'stderr', string>;

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

function ProcessNodeListSkeleton() {
  return (
    <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
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

function ProcessNodeItem({ node }: { node: ProcessNode }) {
  const { definition } = node;
  const inputCount = Object.keys(definition.inputs).length;
  const outputCount = Object.keys(definition.outputs).length;
  const [output, setOutput] = useState<ProcessNodeOutput>({
    stdout: '',
    stderr: '',
  });
  const pendingOutput = useRef<ProcessNodeOutput>({ stdout: '', stderr: '' });
  const frame = useRef<number>(undefined);

  useEffect(
    () => () => {
      if (frame.current !== undefined) {
        cancelAnimationFrame(frame.current);
      }
    },
    [],
  );

  const receiveOutput = (chunk: ProcessNodeOutputChunk) => {
    pendingOutput.current = {
      ...pendingOutput.current,
      [chunk.stream]: appendOutput(
        pendingOutput.current[chunk.stream],
        chunk.data,
      ),
    };
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      setOutput(pendingOutput.current);
    });
  };
  const run = useMutation({
    mutationFn: () => runProcessNode(definition.id, receiveOutput),
    onMutate: () => {
      pendingOutput.current = { stdout: '', stderr: '' };
      setOutput(pendingOutput.current);
    },
    onSuccess: (result) => {
      if (result.execution.exitCode === 0) {
        toast.success(`${definition.name} completed`, { toasterId: 'global' });
        return;
      }
      toast.error(`${definition.name} failed`, {
        toasterId: 'global',
        description: `Exited with code ${result.execution.exitCode ?? 'unknown'}.`,
      });
    },
    onError: (error) => {
      toast.error(`${definition.name} could not start`, {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    },
  });
  const execution = run.data?.execution;
  const hasOutput = output.stdout.length > 0 || output.stderr.length > 0;

  return (
    <Card size='sm' className='h-full'>
      <CardHeader>
        <CardTitle>{definition.name}</CardTitle>
        <CardDescription>
          {definition.description || 'No description provided.'}
        </CardDescription>
        <CardAction className='flex flex-col items-end gap-2'>
          {statusBadge(node.installStatus)}
          {run.isPending ? (
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
        {execution || run.isPending || hasOutput ? (
          <Alert
            variant={
              execution && execution.exitCode !== 0 ? 'destructive' : 'default'
            }
          >
            <AlertTitle>
              {run.isPending
                ? 'Running'
                : execution?.exitCode === 0
                  ? 'Run completed'
                  : 'Run failed'}
            </AlertTitle>
            <AlertDescription className='flex flex-col gap-2'>
              {execution ? (
                <span>Exit code: {execution.exitCode ?? 'unknown'}</span>
              ) : null}
              {output.stdout ? (
                <pre className='bg-muted max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap'>
                  {output.stdout}
                </pre>
              ) : null}
              {output.stderr ? (
                <pre className='max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap'>
                  {output.stderr}
                </pre>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className='items-center justify-between gap-3'>
        <div className='flex min-w-0 flex-col gap-1'>
          <span className='text-muted-foreground text-xs'>Node ID</span>
          <code className='truncate'>{definition.id}</code>
        </div>
        {node.installStatus === 'installed' ? (
          <Button
            size='sm'
            className='min-w-24'
            data-process-node-id={definition.id}
            disabled={run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? (
              <Spinner data-icon='inline-start' />
            ) : (
              <PlayIcon data-icon='inline-start' />
            )}
            {run.isPending ? 'Running' : 'Run'}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}

function ProcessNodesPage() {
  const processNodes = useQuery({
    queryKey: ['processNodes'],
    queryFn: listProcessNodes,
  });

  console.log(processNodes.data);

  return (
    <div className='h-dvh w-full overflow-y-auto'>
      <header
        data-tauri-drag-region={OS_PLATFORM !== 'win32'}
        className='bg-background/80 sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-4 px-4 backdrop-blur-xl'
      >
        <div>
          <h1 className='font-heading text-sm font-medium'>Process Nodes</h1>
          <p className='text-muted-foreground text-xs'>
            Python node catalog and local installation status.
          </p>
        </div>
        <Button
          variant='outline'
          size='sm'
          disabled={processNodes.isFetching}
          onClick={() => void processNodes.refetch()}
        >
          {processNodes.isFetching ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <RefreshCwIcon data-icon='inline-start' />
          )}
          Refresh
        </Button>
      </header>

      <main className='mx-auto flex w-full max-w-6xl flex-col gap-5 p-4'>
        {processNodes.isLoading ? <ProcessNodeListSkeleton /> : null}

        {processNodes.isError ? (
          <Alert variant='destructive'>
            <CircleAlertIcon />
            <AlertTitle>Could not load Process Nodes</AlertTitle>
            <AlertDescription>
              {processNodes.error instanceof Error
                ? processNodes.error.message
                : 'The Process Node catalog could not be read.'}
            </AlertDescription>
            <AlertAction>
              <Button
                variant='outline'
                size='sm'
                onClick={() => void processNodes.refetch()}
              >
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : null}

        {processNodes.data?.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <PackageSearchIcon />
              </EmptyMedia>
              <EmptyTitle>No Process Nodes in the catalog</EmptyTitle>
              <EmptyDescription>
                Add entries to the local catalog to make Process Nodes available
                for installation.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {processNodes.data?.length ? (
          <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3'>
            {processNodes.data.map((node) => (
              <ProcessNodeItem key={node.definition.id} node={node} />
            ))}
          </div>
        ) : null}
      </main>
    </div>
  );
}

export { ProcessNodesPage as Component };
