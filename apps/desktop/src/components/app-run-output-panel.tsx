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

export type ProcessNodeOutput = Record<'stdout' | 'stderr', string>;
export type ProcessNodeRun = {
  error?: string;
  execution?: { exitCode: number | null };
  isRunning: boolean;
  node: ProcessNode;
  output: ProcessNodeOutput;
  runId?: string;
  startedAt?: number;
  eventSequence?: number;
};

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
    : run?.error || run?.execution?.exitCode !== 0
      ? 'Run failed'
      : 'Run completed';
  const StatusIcon = run?.isRunning
    ? Spinner
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

export { AppRunOutputContent, AppRunOutputPanel };
