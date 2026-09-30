import { LazyLog } from '@melloware/react-logviewer';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Bubble,
  BubbleContent,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupTextarea,
  Marker,
  MarkerContent,
  MarkerIcon,
  Message,
  MessageContent,
  MessageHeader,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Spinner,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleIcon,
  CircleXIcon,
  ClipboardIcon,
  DatabaseIcon,
  Globe2Icon,
  Layers3Icon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-react';
import {
  Children,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import { useShallow } from 'zustand/react/shallow';

import { WorkflowCodeBlock } from '@/components/workflow-code-block';
import type { RunSpan } from '@/services/run-history';
import type {
  WorkflowRunExecution,
  WorkflowRunMessage,
  WorkflowRunTurn,
  WorkflowRunView,
} from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores';

type WorkflowOutputPanelProps = {
  run: WorkflowRunView;
  workflowNodes: Node[];
  isRunning: boolean;
  onRunAgain: () => void;
  onClose: () => void;
  isChat?: boolean;
  onSend?: (initialState: Record<string, unknown>) => void;
  readOnly?: boolean;
  spans?: RunSpan[];
  spansByTurn?: Record<string, RunSpan[]>;
};

function statusLabel(run: WorkflowRunView, t: (key: string) => string) {
  if (run.status === 'interrupted' && !run.error)
    return t('workflowEditor.output.waitingForInput');

  const { status } = run;
  switch (status) {
    case 'running':
      return t('workflowEditor.output.status.running');
    case 'completed':
      return t('workflowEditor.output.status.completed');
    case 'failed':
      return t('workflowEditor.output.status.failed');
    case 'cancelled':
      return t('workflowEditor.output.status.cancelled');
    case 'interrupted':
      return t('workflowEditor.output.status.interrupted');
    default:
      return t('workflowEditor.output.waitingToRun');
  }
}

function rerunLabel(
  status: WorkflowRunView['status'],
  t: (key: string) => string,
) {
  if (status === 'interrupted') return t('workflowEditor.output.resume');
  if (status === 'failed') return t('workflowEditor.output.retry');
  return t('workflowEditor.output.runAgain');
}

function durationLabel(run: WorkflowRunView) {
  if (run.durationMs !== undefined)
    return `${(run.durationMs / 1000).toFixed(1)}s`;
  if (!run.startedAt) return undefined;
  if (
    !run.endedAt &&
    (run.status === 'completed' ||
      run.status === 'failed' ||
      run.status === 'cancelled' ||
      run.status === 'interrupted')
  )
    return undefined;
  const end = run.endedAt ?? Date.now();
  return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
}

function nodeDisplayName(
  run: Pick<WorkflowRunView, 'nodes'>,
  workflowNodes: Node[],
  nodeId: string,
) {
  const node = workflowNodes.find((node) => node.id === nodeId);
  const data = node?.data;
  if (typeof data?.workflowName === 'string' && data.workflowName.trim())
    return data.workflowName;
  if (typeof data?.name === 'string' && data.name.trim()) return data.name;
  if (typeof data?.label === 'string' && data.label.trim()) return data.label;
  if (typeof data?.title === 'string' && data.title.trim()) return data.title;

  const name = run.nodes.find((node) => node.id === nodeId)?.name?.trim();
  // Older run snapshots used the internal ID when a node had no display name.
  // Never surface that fallback now that diagnostics are user-facing.
  if (name && name !== nodeId) return name;
  return 'Unknown node';
}

function isProcessToolName(name?: string) {
  return /^process_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}$/i.test(
    name ?? '',
  );
}

function processNodeInfo(workflowNodes: Node[], nodeId: string) {
  const node = workflowNodes.find((item) => item.id === nodeId);
  if (node?.type !== 'process') return undefined;
  const appRef = node.data?.appRef;
  const ref = appRef && typeof appRef === 'object' ? appRef : undefined;
  const appName =
    ref && 'appName' in ref && typeof ref.appName === 'string'
      ? ref.appName.trim()
      : undefined;
  const version =
    ref && 'version' in ref && typeof ref.version === 'string'
      ? ref.version.trim()
      : undefined;
  return { appName, version };
}

type WorkflowTraceEntry = {
  nodeId: string;
  type: string;
  durationMs?: number;
  status?: WorkflowRunExecution['status'];
  [key: string]: unknown;
};

function workflowTrace(
  finalState: WorkflowRunView['finalState'],
): WorkflowTraceEntry[] {
  const workflow = recordValue(finalState?.workflow);
  const trace = workflow?.['workflow.trace'] ?? finalState?.['workflow.trace'];
  return traceEntries(trace);
}

