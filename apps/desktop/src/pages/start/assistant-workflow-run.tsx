import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Spinner,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleXIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { WorkflowActionCards } from '@/components/workflow-actions';
import { WorkflowExecutionDetails } from '@/components/workflow-output-panel';
import { inspectRunRecord } from '@/services/run-history';
import {
  cancelBackgroundWorkflowRun,
  type WorkflowDocument,
  type WorkflowRunEvent,
  type WorkflowRunExecution,
} from '@/services/workflow';
import {
  replayWorkflowRunProjection,
  workflowRunView,
} from '@/stores/workflow-run.store';

const terminal = (status?: string) =>
  ['completed', 'failed', 'cancelled', 'interrupted'].includes(status ?? '');
function StatusIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') return <Spinner />;
  if (
    status === 'failed' ||
    status === 'interrupted' ||
    status === 'waiting_for_input'
  )
    return <CircleAlertIcon />;
  if (status === 'cancelled') return <CircleXIcon />;
  return <CheckCircle2Icon />;
}

// Tick only this text: the growing execution history is not replayed each second.
function RunElapsed({
  startedAt,
  endedAt,
  durationMs,
  running,
}: {
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  running: boolean;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  const elapsed =
    !running && durationMs !== undefined
      ? durationMs
      : (endedAt && !running ? Date.parse(endedAt) : now) -
        Date.parse(startedAt);
  if (!Number.isFinite(elapsed)) return null;
  return (
    <span className='shrink-0 tabular-nums' data-testid='workflow-run-elapsed'>
      {t('assistant.runElapsed', {
        seconds: Math.max(0, elapsed / 1000).toFixed(1),
      })}
    </span>
  );
}

export function AssistantWorkflowRun({
  runId,
  name,
  status: fallbackStatus,
  scope,
}: {
  runId: string;
  name?: string;
  status: string;
  scope: string;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const queryKey = useMemo(
    () => ['run-history', 'assistant-inline', scope, runId],
    [scope, runId],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => inspectRunRecord(runId),
  });
  const record = query.data;
  const status = terminal(fallbackStatus)
    ? fallbackStatus
    : (record?.status ?? fallbackStatus);
  const live = !terminal(status);
  const snapshot = record?.targetSnapshot as WorkflowDocument | undefined;
  const nodes = snapshot?.nodes ?? [];
  const view = useMemo(
    () =>
      record
        ? workflowRunView(
            replayWorkflowRunProjection(
              runId,
              record.events.map(({ sequence, event }, index) => ({
                runId,
                sequence: sequence ?? index,
                event: event as WorkflowRunEvent,
              })),
              {
                mode: snapshot?.settings?.mode ?? 'task',
                nodes: snapshot?.nodes ?? [],
              },
            ),
          )
        : undefined,
    [record, runId, snapshot],
  );

  const nodeName = (id: string) => {
    const node = nodes.find((node) => node.id === id);
    return (
      [
        node?.data?.name,
        node?.data?.workflowName,
        node?.data?.label,
        view?.nodes.find((node) => node.id === id)?.name,
        id,
      ].find(
        (value): value is string =>
          typeof value === 'string' && value.length > 0,
      ) ?? id
    );
  };
  const latest =
    view?.execution.findLast((entry) => entry.nodeId === view.activeNodeId) ??
    view?.execution.at(-1);
  const currentName = latest ? nodeName(latest.nodeId) : undefined;
  const activeNodeId = view?.activeNodeId;
  const phase = useMemo(() => {
    if (!record || !activeNodeId || status !== 'running') return undefined;
    // A loop may visit the same node again. Ignore the previous visit's stage.
    const start = record.events.findLastIndex(({ event }) => {
      const value = event as WorkflowRunEvent;
      return value.type === 'node_start' && value.node === activeNodeId;
    });
    for (let index = record.events.length - 1; index > start; index--) {
      const value = record.events[index]!.event as WorkflowRunEvent;
      if (value.type !== 'custom' || value.node !== activeNodeId) continue;
      if (value.event_type === 'agent.model_call') return 'processingResult';
      if (value.event_type === 'agent.model_responding')
        return 'receivingModel';
      if (value.event_type === 'agent.model_started') return 'waitingForModel';
    }
    return undefined;
  }, [record, activeNodeId, status]);
  const summary = query.isError
    ? t('assistant.runLoadFailed')
    : `${t(`runs.runStatus.${status}`, { defaultValue: status })}${currentName ? ` · ${currentName}` : ''}${phase ? ` · ${t(`assistant.runPhase.${phase}`)}` : ''}`;
  const completed =
    view?.execution.filter((entry) => entry.status === 'completed').length ?? 0;

  return (
    <div
      className='flex w-full min-w-0 flex-col gap-3'
      data-testid='assistant-workflow-run'
    >
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className='w-full min-w-0'
      >
        <CollapsibleTrigger
          render={
            <Button
              variant='ghost'
              className='h-auto w-full min-w-0 justify-start gap-2 px-0 py-2'
            />
          }
        >
          <StatusIcon status={query.isError ? 'failed' : status} />
          <span className='flex min-w-0 flex-1 items-center gap-2 text-left'>
            <span className='text-muted-foreground min-w-0 truncate'>
              {name || record?.targetName}
            </span>
            <span
              className='min-w-0 truncate'
              role='status'
              data-testid='workflow-run-summary'
            >
              {summary}
            </span>
          </span>
          <span className='text-muted-foreground hidden shrink-0 text-xs sm:block'>
            {view?.execution.length
              ? t('assistant.runProgress', {
                  completed,
                  running: view.execution.filter(
                    (entry) => entry.status === 'running',
                  ).length,
                })
              : ''}
          </span>
          {record && (
            <RunElapsed
              startedAt={record.startedAt}
              endedAt={record.endedAt}
              durationMs={record.durationMs}
              running={status === 'running' || status === 'queued'}
            />
          )}

          <ChevronDownIcon
            className={cn(
              'shrink-0 transition-transform motion-reduce:transition-none',
              open && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          {/* The conversation owns scrolling. Expanding a run adds normal
              message-flow content rather than a second scroll viewport. */}
          <div
            className='ml-2 flex min-w-0 flex-col gap-5 border-l py-3 pl-4'
            data-testid='workflow-run-timeline'
          >
            {view?.execution.map((entry, index) => (
              <ExecutionStep
                key={`${entry.nodeId}-${index}`}
                entry={entry}
                name={nodeName(entry.nodeId)}
                spans={record?.spans}
              />
            ))}
            {!view?.execution.length && (
              <p className='text-muted-foreground text-sm'>
                {t(
                  query.isPending
                    ? 'assistant.preparing'
                    : 'assistant.noRunSteps',
                )}
              </p>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      {query.isError && (
        <Alert variant='destructive'>
          <AlertDescription>
            {t('assistant.runLoadFailed')}
            <Button
              variant='outline'
              size='sm'
              onClick={() => void query.refetch()}
            >
              {t('assistant.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {record?.error && (
        <Alert variant='destructive'>
          <AlertDescription>{record.error}</AlertDescription>
        </Alert>
      )}
      {/* Requests stay outside the collapsed trace so they can never be hidden. */}
      {live && <WorkflowActionCards runId={runId} />}
      {live && (
        <div>
          <Button
            variant='ghost'
            size='sm'
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await cancelBackgroundWorkflowRun(runId);
                await client.invalidateQueries({ queryKey });
              } catch (error) {
                toast.error(String(error), { toasterId: 'global' });
              } finally {
                setCancelling(false);
              }
            }}
          >
            {t('assistant.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ExecutionStep({
  entry,
  name,
  spans,
}: {
  entry: WorkflowRunExecution;
  name: string;
  spans: Awaited<ReturnType<typeof inspectRunRecord>>['spans'] | undefined;
}) {
  const { t } = useTranslation();
  return (
    <div className='flex min-w-0 gap-3'>
      <div className='mt-0.5 shrink-0'>
        <StatusIcon status={entry.status} />
      </div>
      <div className='min-w-0 flex-1'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <span className='text-sm font-medium'>{name}</span>
          <span className='text-muted-foreground text-xs'>
            {t(`runs.runStatus.${entry.status}`)}
            {entry.durationMs !== undefined
              ? ` · ${(entry.durationMs / 1000).toFixed(1)}s`
              : ''}
          </span>
        </div>
        <WorkflowExecutionDetails entry={entry} spans={spans} />
      </div>
    </div>
  );
}
