import { LazyLog } from '@melloware/react-logviewer';
import {
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Spinner,
} from '@workspace/ui/components';
import { CheckCircle2Icon, CircleAlertIcon, ClipboardIcon } from 'lucide-react';
import { useState } from 'react';

import type { ProcessNode } from '@/services/process-node';
import type { RunRecord } from '@/services/run-history';

export type ProcessNodeOutput = Record<'stdout' | 'stderr', string>;
export type ProcessNodeRun = {
  cancelled?: boolean;
  error?: string;
  execution?: { exitCode: number | null };
  isRunning: boolean;
  node: ProcessNode;
  output: ProcessNodeOutput;
  runId?: string;
  startedAt?: number;
  eventSequence?: number;
};

const MAX_RESTORED_OUTPUT_CHARS = 200_000;

function appendRestoredOutput(current: string, chunk: string) {
  const next = current + chunk;
  if (next.length <= MAX_RESTORED_OUTPUT_CHARS) return next;
  return `[Earlier output truncated]\n${next.slice(-MAX_RESTORED_OUTPUT_CHARS)}`;
}

/**
 * The stored view is only a fast initial snapshot. Replaying the durable event
 * journal makes a run view complete even after the originating page unmounts.
 */
function restoreProcessNodeRun(
  record: RunRecord,
  currentNode?: ProcessNode,
): ProcessNodeRun {
  const view = record.outputView as Partial<ProcessNodeRun>;
  // A catalog entry can change after a run. Prefer the current one when the
  // caller has it, but retain the captured entry for archive-only views.
  const node = currentNode ?? view.node;
  if (!node) throw new Error('The saved App definition is unavailable.');
  const run: ProcessNodeRun = {
    ...view,
    node,
    output: { stdout: '', stderr: '', ...view.output },
    runId: record.id,
    startedAt: Date.parse(record.startedAt),
    isRunning:
      record.status === 'queued' ||
      record.status === 'running' ||
      record.status === 'waiting_for_input',
    error: record.error ?? view.error,
  };

  for (const { event } of record.events) {
    if (!event || typeof event !== 'object') continue;
    const value = event as Record<string, unknown>;
    if (
      value.type === 'output' &&
      (value.stream === 'stdout' || value.stream === 'stderr') &&
      typeof value.data === 'string'
    ) {
      run.output[value.stream] = appendRestoredOutput(
        run.output[value.stream],
        value.data,
      );
    } else if (value.type === 'app_done' && value.execution) {
      run.execution = value.execution as ProcessNodeRun['execution'];
    } else if (value.type === 'app_cancelled') {
      run.cancelled = true;
    } else if (value.type === 'error' && typeof value.message === 'string') {
      run.error = value.message;
    }
  }

  return run;
}

type AppRunOutputPanelProps = {
  onClear: () => void;
  onOpenChange: (open: boolean) => void;
  onRunAgain: () => void;
  open: boolean;
  readOnly?: boolean;
  run?: ProcessNodeRun;
};

type OutputStream = keyof ProcessNodeOutput;

function AppRunOutputContent({ run }: { run: ProcessNodeRun }) {
  const [stream, setStream] = useState<OutputStream>(() =>
    run.output.stderr ? 'stderr' : 'stdout',
  );
  const output = run.output[stream];

  return (
    <div className='flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3'>
      {run.error ? (
        <div className='border-destructive/30 bg-destructive/5 text-destructive mb-3 flex items-start gap-2 rounded-md border p-3 text-sm'>
          <CircleAlertIcon className='mt-0.5 size-4 shrink-0' />
          <p>{run.error}</p>
        </div>
      ) : null}
      <div className='mb-2 flex items-center gap-1'>
        {(['stdout', 'stderr'] as const).map((item) => (
          <Button
            key={item}
            size='sm'
            variant={stream === item ? 'secondary' : 'ghost'}
            onClick={() => setStream(item)}
          >
            {item === 'stdout' ? 'Output' : 'Errors'}
            {run.output[item] ? ' •' : ''}
          </Button>
        ))}
      </div>
      <div className='bg-muted min-h-0 flex-1 overflow-hidden rounded-md'>
        {output ? (
          <LazyLog
            text={output}
            follow
            selectableLines
            wrapLines
            enableLineNumbers
            rowHeight={20}
            style={{
              backgroundColor: 'transparent',
              color: 'var(--foreground)',
              fontFamily: 'var(--font-mono)',
              fontSize: '0.75rem',
              lineHeight: '1.25rem',
              padding: '0.75rem',
            }}
          />
        ) : (
          <div className='p-3 font-mono text-xs leading-5 whitespace-pre-wrap'>
            {run.isRunning ? 'Waiting for output…' : 'No output was produced.'}
          </div>
        )}
      </div>
    </div>
  );
}

function AppRunOutputPanel({
  onClear,
  onOpenChange,
  onRunAgain,
  open,
  readOnly = false,
  run,
}: AppRunOutputPanelProps) {
  const hasOutput = Boolean(run?.output.stdout || run?.output.stderr);
  const status = run?.isRunning
    ? 'Running'
    : run?.cancelled
      ? 'Cancelled'
      : run?.error || run?.execution?.exitCode !== 0
        ? 'Run failed'
        : 'Run completed';
  const StatusIcon = run?.isRunning
    ? Spinner
    : run?.cancelled
      ? CircleAlertIcon
      : run?.error || run?.execution?.exitCode !== 0
        ? CircleAlertIcon
        : CheckCircle2Icon;

  const copyAll = async () => {
    if (!hasOutput) return;
    const text = [
      run?.output.stdout && `stdout\n${run.output.stdout}`,
      run?.output.stderr && `stderr\n${run.output.stderr}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    await navigator.clipboard.writeText(text);
  };

  return (
    <Drawer
      modal={false}
      open={open}
      showSwipeHandle
      snapPoints={['31rem', 1]}
      swipeDirection='down'
      onOpenChange={onOpenChange}
    >
      <DrawerContent>
        {run ? (
          <>
            <DrawerHeader>
              <DrawerTitle>Run output · {run.node.definition.name}</DrawerTitle>
              <DrawerDescription className='flex items-center gap-1.5'>
                <StatusIcon className='size-3.5' />
                {status}
                {run.execution
                  ? ` · Exit code ${run.execution.exitCode ?? 'unknown'}`
                  : ''}
              </DrawerDescription>
            </DrawerHeader>

            <AppRunOutputContent
              key={`${run.node.definition.id}:${run.output.stderr}`}
              run={run}
            />

            <DrawerFooter className='flex-row justify-end'>
              {!readOnly && (
                <Button
                  variant='outline'
                  disabled={!hasOutput}
                  onClick={onClear}
                >
                  Clear
                </Button>
              )}
              <Button variant='outline' disabled={!hasOutput} onClick={copyAll}>
                <ClipboardIcon data-icon='inline-start' />
                Copy all
              </Button>
              {!readOnly && (
                <Button
                  variant='outline'
                  disabled={run.isRunning}
                  onClick={onRunAgain}
                >
                  Run again
                </Button>
              )}
              <Button onClick={() => onOpenChange(false)}>Close</Button>
            </DrawerFooter>
          </>
        ) : null}
      </DrawerContent>
    </Drawer>
  );
}

export { AppRunOutputContent, AppRunOutputPanel, restoreProcessNodeRun };