function traceEntries(value: unknown): WorkflowTraceEntry[] {
  if (!Array.isArray(value)) return [];

  return value.filter(
    (entry): entry is WorkflowTraceEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).nodeId === 'string' &&
      typeof (entry as Record<string, unknown>).type === 'string',
  );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function FinalState({
  state,
  nodeDisplayName,
  execution,
}: {
  state: Record<string, unknown>;
  nodeDisplayName: (nodeId: string) => string;
  execution: WorkflowRunExecution[];
}) {
  const global = recordValue(state.global) ?? {};
  const nodes = recordValue(state.nodes) ?? {};
  const executionOrder = new Map(
    execution.map((entry, index) => [entry.nodeId, index]),
  );
  const nodeEntries = Object.entries(nodes)
    .filter(
      (entry): entry is [string, Record<string, unknown>] =>
        recordValue(entry[1]) !== undefined,
    )
    .sort(
      ([leftId], [rightId]) =>
        (executionOrder.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
        (executionOrder.get(rightId) ?? Number.MAX_SAFE_INTEGER),
    );

  return (
    <div className='flex flex-col gap-4 p-3'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-muted-foreground flex items-center gap-1.5 text-xs font-medium'>
          <Globe2Icon className='size-3.5' />
          {Object.keys(global).length} global key
          {Object.keys(global).length === 1 ? '' : 's'}
        </span>
        <span className='bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium'>
          {nodeEntries.length} node{nodeEntries.length === 1 ? '' : 's'}
        </span>
      </div>
      <StateSection label='Global state' value={global} scope='global' />
      {nodeEntries.length > 0 ? (
        <div className='flex flex-col gap-2'>
          <div className='text-muted-foreground flex items-center gap-1.5 px-1 text-xs font-medium'>
            <Layers3Icon className='size-3.5' />
            Node state
          </div>
          {nodeEntries.map(([nodeId, value]) => (
            <StateSection
              key={nodeId}
              label={nodeDisplayName(nodeId)}
              value={value}
              scope='node'
            />
          ))}
        </div>
      ) : (
        <p className='bg-muted/50 text-muted-foreground rounded-lg px-3 py-2 text-sm'>
          No node wrote state in this run.
        </p>
      )}
    </div>
  );
}

function TurnFinalState({
  state,
  nodeName,
  execution,
}: {
  state: Record<string, unknown>;
  nodeName: (nodeId: string) => string;
  execution: WorkflowRunExecution[];
}) {
  const { t } = useTranslation();
  return (
    <Collapsible className='bg-card overflow-hidden rounded-xl border shadow-sm'>
      <CollapsibleTrigger
        render={
          <Button
            variant='ghost'
            className='group hover:bg-muted/60 h-auto w-full justify-between rounded-none px-3 py-3'
          />
        }
      >
        <span className='flex items-center gap-2.5'>
          <span className='bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg'>
            <DatabaseIcon className='size-4' />
          </span>
          <span className='flex flex-col items-start'>
            <span className='text-sm font-semibold'>
              {t('workflowEditor.output.finalState')}
            </span>
            <span className='text-muted-foreground text-xs'>
              {t('workflowEditor.output.finalStateDescription')}
            </span>
          </span>
        </span>
        <ChevronDownIcon className='text-muted-foreground size-4 transition-transform group-data-panel-open/button:rotate-180' />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FinalState
          state={state}
          nodeDisplayName={nodeName}
          execution={execution}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

function StateSection({
  label,
  value,
  scope,
}: {
  label: string;
  value: Record<string, unknown>;
  scope: 'global' | 'node';
}) {
  const keyCount = Object.keys(value).length;
  return (
    <Collapsible
      defaultOpen={scope === 'global'}
      className='bg-card overflow-hidden rounded-lg border shadow-sm'
    >
      <CollapsibleTrigger
        render={
          <Button
            variant='ghost'
            className='group hover:bg-muted/70 w-full justify-between rounded-none px-3'
          />
        }
      >
        <span className='flex min-w-0 items-center gap-2'>
          {scope === 'global' ? (
            <Globe2Icon className='text-primary size-4 shrink-0' />
          ) : (
            <DatabaseIcon className='text-muted-foreground size-4 shrink-0' />
          )}
          <span className='truncate text-sm font-medium'>{label}</span>
        </span>
        <span className='text-muted-foreground flex shrink-0 items-center gap-2 text-xs'>
          {keyCount} key{keyCount === 1 ? '' : 's'}
          <ChevronDownIcon className='size-4 transition-transform group-data-panel-open/button:rotate-180' />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className='bg-muted/60 max-h-80 overflow-auto border-t px-3 py-2.5 font-mono text-xs leading-5'>
          {JSON.stringify(value, null, 2)}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function processLog(entry: WorkflowTraceEntry) {
  if (entry.type !== 'process') return '';
  const stdout = typeof entry.stdout === 'string' ? entry.stdout : '';
  const stderr = typeof entry.stderr === 'string' ? entry.stderr : '';
  return [stdout && `stdout\n${stdout}`, stderr && `stderr\n${stderr}`]
    .filter(Boolean)
    .join('\n\n');
}

function ExecutionOutput({ label, log }: { label: string; log: string }) {
  if (!log) return null;

  return (
    <div className='mt-3'>
      <p className='text-muted-foreground mb-1 text-xs font-medium'>{label}</p>
      <div className='bg-muted h-52 overflow-hidden rounded-md'>
        <LazyLog
          text={log}
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
      </div>
    </div>
  );
}

function toolCallOutput(value: unknown) {
  if (!Array.isArray(value)) return '';

  return value
    .map((item) => {
      if (typeof item !== 'object' || item === null) return '';
      const { stream, data } = item as Record<string, unknown>;
      return typeof stream === 'string' && typeof data === 'string'
        ? `${stream}\n${data}`
        : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

const ToolCalls = memo(function ToolCalls({ calls }: { calls: unknown[] }) {
  if (calls.length === 0) return null;

  return (
    <Collapsible className='mt-3 rounded-md border'>
      <CollapsibleTrigger
        render={<Button variant='ghost' className='w-full justify-between' />}
      >
        <span className='text-sm'>
          Tool call{calls.length === 1 ? '' : 's'} · {calls.length}
        </span>
        <ChevronDownIcon className='group-data-panel-open/button:rotate-180' />
      </CollapsibleTrigger>
      <CollapsibleContent className='flex flex-col gap-3 border-t p-3'>
        {calls.map((call, index) => {
          const record =
            typeof call === 'object' && call !== null
              ? (call as Record<string, unknown>)
              : {};
          const name =
            typeof record.name === 'string'
              ? record.name
              : typeof record.tool === 'string'
                ? record.tool
                : 'Tool';
          const denied = record.status === 'denied';
          const output = toolCallOutput(record.output);
          return (
            <div key={index} className='flex flex-col gap-2'>
              <div className='flex items-center gap-2'>
                <p className='text-sm font-medium'>{name}</p>
                {denied ? (
                  <span className='text-destructive text-xs font-medium'>
                    Denied by user
                  </span>
                ) : null}
              </div>
              <ToolCallValue label='Input' value={record.input} />
              {denied ? (
                <div>
                  <p className='text-muted-foreground text-xs font-medium'>
                    Status
                  </p>
                  <p className='mt-1 text-sm'>
                    {typeof record.message === 'string'
                      ? record.message
                      : 'Denied by user'}
                  </p>
                </div>
              ) : (
                <ToolCallValue label='Result' value={record.result} />
              )}
              <ExecutionOutput label='Output' log={output} />
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
});

function ToolCallValue({ label, value }: { label: string; value: unknown }) {
  if (value === undefined) return null;
  return (
    <div>
      <p className='text-muted-foreground text-xs font-medium'>{label}</p>
      <pre className='bg-muted mt-1 overflow-x-auto rounded-md p-2 text-xs'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function traceNodeName(entry: WorkflowTraceEntry) {
  if (typeof entry.workflowName === 'string' && entry.workflowName.trim())
    return entry.workflowName;
  if (typeof entry.nodeName === 'string' && entry.nodeName.trim())
    return entry.nodeName;
  return 'Workflow step';
}

function traceTypeLabel(type: string) {
  return type === 'subworkflow' ? 'Subworkflow' : type.replaceAll('_', ' ');
}

function SubworkflowExecution({ entry }: { entry: WorkflowTraceEntry }) {
  const entries = traceEntries(entry.execution);
  if (entries.length === 0) return null;

  return (
    <Collapsible className='mt-3 rounded-md border'>
      <CollapsibleTrigger
        render={<Button variant='ghost' className='w-full justify-between' />}
      >
        <span className='text-sm'>Subworkflow steps · {entries.length}</span>
        <ChevronDownIcon className='group-data-panel-open/button:rotate-180' />
      </CollapsibleTrigger>
      <CollapsibleContent className='flex flex-col gap-3 border-t p-3'>
        {entries.map((child, index) => {
          const log = processLog(child);
          return (
            <div
              key={`${child.nodeId}-${index}`}
              className='border-border/70 border-l pl-3'
            >
              <p className='text-sm font-medium'>
                {index + 1}. {traceNodeName(child)} ·{' '}
                {traceTypeLabel(child.type)}
              </p>
              <TraceResult entry={child} />
              <ExecutionOutput label='Process output' log={log} />
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function tokenCount(span: RunSpan) {
  return span.totalTokens ?? (span.inputTokens ?? 0) + (span.outputTokens ?? 0);
}

function formatCost(microusd: number) {
  return `$${(microusd / 1_000_000).toFixed(microusd >= 10_000 ? 2 : 4)}`;
}

const ModelUsage = memo(function ModelUsage({
  nodeId,
  spans,
}: {
  nodeId: string;
  spans: RunSpan[];
}) {
  const { t } = useTranslation();
  const modelCalls = spans.filter(
    (span) => span.kind === 'model_call' && span.nodeId === nodeId,
  );
  if (modelCalls.length === 0) return null;

  const inputTokens = modelCalls.reduce(
    (total, span) => total + (span.inputTokens ?? 0),
    0,
  );
  const outputTokens = modelCalls.reduce(
    (total, span) => total + (span.outputTokens ?? 0),
    0,
  );
  const totalTokens = modelCalls.reduce(
    (total, span) => total + tokenCount(span),
    0,
  );
  const cost = modelCalls.reduce(
    (total, span) => total + (span.estimatedCostMicrousd ?? 0),
    0,
  );

  return (
    <Collapsible className='bg-muted/35 mt-3 overflow-hidden rounded-md border'>
      <CollapsibleTrigger
        render={
          <Button
            variant='ghost'
            className='group h-auto w-full justify-between rounded-none px-3 py-2'
          />
        }
      >
        <span className='flex min-w-0 flex-col items-start'>
          <span className='text-sm font-medium'>
            {t('workflowEditor.output.telemetry.modelUsage')}
          </span>
          <span className='text-muted-foreground text-xs'>
            {t('workflowEditor.output.telemetry.modelUsageSummary', {
              count: modelCalls.length,
              totalTokens,
              inputTokens,
              outputTokens,
              cost: cost > 0 ? ` · ${formatCost(cost)}` : '',
            })}
          </span>
        </span>
        <ChevronDownIcon className='text-muted-foreground size-4 transition-transform group-data-panel-open/button:rotate-180' />
      </CollapsibleTrigger>
      <CollapsibleContent className='divide-y border-t'>
        {modelCalls.map((span, index) => {
          const details = [
            t('workflowEditor.output.telemetry.inputOutput', {
              inputTokens: span.inputTokens ?? 0,
              outputTokens: span.outputTokens ?? 0,
            }),
            span.cacheReadTokens
              ? t('workflowEditor.output.telemetry.cacheRead', {
                  count: span.cacheReadTokens,
                })
              : undefined,
            span.cacheWriteTokens
              ? t('workflowEditor.output.telemetry.cacheWrite', {
                  count: span.cacheWriteTokens,
                })
              : undefined,
            span.reasoningTokens
              ? t('workflowEditor.output.telemetry.reasoning', {
                  count: span.reasoningTokens,
                })
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div
              key={span.id}
              className='flex items-center gap-3 px-3 py-2 text-sm'
            >
              <div className='min-w-0 flex-1'>
                <div className='truncate font-medium'>
                  {span.model ??
                    t('workflowEditor.output.telemetry.modelCall', {
                      index: index + 1,
                    })}
                </div>
                <div className='text-muted-foreground truncate text-xs'>
                  {details ||
                    t('workflowEditor.output.telemetry.noUsageDetails')}
                </div>
              </div>
              <span className='text-muted-foreground shrink-0 font-mono text-xs'>
                {t('workflowEditor.output.telemetry.tokens', {
                  count: tokenCount(span),
                  estimated: span.totalTokensEstimated ? '~' : '',
                })}
              </span>
              <span className='text-muted-foreground w-12 shrink-0 text-right font-mono text-xs'>
                {span.durationMs == null ? '—' : `${span.durationMs}ms`}
              </span>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
});

function TraceResult({
  entry,
  showAgentResponse = true,
  spans = [],
  animateResponses = false,
  onResponsePresentationComplete,
}: {
  entry: WorkflowTraceEntry;
  showAgentResponse?: boolean;
  spans?: RunSpan[];
  /** Historical output is a snapshot and must never replay live typing. */
  animateResponses?: boolean;
  onResponsePresentationComplete?: (responseIndex: number) => void;
}) {
  const result =
    typeof entry.result === 'object' && entry.result !== null
      ? (entry.result as Record<string, unknown>)
      : undefined;

  // Cancellation is terminal regardless of node type; do not let an
  // individual node's normal completion fallback misrepresent it as finished.
  if (entry.status === 'cancelled')
    return (
      <p className='text-muted-foreground mt-2 text-sm'>
        Cancelled before this step completed.
      </p>
    );

  if (entry.type === 'human_review') {
    const approved = result?.approved;
    return (
      <p className='text-muted-foreground mt-2 text-sm'>
        {entry.status === 'running'
          ? 'Waiting for review…'
          : approved === true
            ? 'Approved.'
            : approved === false
              ? 'Rejected.'
              : 'Review completed.'}
      </p>
    );
  }

  if (entry.type === 'ask_user_question') {
    const label = typeof result?.label === 'string' ? result.label : undefined;
    return (
      <p className='text-muted-foreground mt-2 text-sm'>
        {entry.status === 'running'
          ? 'Waiting for an answer…'
          : label
            ? `Selected: ${label}.`
            : 'Answer received.'}
      </p>
    );
  }

  if (entry.type === 'subworkflow') {
    return (
      <>
        <p className='text-muted-foreground mt-2 text-sm'>
          {entry.status === 'running'
            ? 'Running subworkflow…'
            : 'Subworkflow completed.'}
        </p>
        <SubworkflowExecution entry={entry} />
      </>
    );
  }

  if (entry.type === 'terminate') {
    return (
      <p className='text-muted-foreground mt-2 text-sm'>Workflow terminated.</p>
    );
  }

  if (entry.type === 'if_else') {
    const route = result?.route;
    const label = typeof result?.label === 'string' ? result.label : undefined;
    const condition =
      typeof result?.condition === 'string' ? result.condition : undefined;
    const text =
      entry.status === 'running'
        ? 'Evaluating conditions…'
        : route === 'true'
          ? `Matched condition: ${label ?? 'True'}${condition ? ` (${condition})` : ''}.`
          : route === 'false'
            ? `Matched condition: ${label ?? 'False'}${condition ? ` (${condition})` : ''}.`
            : 'No condition matched; this path ended.';

    return <p className='text-muted-foreground mt-2 text-sm'>{text}</p>;
  }

  if (entry.type === 'switch') {
    const route = result?.route;
    const label = typeof result?.label === 'string' ? result.label : undefined;
    const condition =
      typeof result?.condition === 'string' ? result.condition : undefined;
    const text =
      entry.status === 'running'
        ? 'Evaluating cases…'
        : route === 'default'
          ? `No case condition matched; using default branch: ${label ?? 'Default'}.`
          : typeof route === 'string' && route.startsWith('case:')
            ? `Matched case: ${label ?? 'Untitled case'}${condition ? ` (${condition})` : ''}.`
            : 'No case condition matched; using the default branch.';

    return <p className='text-muted-foreground mt-2 text-sm'>{text}</p>;
  }

  if (entry.type === 'agent' || entry.type === 'remote_agent') {
    const toolCalls = Array.isArray(entry.toolCalls) ? entry.toolCalls : [];
    if (!showAgentResponse) {
      return (
        <>
          <p className='text-muted-foreground mt-2 text-sm'>
            {entry.status === 'running'
              ? 'Generating response…'
              : 'Response ready.'}
          </p>
          <ToolCalls calls={toolCalls} />
          <ModelUsage nodeId={entry.nodeId} spans={spans} />
        </>
      );
    }

    const messages = Array.isArray(entry.messages)
      ? entry.messages.filter(
          (message): message is Record<string, unknown> =>
            typeof message === 'object' && message !== null,
        )
      : [];
    const responses = messages
      .map((message) => message.content)
      .filter((content): content is string => typeof content === 'string');

    return (
      <>
        <ToolCalls calls={toolCalls} />
        <ModelUsage nodeId={entry.nodeId} spans={spans} />
        {responses.length > 0 ? (
          <div className='border-primary/25 mt-2 space-y-2 border-l-2 pl-3'>
            {responses.map((response, index) => (
              <div key={index} className='text-sm leading-6'>
                {animateResponses ? (
                  <TypewriterMarkdown
                    content={response}
                    isStreaming={entry.status === 'running'}
                    onPresentationComplete={() =>
                      onResponsePresentationComplete?.(index)
                    }
                  />
                ) : (
                  <MarkdownContent content={response} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className='text-muted-foreground mt-2 text-sm'>
            {entry.status === 'running'
              ? 'Waiting for a response…'
              : 'Completed without a text response.'}
          </p>
        )}
      </>
    );
  }

  if (entry.type === 'process') {
    return entry.result === undefined ? (
      <p className='text-muted-foreground mt-2 text-sm'>
        {entry.status === 'running'
          ? 'Running process…'
          : 'Completed without a structured result.'}
      </p>
    ) : (
      <div className='mt-2'>
        <p className='text-muted-foreground text-sm'>
          Returned a structured result.
        </p>
        <pre className='bg-muted mt-2 overflow-x-auto rounded-md p-3 text-xs'>
          {JSON.stringify(entry.result, null, 2)}
        </pre>
      </div>
    );
  }

  return (
    <p className='text-muted-foreground mt-2 text-sm'>
      {entry.status === 'running' ? 'Running…' : 'Completed.'}
    </p>
  );
}

function executionStatusIcon(status: WorkflowRunExecution['status']) {
  if (status === 'running') return <Spinner />;
  if (status === 'failed') return <CircleAlertIcon />;
  if (status === 'cancelled') return <CircleXIcon />;
  return <CheckCircle2Icon />;
}

function codeText(children: ReactNode) {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') return child;
      if (typeof child === 'number') return child.toString();
      return '';
    })
    .join('')
    .replace(/\n$/, '');
}

const markdownComponents = {
  a: ({ children, ...props }: React.ComponentProps<'a'>) => (
    <a
      {...props}
      className='text-primary underline underline-offset-3'
      target='_blank'
      rel='noreferrer'
    >
      {children}
    </a>
  ),
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className='text-muted-foreground border-border border-l pl-3'>
      {children}
    </blockquote>
  ),
  code: ({
    children,
    className,
  }: {
    children?: ReactNode;
    className?: string;
  }) =>
    className ? (
      <WorkflowCodeBlock className={className} code={codeText(children)} />
    ) : (
      <code className='bg-muted rounded px-1 py-0.5'>{children}</code>
    ),
  h1: ({ children }: { children?: ReactNode }) => (
    <h1 className='text-base font-semibold'>{children}</h1>
  ),
  h2: ({ children }: { children?: ReactNode }) => (
    <h2 className='text-sm font-semibold'>{children}</h2>
  ),
  li: ({ children }: { children?: ReactNode }) => (
    <li className='leading-6'>{children}</li>
  ),
  ol: ({ children }: { children?: ReactNode }) => (
    <ol className='list-decimal pl-5'>{children}</ol>
  ),
  p: ({ children }: { children?: ReactNode }) => (
    <p className='leading-6'>{children}</p>
  ),
  pre: ({ children }: { children?: ReactNode }) => (
    <pre className='bg-background border-border overflow-x-auto rounded-md border p-3'>
      {children}
    </pre>
  ),
  ul: ({ children }: { children?: ReactNode }) => (
    <ul className='list-disc pl-5'>{children}</ul>
  ),
};

function MarkdownContent({
  content,
  isStreaming = false,
}: {
  content: string;
  isStreaming?: boolean;
}) {
  if (isStreaming) {
    return <p className='leading-6 whitespace-pre-wrap'>{content}</p>;
  }

  return <Markdown components={markdownComponents}>{content}</Markdown>;
}

/**
 * Reveals only this response locally. Keeping the animation outside Zustand
 * prevents a cosmetic typing frame from invalidating the workflow timeline.
 */
function TypewriterMarkdown({
  content,
  isStreaming,
  onPresentationComplete,
}: {
  content: string;
  isStreaming: boolean;
  onPresentationComplete?: () => void;
}) {
  const [displayed, setDisplayed] = useState('');
  const displayedRef = useRef('');
  const completeRef = useRef(onPresentationComplete);
  completeRef.current = onPresentationComplete;

  useEffect(() => {
    // A resumed/replaced response is not an append; reveal its new value from
    // the beginning rather than slicing through a Unicode grapheme.
    if (!content.startsWith(displayedRef.current)) {
      displayedRef.current = '';
      setDisplayed('');
    }
    const graphemes = Array.from(content);
    let frame: number | undefined;
    let cancelled = false;
    const reveal = () => {
      if (cancelled) return;
      const shown = Array.from(displayedRef.current).length;
      if (shown >= graphemes.length) return;
      const remaining = graphemes.length - shown;
      const next = graphemes
        .slice(
          0,
          shown + Math.min(1 + Math.floor(Math.sqrt(remaining) * 0.6), 32),
        )
        .join('');
      displayedRef.current = next;
      setDisplayed(next);
      frame = requestAnimationFrame(reveal);
    };
    frame = requestAnimationFrame(reveal);
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [content]);

  useEffect(() => {
    if (!isStreaming && displayed === content) completeRef.current?.();
  }, [content, displayed, isStreaming]);

  return (
    <MarkdownContent
      content={displayed}
      // Defer Markdown parsing until the local reveal is complete; parsing a
      // new AST for every character is itself a source of layout churn.
      isStreaming={isStreaming || displayed !== content}
    />
  );
}

function ChatMessageBubble({
  message,
  nodeName,
  animateResponse = false,
  onResponsePresentationComplete,
}: {
  message: WorkflowRunMessage;
  nodeName: string;
  animateResponse?: boolean;
  onResponsePresentationComplete?: () => void;
}) {
  const isUser = message.role === 'user';
  // This is intentionally captured on mount. A response restored from a
  // session never starts typing, while a response mounted during a live run
  // continues its local reveal after the runtime reaches its terminal event.
  const [typewriterStarted] = useState(() => !isUser && animateResponse);

  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        {!isUser && <MessageHeader>{nodeName}</MessageHeader>}
        <Bubble
          align={isUser ? 'end' : 'start'}
          variant={isUser ? 'secondary' : 'ghost'}
        >
          <BubbleContent>
            {!isUser && typewriterStarted ? (
              <TypewriterMarkdown
                content={message.content}
                isStreaming={message.isStreaming}
                onPresentationComplete={onResponsePresentationComplete}
              />
            ) : (
              <MarkdownContent
                content={message.content}
                isStreaming={message.isStreaming}
              />
            )}
          </BubbleContent>
        </Bubble>
        {message.isStreaming && (
          <span className='text-muted-foreground flex items-center gap-1 px-3 text-xs'>
            <Spinner /> Streaming
          </span>
        )}
      </MessageContent>
    </Message>
  );
}

function ThinkingProcess({
  thoughts,
  isRunning,
  nodeName,
}: {
  thoughts: WorkflowRunView['thoughts'];
  isRunning: boolean;
  nodeName: (nodeId: string) => string;
}) {
  const { t } = useTranslation();
  if (thoughts.length === 0 && !isRunning) return null;

  const completed = thoughts.filter(
    (thought) => thought.status === 'completed',
  ).length;
  const label = isRunning
    ? completed > 0
      ? t('workflowEditor.output.thinkingProgress', { count: completed })
      : t('workflowEditor.output.thinking')
    : t('workflowEditor.output.thinkingProgress', { count: completed });

  return (
    <div className='flex flex-col gap-2 py-1'>
      <Marker variant='separator'>
        <MarkerIcon>
          {isRunning ? <Spinner /> : <CheckCircle2Icon />}
        </MarkerIcon>
        <MarkerContent>{label}</MarkerContent>
      </Marker>
      {thoughts.length > 0 && (
        <div className='flex flex-col gap-1.5 px-3'>
          {thoughts.map((thought) => (
            <Marker key={thought.id}>
              <MarkerIcon>
                {thought.status === 'running' ? <Spinner /> : <CircleIcon />}
              </MarkerIcon>
              <MarkerContent>
                {thought.status === 'running'
                  ? t('workflowEditor.output.workingIn', {
                      node: nodeName(thought.nodeId),
                    })
                  : t('workflowEditor.output.finishedIn', {
                      node: nodeName(thought.nodeId),
                    })}
                {thought.durationMs !== undefined
                  ? ` · ${(thought.durationMs / 1000).toFixed(1)}s`
                  : ''}
              </MarkerContent>
            </Marker>
          ))}
        </div>
      )}
    </div>
  );
}

/** A single, keyed tail item for live thoughts; it is not an execution row. */
const LiveThinkingProcess = memo(function LiveThinkingProcess({
  workflowNodes,
  isRunning,
}: {
  workflowNodes: Node[];
  isRunning: boolean;
}) {
  const { t } = useTranslation();
  const thoughtIds = useWorkflowRunStore(
    (state) => state.projection.thoughtIds,
  );
  const thoughtsById = useWorkflowRunStore(
    (state) => state.projection.thoughtsById,
  );
  const activeThoughts = useMemo(
    () =>
      thoughtIds
        .map((thoughtId) => thoughtsById[thoughtId])
        .filter(
          (item): item is NonNullable<typeof item> =>
            item?.status === 'running',
        ),
    [thoughtIds, thoughtsById],
  );
  const completedThoughts = useMemo(
    () =>
      thoughtIds
        .map((thoughtId) => thoughtsById[thoughtId])
        .filter(
          (item): item is NonNullable<typeof item> =>
            item?.status === 'completed',
        ),
    [thoughtIds, thoughtsById],
  );

  if (!isRunning && completedThoughts.length === 0) return null;

  const displayNodeName = (id: string) =>
    nodeDisplayName({ nodes: [] }, workflowNodes, id);

  return (
    <div className='flex flex-col gap-2 py-2'>
      <Marker variant='separator'>
        <MarkerIcon>
          {activeThoughts.length > 0 ? <Spinner /> : <CheckCircle2Icon />}
        </MarkerIcon>
        <MarkerContent>
          {activeThoughts.length > 0 && completedThoughts.length > 0
            ? t('workflowEditor.output.thinkingProgress', {
                count: completedThoughts.length,
              })
            : activeThoughts.length > 0
              ? t('workflowEditor.output.thinking')
              : t('workflowEditor.output.thinkingProgress', {
                  count: completedThoughts.length,
                })}
        </MarkerContent>
      </Marker>
      <div className='flex flex-col gap-1.5 px-3'>
        {completedThoughts.map((item) => (
          <Marker key={item.id}>
            <MarkerIcon>
              <CircleIcon />
            </MarkerIcon>
            <MarkerContent>
              {t('workflowEditor.output.finishedIn', {
                node: displayNodeName(item.nodeId),
              })}
              {item.durationMs !== undefined
                ? ` · ${(item.durationMs / 1000).toFixed(1)}s`
                : ''}
            </MarkerContent>
          </Marker>
        ))}
        {activeThoughts.map((thought) => (
          <Marker key={thought.id}>
            <MarkerIcon>
              <Spinner />
            </MarkerIcon>
            <MarkerContent>
              {t('workflowEditor.output.workingIn', {
                node: displayNodeName(thought.nodeId),
              })}
            </MarkerContent>
          </Marker>
        ))}
      </div>
    </div>
  );
});

const LiveTaskExecution = memo(function LiveTaskExecution({
  id,
  index,
  workflowNodes,
  spans,
  onResponsePresentationComplete,
}: {
  id: string;
  index: number;
  workflowNodes: Node[];
  spans: RunSpan[];
  onResponsePresentationComplete: (responseIndex: number) => void;
}) {
  const { t } = useTranslation();

  const entry = useWorkflowRunStore(
    (state) => state.projection.executionsById[id],
  );
  if (!entry) return null;

  const displayNodeName = (nodeId: string) =>
    nodeDisplayName({ nodes: [] }, workflowNodes, nodeId);

  const app = processNodeInfo(workflowNodes, entry.nodeId);
  const log = processLog(entry);

  return (
    <MessageScrollerItem
      messageId={id}
      // Dynamic output cannot use the scroller's estimated 10rem item height:
      // swapping that estimate for real streamed text causes visible reflow.
      style={{ contentVisibility: 'visible' }}
    >
      <Marker variant='separator'>
        <MarkerIcon>{executionStatusIcon(entry.status)}</MarkerIcon>
        <MarkerContent>
          {index + 2}. {displayNodeName(entry.nodeId)} · {entry.type}
          {entry.durationMs !== undefined ? ` · ${entry.durationMs}ms` : ''}
        </MarkerContent>
      </Marker>
      {app ? (
        <div className='mt-2 flex items-center gap-2 px-1 text-sm'>
          <span className='font-medium'>
            {app.appName || displayNodeName(entry.nodeId)}
          </span>
          {app.version ? (
            <Badge className='font-mono text-xs' variant='secondary'>
              v{app.version}
            </Badge>
          ) : null}
        </div>
      ) : null}
      <TraceResult
        entry={entry}
        spans={spans}
        animateResponses
        onResponsePresentationComplete={onResponsePresentationComplete}
      />
      <ExecutionOutput
        label={t('workflowEditor.output.processOutput')}
        log={log}
      />
    </MessageScrollerItem>
  );
});

function RunTelemetry({
  spans,
  nodeName,
}: {
  spans: RunSpan[];
  nodeName: (nodeId: string) => string;
}) {
  const { t } = useTranslation();
  if (spans.length === 0) return null;
  const workflowNodes = spans.filter(
    (span) => span.kind === 'workflow_node',
  ).length;
  const toolCalls = spans.filter((span) => span.kind === 'tool_call').length;
  const inputTokens = spans.reduce(
    (total, span) => total + (span.inputTokens ?? 0),
    0,
  );
  const outputTokens = spans.reduce(
    (total, span) => total + (span.outputTokens ?? 0),
    0,
  );
  const totalTokens = spans.reduce(
    (total, span) => total + (span.totalTokens ?? 0),
    0,
  );

  return (
    <Collapsible className='bg-card overflow-hidden rounded-xl border shadow-sm'>
      <CollapsibleTrigger
        render={
          <Button
            variant='ghost'
            className='group hover:bg-muted/60 h-auto w-full justify-between rounded-none px-3 py-3'
          />
        }
      >
        <span className='flex items-center gap-2.5'>
          <span className='bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg'>
            <TerminalIcon className='size-4' />
          </span>
          <span className='flex flex-col items-start'>
            <span className='text-sm font-semibold'>
              {t('workflowEditor.output.telemetry.runtimeDiagnostics')}
            </span>
            <span className='text-muted-foreground text-xs'>
              {t('workflowEditor.output.telemetry.runtimeSummary', {
                workflowNodes,
                toolCalls,
              })}
              {totalTokens
                ? ` · ${t('workflowEditor.output.telemetry.runtimeTokens', {
                    totalTokens,
                    inputTokens,
                    outputTokens,
                  })}`
                : ''}
            </span>
          </span>
        </span>
        <ChevronDownIcon className='text-muted-foreground size-4 transition-transform group-data-panel-open/button:rotate-180' />
      </CollapsibleTrigger>
      <CollapsibleContent className='divide-y border-t'>
        {spans.map((span) => {
          // Process Apps need a stable, identifier-safe model tool name. Their
          // display name is persisted separately in nodeName for the UI.
          const toolName = isProcessToolName(span.toolName)
            ? span.nodeName
            : span.toolName;
          const label =
            toolName ??
            span.nodeName ??
            (span.nodeId ? nodeName(span.nodeId) : undefined) ??
            span.kind.replaceAll('_', ' ');
          const tokens = span.totalTokens
            ? t('workflowEditor.output.telemetry.tokens', {
                count: span.totalTokens,
                estimated: span.totalTokensEstimated ? '~' : '',
              })
            : undefined;
          const tokenBreakdown = [
            span.cacheReadTokens
              ? t('workflowEditor.output.telemetry.cacheRead', {
                  count: span.cacheReadTokens,
                })
              : undefined,
            span.cacheWriteTokens
              ? t('workflowEditor.output.telemetry.cacheWrite', {
                  count: span.cacheWriteTokens,
                })
              : undefined,
            span.reasoningTokens
              ? t('workflowEditor.output.telemetry.reasoning', {
                  count: span.reasoningTokens,
                })
              : undefined,
            span.audioInputTokens || span.audioOutputTokens
              ? t('workflowEditor.output.telemetry.audioInputOutput', {
                  inputTokens: span.audioInputTokens ?? 0,
                  outputTokens: span.audioOutputTokens ?? 0,
                })
              : undefined,
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <div
              key={span.id}
              className='flex items-center gap-3 px-3 py-2.5 text-sm'
            >
              <div className='min-w-0 flex-1'>
                <div className='truncate font-medium'>{label}</div>
                {tokenBreakdown ? (
                  <div className='text-muted-foreground truncate text-xs'>
                    {tokenBreakdown}
                  </div>
                ) : null}
              </div>
              <span className='text-muted-foreground shrink-0 text-xs'>
                {t(`workflowEditor.output.telemetry.spanKinds.${span.kind}`)}
              </span>
              {tokens ? (
                <span className='text-muted-foreground shrink-0 font-mono text-xs'>
                  {tokens}
                </span>
              ) : null}
              <span
                className={
                  span.status === 'failed'
                    ? 'text-destructive shrink-0 text-xs'
                    : 'text-muted-foreground shrink-0 text-xs'
                }
              >
                {t(
                  `workflowEditor.output.telemetry.spanStatuses.${span.status}`,
                )}
              </span>
              <span className='text-muted-foreground w-14 shrink-0 text-right font-mono text-xs'>
                {span.durationMs == null ? '—' : `${span.durationMs}ms`}
              </span>
            </div>
          );
        })}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunModelUsage({ spans, title }: { spans: RunSpan[]; title?: string }) {
  const { t } = useTranslation();
  const modelCalls = spans.filter((span) => span.kind === 'model_call');
  if (modelCalls.length === 0) return null;

  const totalTokens = modelCalls.reduce(
    (total, span) => total + tokenCount(span),
    0,
  );
  const inputTokens = modelCalls.reduce(
    (total, span) => total + (span.inputTokens ?? 0),
    0,
  );
  const outputTokens = modelCalls.reduce(
    (total, span) => total + (span.outputTokens ?? 0),
    0,
  );
  const cost = modelCalls.reduce(
    (total, span) => total + (span.estimatedCostMicrousd ?? 0),
    0,
  );
  const agents = new Set(
    modelCalls
      .map((span) => span.nodeId)
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  ).size;

  return (
    <div className='bg-primary/4 border-primary/15 rounded-xl border px-3 py-3'>
      <div className='flex items-center justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-sm font-semibold'>
            {title ?? t('workflowEditor.output.telemetry.runModelUsage')}
          </p>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('workflowEditor.output.telemetry.runModelUsageSummary', {
              count: agents,
              inputTokens,
              outputTokens,
              modelCalls: modelCalls.length,
            })}
          </p>
        </div>
        <div className='shrink-0 text-right'>
          <p className='font-mono text-base font-semibold'>
            {t('workflowEditor.output.telemetry.tokens', {
              count: totalTokens,
              estimated: '',
            })}
          </p>
          {cost > 0 ? (
            <p className='text-muted-foreground font-mono text-xs'>
              {t('workflowEditor.output.telemetry.estimatedCost', {
                cost: formatCost(cost),
              })}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function chatTurnResponse(
  execution: WorkflowRunExecution[],
  turnId?: string,
): WorkflowRunMessage | undefined {
  // Agent events are stored on their execution so task output can keep its
  // trace. In chat, surface only the last response as the conversational
  // answer; earlier agent output remains available from the run receipt.
  const responses = execution.flatMap((entry) => {
    if (entry.type !== 'agent' && entry.type !== 'remote_agent') return [];
    const messages = Array.isArray(entry.messages) ? entry.messages : [];
    return messages.flatMap((message) => {
      if (typeof message !== 'object' || message === null) return [];
      const content = (message as Record<string, unknown>).content;
      return typeof content === 'string' && content.trim()
        ? [
            {
              content,
              nodeId: entry.nodeId,
              isStreaming: entry.status === 'running',
            },
          ]
        : [];
    });
  });
  const response = responses.at(-1);
  return response
    ? {
        // The turn ID remains stable while streamed content grows. That keeps
        // the local typewriter mounted across runtime status updates.
        id: `response:${turnId ?? response.nodeId}:${response.nodeId}`,
        role: 'assistant',
        ...response,
      }
    : undefined;
}

function turnStatusIcon(status: WorkflowRunTurn['status']) {
  if (status === 'running') return <Spinner className='size-3.5' />;
  if (status === 'failed') return <CircleAlertIcon className='size-3.5' />;
  if (status === 'cancelled') return <CircleXIcon className='size-3.5' />;
  if (status === 'interrupted') return <CircleAlertIcon className='size-3.5' />;
  return <CheckCircle2Icon className='size-3.5' />;
}

function ChatSessionUsage({
  spans,
  turnCount,
}: {
  spans: RunSpan[];
  turnCount: number;
}) {
  const { t } = useTranslation();
  const modelCalls = spans.filter((span) => span.kind === 'model_call');
  const totalTokens = modelCalls.reduce(
    (total, span) => total + tokenCount(span),
    0,
  );
  const cost = modelCalls.reduce(
    (total, span) => total + (span.estimatedCostMicrousd ?? 0),
    0,
  );

  if (turnCount === 0 && totalTokens === 0) return null;
  return (
    <div className='text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs'>
      {turnCount > 0 ? (
        <span>
          {t('workflowEditor.output.turnCount', { count: turnCount })}
        </span>
      ) : null}
      {totalTokens > 0 ? (
        <span className='before:mr-2 before:content-["·"]'>
          {t('workflowEditor.output.telemetry.tokens', {
            count: totalTokens,
            estimated: '',
          })}
        </span>
      ) : null}
      {cost > 0 ? (
        <span className='before:mr-2 before:content-["·"]'>
          {formatCost(cost)}
        </span>
      ) : null}
    </div>
  );
}

function ChatTurnReceipt({
  turn,
  execution,
  thoughts,
  spans,
  nodeName,
  isResponsePresenting = false,
}: {
  turn?: WorkflowRunTurn;
  execution: WorkflowRunExecution[];
  thoughts: WorkflowRunView['thoughts'];
  spans: RunSpan[];
  nodeName: (nodeId: string) => string;
  isResponsePresenting?: boolean;
}) {
  const { t } = useTranslation();
  // Do not replace the live receipt with its terminal form while the answer
  // is still typing. Apart from looking calmer, this avoids a terminal layout
  // change competing with the response's own height changes.
  const status = isResponsePresenting ? 'running' : (turn?.status ?? 'running');
  const toolCalls = spans.filter((span) => span.kind === 'tool_call').length;
  const modelTokens = spans
    .filter((span) => span.kind === 'model_call')
    .reduce((total, span) => total + tokenCount(span), 0);
  const duration = turn
    ? durationLabel({
        status: turn.status,
        startedAt: turn.startedAt,
        endedAt: turn.endedAt,
        durationMs: turn.durationMs,
      } as WorkflowRunView)
    : undefined;
  const completed = status !== 'running' && status !== 'idle';

  return (
    <Collapsible className='border-border/60 mt-1 border-t'>
      <CollapsibleTrigger
        render={
          <Button
            variant='ghost'
            className='group h-auto w-full justify-between rounded-none px-0 py-2 text-left hover:bg-transparent'
          />
        }
      >
        <span className='text-muted-foreground flex min-w-0 items-center gap-2 text-xs'>
          <span
            className={
              status === 'failed'
                ? 'text-destructive'
                : status === 'running'
                  ? 'text-primary'
                  : 'text-muted-foreground'
            }
          >
            {turnStatusIcon(status)}
          </span>
          <span className='font-medium'>
            {status === 'running'
              ? t('workflowEditor.output.workflowWorking')
              : t('workflowEditor.output.workflowReceipt')}
          </span>
          <span className='truncate'>
            {t(`workflowEditor.output.status.${status}`)}
            {execution.length > 0
              ? ` · ${t('workflowEditor.output.stepCount', { count: execution.length })}`
              : ''}
            {toolCalls > 0
              ? ` · ${t('workflowEditor.output.toolCount', { count: toolCalls })}`
              : ''}
            {modelTokens > 0
              ? ` · ${t('workflowEditor.output.telemetry.tokens', { count: modelTokens, estimated: '' })}`
              : ''}
            {duration ? ` · ${duration}` : ''}
          </span>
        </span>
        <span className='text-muted-foreground flex shrink-0 items-center gap-1 text-xs'>
          {t('workflowEditor.output.viewRunDetails')}
          <ChevronDownIcon className='size-3.5 transition-transform group-data-panel-open/button:rotate-180' />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='pt-1 pb-3'>
        {turn?.error ? (
          <p className='text-destructive mb-3 text-sm'>{turn.error}</p>
        ) : null}
        {!completed && execution.length === 0 ? (
          <ThinkingProcess thoughts={thoughts} isRunning nodeName={nodeName} />
        ) : null}
        {execution.length > 0 ? (
          <div className='border-border/70 ml-1 space-y-3 border-l pl-4'>
            {execution.map((entry, index) => (
              <div key={`${entry.nodeId}-${index}`} className='relative'>
                <span className='bg-background border-border absolute top-1 -left-[21px] flex size-3 items-center justify-center rounded-full border'>
                  {executionStatusIcon(entry.status)}
                </span>
                <p className='text-sm font-medium'>
                  {nodeName(entry.nodeId)}
                  <span className='text-muted-foreground font-normal'>
                    {' · '}
                    {entry.type}
                    {entry.durationMs !== undefined
                      ? ` · ${(entry.durationMs / 1000).toFixed(1)}s`
                      : ''}
                  </span>
                </p>
                {/* The chat surface promotes only the final answer, while the
                    expanded receipt remains a complete per-node record. */}
                <TraceResult entry={entry} spans={spans} />
                <ExecutionOutput
                  label={t('workflowEditor.output.processOutput')}
                  log={processLog(entry)}
                />
              </div>
            ))}
          </div>
        ) : null}
        {turn?.finalState ? (
          <div className='mt-3'>
            <TurnFinalState
              state={turn.finalState}
              nodeName={nodeName}
              execution={execution}
            />
          </div>
        ) : null}
        <div className='mt-3'>
          <RunTelemetry spans={spans} nodeName={nodeName} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Live task output deliberately does not receive a derived view as a prop. Its
 * rows subscribe to `executionsById[id]`, so Rust output for the active node
 * cannot rerender or remount completed rows (or the thinking spinner).
 */
function LiveWorkflowTaskOutput({
  workflowNodes,
  onRunAgain,
  onClose,
  readOnly = false,
  spans = [],
}: Omit<WorkflowOutputPanelProps, 'run' | 'isRunning' | 'isChat' | 'onSend'>) {
  const { t } = useTranslation();
  const {
    status,
    startedAt,
    endedAt,
    durationMs,
    activeNodeId,
    error,
    finalState,
    executionIds,
    thoughtIds,
  } = useWorkflowRunStore(
    useShallow((state) => ({
      status: state.projection.status,
      startedAt: state.projection.startedAt,
      endedAt: state.projection.endedAt,
      durationMs: state.projection.durationMs,
      activeNodeId: state.projection.activeNodeId,
      error: state.projection.error,
      finalState: state.projection.finalState,
      executionIds: state.projection.executionIds,
      thoughtIds: state.projection.thoughtIds,
    })),
  );
  const [presentation, setPresentation] = useState(() => ({
    startedAt,
    responses: new Set<string>(),
  }));
  // A new run gets an empty presentation set during this same render. The
  // callback below adopts its key atomically, avoiding a reset effect.
  const presentedResponses =
    presentation.startedAt === startedAt ? presentation.responses : new Set();

  const responseIds = executionIds.flatMap((id) => {
    const messages =
      useWorkflowRunStore.getState().projection.executionsById[id]?.messages;
    return Array.isArray(messages)
      ? messages.flatMap((message, index) =>
          typeof message === 'object' &&
          message !== null &&
          typeof (message as { content?: unknown }).content === 'string' &&
          (message as { content: string }).content.length > 0
            ? [`${id}:${index}`]
            : [],
        )
      : [];
  });
  const terminal = status !== 'idle' && status !== 'running';
  const presentationComplete =
    !terminal || responseIds.every((id) => presentedResponses.has(id));
  const presentationStatus = presentationComplete ? status : 'running';
  const onResponsePresentationComplete = useCallback(
    (id: string) => {
      setPresentation((current) => {
        const responses =
          current.startedAt === startedAt
            ? current.responses
            : new Set<string>();
        if (responses.has(id) && current.startedAt === startedAt)
          return current;
        const next = new Set(responses);
        next.add(id);
        return { startedAt, responses: next };
      });
    },
    [startedAt],
  );
  const run: WorkflowRunView = {
    status: presentationStatus,
    startedAt,
    endedAt,
    durationMs,
    activeNodeId,
    error,
    finalState,
    nodes: [],
    messages: [],
    thoughts: [],
    processLogs: [],
    execution: [],
    turnsById: {},
  };
  const isRunning = presentationStatus === 'running';
  const duration = durationLabel(run);
  const displayNodeName = (nodeId: string) =>
    nodeDisplayName(run, workflowNodes, nodeId);
  const copyAll = async () => {
    const live = useWorkflowRunStore.getState().projection;
    const output = live.executionIds
      .flatMap((id) => {
        const messages = live.executionsById[id]?.messages;
        return Array.isArray(messages)
          ? messages.map((message) =>
              typeof message === 'object' &&
              message !== null &&
              typeof (message as { content?: unknown }).content === 'string'
                ? (message as { content: string }).content
                : '',
            )
          : [];
      })
      .filter(Boolean)
      .join('\n\n');
    if (output) await navigator.clipboard.writeText(output);
  };

  return (
    <>
      <DrawerHeader className='relative min-h-16'>
        <DrawerTitle>{t('workflowEditor.output.runOutput')}</DrawerTitle>
        <DrawerDescription className='absolute inset-x-4 bottom-2'>
          {statusLabel(run, t)}
          {activeNodeId ? ` · ${displayNodeName(activeNodeId)}` : ''}
          {duration ? ` · ${duration}` : ''}
        </DrawerDescription>
      </DrawerHeader>

      <div className='relative flex min-h-0 flex-1 flex-col'>
        {error ? (
          <Alert
            variant='destructive'
            className='z-10 mx-4 mb-4 w-auto shadow-md'
          >
            <CircleAlertIcon />
            <AlertTitle>{t('workflowEditor.output.workflowFailed')}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className='mx-4'>
          <RunModelUsage spans={spans} />
        </div>

        <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className='gap-4 px-4 py-4'>
                {executionIds.length > 0 ? (
                  <MessageScrollerItem
                    messageId='execution-start'
                    style={{ contentVisibility: 'visible' }}
                  >
                    <div>
                      <Marker variant='separator'>
                        <MarkerIcon>
                          <CheckCircle2Icon />
                        </MarkerIcon>
                        <MarkerContent>
                          1. {t('workflowEditor.output.start')}
                        </MarkerContent>
                      </Marker>
                      <p className='text-muted-foreground mt-2 text-sm'>
                        {t('workflowEditor.output.workflowStarted')}
                      </p>
                    </div>
                  </MessageScrollerItem>
                ) : null}
                {executionIds.map((id, index) => (
                  <LiveTaskExecution
                    key={id}
                    id={id}
                    index={index}
                    workflowNodes={workflowNodes}
                    spans={spans}
                    onResponsePresentationComplete={(responseIndex) =>
                      onResponsePresentationComplete(`${id}:${responseIndex}`)
                    }
                  />
                ))}
                <MessageScrollerItem
                  key='live-thinking'
                  messageId='live-thinking'
                  style={{ contentVisibility: 'visible' }}
                >
                  <LiveThinkingProcess
                    workflowNodes={workflowNodes}
                    isRunning={isRunning}
                  />
                </MessageScrollerItem>
                {presentationComplete &&
                status === 'completed' &&
                executionIds.length > 0 ? (
                  <MessageScrollerItem
                    messageId='execution-end'
                    style={{ contentVisibility: 'visible' }}
                  >
                    <Marker variant='separator'>
                      <MarkerIcon>
                        <CheckCircle2Icon />
                      </MarkerIcon>
                      <MarkerContent>
                        {executionIds.length + 2}.{' '}
                        {t('workflowEditor.output.end')}
                      </MarkerContent>
                    </Marker>
                    <p className='text-muted-foreground mt-2 text-sm'>
                      {t('workflowEditor.output.workflowCompleted')}
                    </p>
                  </MessageScrollerItem>
                ) : null}
                {executionIds.length === 0 &&
                isRunning &&
                thoughtIds.length === 0 ? (
                  <Empty className='border-0'>
                    <EmptyHeader>
                      <EmptyMedia variant='icon'>
                        <Spinner />
                      </EmptyMedia>
                      <EmptyTitle>
                        {t('workflowEditor.output.waitingForOutput')}
                      </EmptyTitle>
                      <EmptyDescription>
                        {t('workflowEditor.output.responsesAppearHere')}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
                {presentationComplete && finalState ? (
                  <MessageScrollerItem
                    messageId='final-state'
                    style={{ contentVisibility: 'visible' }}
                  >
                    <Collapsible className='bg-card overflow-hidden rounded-xl border shadow-sm'>
                      <CollapsibleTrigger
                        render={
                          <Button
                            variant='ghost'
                            className='group hover:bg-muted/60 h-auto w-full justify-between rounded-none px-3 py-3'
                          />
                        }
                      >
                        <span className='flex items-center gap-2.5'>
                          <span className='bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg'>
                            <DatabaseIcon className='size-4' />
                          </span>
                          <span className='flex flex-col items-start'>
                            <span className='text-sm font-semibold'>
                              {t('workflowEditor.output.finalState')}
                            </span>
                            <span className='text-muted-foreground text-xs'>
                              {t('workflowEditor.output.finalStateDescription')}
                            </span>
                          </span>
                        </span>
                        <ChevronDownIcon className='text-muted-foreground size-4 transition-transform group-data-panel-open/button:rotate-180' />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <FinalState
                          state={finalState}
                          nodeDisplayName={displayNodeName}
                          execution={executionIds
                            .map(
                              (id) =>
                                useWorkflowRunStore.getState().projection
                                  .executionsById[id],
                            )
                            .filter(Boolean)}
                        />
                      </CollapsibleContent>
                    </Collapsible>
                  </MessageScrollerItem>
                ) : null}
                {presentationComplete ? (
                  <RunTelemetry spans={spans} nodeName={displayNodeName} />
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>
      <DrawerFooter className='flex-row justify-end'>
        {!readOnly ? (
          <Button variant='outline' disabled={isRunning} onClick={onRunAgain}>
            <RotateCcwIcon data-icon='inline-start' />
            {rerunLabel(status, t)}
          </Button>
        ) : null}
        <Button variant='outline' onClick={copyAll}>
          <ClipboardIcon data-icon='inline-start' />
          {t('workflowEditor.output.copyAll')}
        </Button>
        <Button type='button' onClick={onClose}>
          {t('workflowEditor.output.close')}
        </Button>
      </DrawerFooter>
    </>
  );
}

function WorkflowRunOutput({
  run,
  workflowNodes,
  isRunning,
  onRunAgain,
  onClose,
  isChat = false,
  onSend,
  readOnly = false,
  spans = [],
  spansByTurn = {},
}: WorkflowOutputPanelProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const animatedChatResponseIds = useRef(new Set<string>());
  const [presentedChatResponses, setPresentedChatResponses] = useState<
    Set<string>
  >(() => new Set());
  const duration = durationLabel(run);
  const output = run.messages.map((message) => message.content).join('\n\n');
  const displayNodeName = (nodeId: string) =>
    nodeDisplayName(run, workflowNodes, nodeId);
  const appIdentity = (nodeId: string) => {
    const app = processNodeInfo(workflowNodes, nodeId);
    if (!app) return null;
    return (
      <div className='mt-2 flex items-center gap-2 px-1 text-sm'>
        <span className='font-medium'>
          {app.appName || displayNodeName(nodeId)}
        </span>
        {app.version ? (
          <Badge className='font-mono text-xs' variant='secondary'>
            v{app.version}
          </Badge>
        ) : null}
      </div>
    );
  };
  const execution: WorkflowRunExecution[] =
    run.execution.length > 0
      ? run.execution
      : workflowTrace(run.finalState).map<WorkflowRunExecution>((entry) => ({
          ...entry,
          status: 'completed',
        }));
  const sessionSpans = isChat
    ? Object.values(spansByTurn)
        .flat()
        .reduce<RunSpan[]>(
          (all, span) => {
            if (!all.some((item) => item.id === span.id)) all.push(span);
            return all;
          },
          [...spans],
        )
    : spans;
  const liveChatResponseIds = isChat
    ? [
        ...run.messages
          .filter((item) => item.role === 'assistant')
          .map((item) => item.id),
        ...run.messages.flatMap((item) => {
          if (item.role !== 'user') return [];
          const response = chatTurnResponse(
            execution.filter((entry) => entry.turnId === item.turnId),
            item.turnId,
          );
          return response ? [response.id] : [];
        }),
      ]
    : [];

  if (isRunning) {
    // A response earns animation only while a real workflow is live. Its ID
    // is retained through the terminal event so an in-progress local
    // typewriter is never replaced by restored, complete text.
    for (const id of liveChatResponseIds)
      animatedChatResponseIds.current.add(id);
  }

  const markChatResponsePresented = useCallback((id: string) => {
    setPresentedChatResponses((current) => {
      if (current.has(id)) return current;
      return new Set(current).add(id);
    });
  }, []);

  const chatPresentationPending = isChat
    ? run.messages.some((item) => {
        if (item.role === 'assistant')
          return (
            animatedChatResponseIds.current.has(item.id) &&
            !item.isStreaming &&
            !presentedChatResponses.has(item.id)
          );
        if (item.role !== 'user') return false;
        const response = chatTurnResponse(
          execution.filter((entry) => entry.turnId === item.turnId),
          item.turnId,
        );
        return Boolean(
          response &&
          animatedChatResponseIds.current.has(response.id) &&
          !response.isStreaming &&
          !presentedChatResponses.has(response.id),
        );
      })
    : false;
  const chatIsBusy = isRunning || chatPresentationPending;

  const copyAll = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
  };

  const sendMessage = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || readOnly || chatIsBusy || !onSend) return;
    onSend({ input: content });
    setMessage('');
  };

  return (
    <>
      <DrawerHeader>
        <div className='flex items-start justify-between gap-4'>
          <div className='min-w-0'>
            <DrawerTitle>
              {isChat
                ? t('workflowEditor.output.chat')
                : t('workflowEditor.output.runOutput')}
            </DrawerTitle>
            {isChat ? (
              <ChatSessionUsage
                spans={sessionSpans}
                turnCount={
                  run.messages.filter((item) => item.role === 'user').length
                }
              />
            ) : (
              <DrawerDescription>
                {statusLabel(run, t)}
                {run.activeNodeId
                  ? ` · ${displayNodeName(run.activeNodeId)}`
                  : ''}
                {duration ? ` · ${duration}` : ''}
              </DrawerDescription>
            )}
          </div>
          {isChat && chatIsBusy ? (
            <span className='text-primary flex shrink-0 items-center gap-1.5 pt-1 text-xs'>
              <Spinner className='size-3' />
              {t('workflowEditor.output.workflowWorking')}
            </span>
          ) : null}
        </div>
      </DrawerHeader>

      <div className='flex min-h-0 flex-1 flex-col'>
        {!isChat && isRunning && (
          <div className='text-muted-foreground flex items-center gap-2 px-4 py-2 text-sm'>
            <Spinner className='size-3.5' />
            {t('workflowEditor.output.runningWorkflow')}
          </div>
        )}

        {!isChat && run.error && (
          <Alert variant='destructive' className='m-4 w-auto'>
            <CircleAlertIcon />
            <AlertTitle>{t('workflowEditor.output.workflowFailed')}</AlertTitle>
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}

        <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className='gap-4 p-4'>
                {!isChat && <RunModelUsage spans={sessionSpans} />}
                {!isChat && execution.length > 0 && (
                  <MessageScrollerItem messageId='execution-start'>
                    <div>
                      <Marker variant='separator'>
                        <MarkerIcon>
                          <CheckCircle2Icon />
                        </MarkerIcon>
                        <MarkerContent>
                          1. {t('workflowEditor.output.start')}
                        </MarkerContent>
                      </Marker>
                      <p className='text-muted-foreground mt-2 text-sm'>
                        {t('workflowEditor.output.workflowStarted')}
                      </p>
                    </div>
                  </MessageScrollerItem>
                )}
                {!isChat &&
                  execution.map((entry, index) => {
                    const log = processLog(entry);
                    const durationMs = entry.durationMs;

                    return (
                      <MessageScrollerItem
                        key={`${entry.nodeId}-${index}`}
                        messageId={`execution-${entry.nodeId}-${index}`}
                      >
                        <Marker variant='separator'>
                          <MarkerIcon>
                            {executionStatusIcon(entry.status)}
                          </MarkerIcon>
                          <MarkerContent>
                            {index + 2}. {displayNodeName(entry.nodeId)} ·{' '}
                            {entry.type}
                            {durationMs !== undefined
                              ? ` · ${durationMs}ms`
                              : ''}
                          </MarkerContent>
                        </Marker>
                        {appIdentity(entry.nodeId)}
                        <TraceResult entry={entry} spans={spans} />
                        <ExecutionOutput
                          label={t('workflowEditor.output.processOutput')}
                          log={log}
                        />
                      </MessageScrollerItem>
                    );
                  })}
                {!isChat && isRunning && (
                  <MessageScrollerItem messageId='execution-thinking'>
                    <ThinkingProcess
                      thoughts={run.thoughts}
                      isRunning={isRunning}
                      nodeName={displayNodeName}
                    />
                  </MessageScrollerItem>
                )}
                {!isChat &&
                  run.status === 'completed' &&
                  execution.length > 0 && (
                    <MessageScrollerItem messageId='execution-end'>
                      <Marker variant='separator'>
                        <MarkerIcon>
                          <CheckCircle2Icon />
                        </MarkerIcon>
                        <MarkerContent>
                          {execution.length + 2}.{' '}
                          {t('workflowEditor.output.end')}
                        </MarkerContent>
                      </Marker>
                      <p className='text-muted-foreground mt-2 text-sm'>
                        {t('workflowEditor.output.workflowCompleted')}
                      </p>
                    </MessageScrollerItem>
                  )}
                {run.messages.length === 0 &&
                (isChat || (isRunning && run.thoughts.length === 0)) ? (
                  <Empty className='border-0'>
                    <EmptyHeader>
                      <EmptyMedia variant='icon'>
                        {run.status === 'running' ? (
                          <Spinner />
                        ) : run.status === 'completed' ? (
                          <CheckCircle2Icon />
                        ) : (
                          <TerminalIcon />
                        )}
                      </EmptyMedia>
                      <EmptyTitle>
                        {run.status === 'running'
                          ? isChat
                            ? t('workflowEditor.output.thinking')
                            : t('workflowEditor.output.waitingForOutput')
                          : t('workflowEditor.output.noOutput')}
                      </EmptyTitle>
                      <EmptyDescription>
                        {isChat
                          ? t('workflowEditor.output.sendMessageToStart')
                          : t('workflowEditor.output.responsesAppearHere')}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  run.messages
                    .filter(() => isChat)
                    .map((message) => {
                      const turnExecution = execution.filter(
                        (entry) => entry.turnId === message.turnId,
                      );
                      const isCurrentTurn =
                        isRunning &&
                        message.turnId === run.messages.at(-1)?.turnId;
                      const turn = message.turnId
                        ? run.turnsById[message.turnId]
                        : undefined;
                      const turnSpans = message.turnId
                        ? (spansByTurn[message.turnId] ??
                          (isCurrentTurn ? spans : []))
                        : [];
                      const assistantResponse = chatTurnResponse(
                        turnExecution,
                        message.turnId,
                      );
                      const isResponsePresenting = Boolean(
                        assistantResponse &&
                        animatedChatResponseIds.current.has(
                          assistantResponse.id,
                        ) &&
                        !assistantResponse.isStreaming &&
                        !presentedChatResponses.has(assistantResponse.id),
                      );
                      const shouldAnimateMessage =
                        message.role === 'assistant' &&
                        (isRunning ||
                          animatedChatResponseIds.current.has(message.id));
                      const shouldAnimateResponse = Boolean(
                        assistantResponse &&
                        (isRunning ||
                          animatedChatResponseIds.current.has(
                            assistantResponse.id,
                          )),
                      );

                      return (
                        <Fragment key={message.id}>
                          <MessageScrollerItem
                            messageId={message.id}
                            // Chat intentionally anchors a newly-sent turn in
                            // the reading area. The response and receipt stay
                            // mounted below it, so the spacer contracts only
                            // as the typewriter adds visible content.
                            scrollAnchor={message.role === 'user'}
                          >
                            <ChatMessageBubble
                              message={message}
                              nodeName={displayNodeName(message.nodeId)}
                              animateResponse={shouldAnimateMessage}
                              onResponsePresentationComplete={() =>
                                markChatResponsePresented(message.id)
                              }
                            />
                          </MessageScrollerItem>
                          {message.role === 'user' ? (
                            <MessageScrollerItem
                              messageId={`${message.id}-workflow`}
                            >
                              <div className='ml-1 space-y-1 sm:ml-8'>
                                {assistantResponse ? (
                                  <ChatMessageBubble
                                    message={assistantResponse}
                                    nodeName={displayNodeName(
                                      assistantResponse.nodeId,
                                    )}
                                    animateResponse={shouldAnimateResponse}
                                    onResponsePresentationComplete={() =>
                                      markChatResponsePresented(
                                        assistantResponse.id,
                                      )
                                    }
                                  />
                                ) : null}
                                <ChatTurnReceipt
                                  turn={turn}
                                  execution={turnExecution}
                                  thoughts={run.thoughts.filter(
                                    (thought) =>
                                      thought.turnId === message.turnId,
                                  )}
                                  spans={turnSpans}
                                  nodeName={displayNodeName}
                                  isResponsePresenting={isResponsePresenting}
                                />
                              </div>
                            </MessageScrollerItem>
                          ) : null}
                        </Fragment>
                      );
                    })
                )}
                {!isChat && run.finalState && (
                  <MessageScrollerItem messageId='final-state'>
                    <Collapsible className='bg-card overflow-hidden rounded-xl border shadow-sm'>
                      <CollapsibleTrigger
                        render={
                          <Button
                            variant='ghost'
                            className='group hover:bg-muted/60 h-auto w-full justify-between rounded-none px-3 py-3'
                          />
                        }
                      >
                        <span className='flex items-center gap-2.5'>
                          <span className='bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg'>
                            <DatabaseIcon className='size-4' />
                          </span>
                          <span className='flex flex-col items-start'>
                            <span className='text-sm font-semibold'>
                              {t('workflowEditor.output.finalState')}
                            </span>
                            <span className='text-muted-foreground text-xs'>
                              {t('workflowEditor.output.finalStateDescription')}
                            </span>
                          </span>
                        </span>
                        <ChevronDownIcon className='text-muted-foreground size-4 transition-transform group-data-panel-open/button:rotate-180' />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <FinalState
                          state={run.finalState}
                          nodeDisplayName={displayNodeName}
                          execution={execution}
                        />
                      </CollapsibleContent>
                    </Collapsible>
                  </MessageScrollerItem>
                )}
                {!isChat && (
                  <RunTelemetry spans={spans} nodeName={displayNodeName} />
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      {isChat ? (
        <DrawerFooter>
          {!readOnly && run.status === 'failed' && (
            <Button
              variant='outline'
              disabled={chatIsBusy}
              onClick={onRunAgain}
            >
              <RotateCcwIcon data-icon='inline-start' />
              {rerunLabel(run.status, t)}
            </Button>
          )}
          <form className='w-full' onSubmit={sendMessage}>
            <InputGroup className='h-auto'>
              <InputGroupTextarea
                aria-label={t('workflowEditor.output.message')}
                disabled={readOnly || chatIsBusy}
                placeholder={t('workflowEditor.output.messagePlaceholder')}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <InputGroupAddon align='block-end' className='justify-between'>
                <InputGroupText>
                  {t('workflowEditor.output.sendHint')}
                </InputGroupText>
                <InputGroupButton
                  disabled={readOnly || !message.trim() || chatIsBusy}
                  size='icon-sm'
                  type='submit'
                  variant='default'
                >
                  <ArrowUpIcon />
                  <span className='sr-only'>
                    {t('workflowEditor.output.send')}
                  </span>
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </DrawerFooter>
      ) : (
        <DrawerFooter className='flex-row justify-end'>
          {!readOnly && (
            <Button variant='outline' disabled={isRunning} onClick={onRunAgain}>
              <RotateCcwIcon data-icon='inline-start' />
              {rerunLabel(run.status, t)}
            </Button>
          )}
          <Button variant='outline' disabled={!output} onClick={copyAll}>
            <ClipboardIcon data-icon='inline-start' />
            {t('workflowEditor.output.copyAll')}
          </Button>
          <Button type='button' onClick={onClose}>
            {t('workflowEditor.output.close')}
          </Button>
        </DrawerFooter>
      )}
    </>
  );
}

export { LiveWorkflowTaskOutput, WorkflowRunOutput };
