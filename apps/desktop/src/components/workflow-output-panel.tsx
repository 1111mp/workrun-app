import { LazyLog } from '@melloware/react-logviewer';
import {
  Alert,
  AlertDescription,
  AlertTitle,
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
  ClipboardIcon,
  DatabaseIcon,
  Globe2Icon,
  Layers3Icon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-react';
import { Children, Fragment, type ReactNode, useState } from 'react';
import Markdown from 'react-markdown';

import { WorkflowCodeBlock } from '@/components/workflow-code-block';
import type {
  WorkflowRunExecution,
  WorkflowRunMessage,
  WorkflowRunView,
} from '@/services/workflow';

type WorkflowOutputPanelProps = {
  run: WorkflowRunView;
  workflowNodes: Node[];
  isRunning: boolean;
  onRunAgain: () => void;
  onClose: () => void;
  isChat?: boolean;
  onSend?: (initialState: Record<string, unknown>) => void;
};

function statusLabel(status: WorkflowRunView['status']) {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    default:
      return 'Waiting to run';
  }
}

function rerunLabel(status: WorkflowRunView['status']) {
  if (status === 'interrupted') return 'Resume';
  if (status === 'failed') return 'Retry';
  return 'Run again';
}

function durationLabel(run: WorkflowRunView) {
  if (!run.startedAt) return undefined;
  const end = run.endedAt ?? Date.now();
  return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
}

function nodeDisplayName(
  run: WorkflowRunView,
  workflowNodes: Node[],
  nodeId: string,
) {
  const name = run.nodes.find((node) => node.id === nodeId)?.name;
  if (name) return name;

  const node = workflowNodes.find((node) => node.id === nodeId);
  const data = node?.data;
  if (typeof data?.workflowName === 'string' && data.workflowName.trim())
    return data.workflowName;
  if (typeof data?.name === 'string' && data.name.trim()) return data.name;
  if (typeof data?.label === 'string' && data.label.trim()) return data.label;
  if (typeof data?.title === 'string' && data.title.trim()) return data.title;
  return 'Unknown node';
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

function ToolCalls({ calls }: { calls: unknown[] }) {
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
}

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

function TraceResult({
  entry,
  showAgentResponse = true,
}: {
  entry: WorkflowTraceEntry;
  showAgentResponse?: boolean;
}) {
  const result =
    typeof entry.result === 'object' && entry.result !== null
      ? (entry.result as Record<string, unknown>)
      : undefined;

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
        {responses.length > 0 ? (
          <div className='border-primary/25 mt-2 space-y-2 border-l-2 pl-3'>
            {responses.map((response, index) => (
              <div key={index} className='text-sm leading-6'>
                <MarkdownContent
                  content={response}
                  isStreaming={entry.status === 'running'}
                />
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

function ChatMessageBubble({
  message,
  nodeName,
}: {
  message: WorkflowRunMessage;
  nodeName: string;
}) {
  const isUser = message.role === 'user';

  return (
    <Message align={isUser ? 'end' : 'start'}>
      <MessageContent>
        {!isUser && <MessageHeader>{nodeName}</MessageHeader>}
        <Bubble
          align={isUser ? 'end' : 'start'}
          variant={isUser ? 'secondary' : 'ghost'}
        >
          <BubbleContent>
            <MarkdownContent
              content={message.content}
              isStreaming={message.isStreaming}
            />
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
  if (thoughts.length === 0 && !isRunning) return null;

  const completed = thoughts.filter(
    (thought) => thought.status === 'completed',
  ).length;
  const label = isRunning
    ? completed > 0
      ? `Thinking · ${completed} step${completed === 1 ? '' : 's'} complete`
      : 'Thinking…'
    : `Thought process · ${completed} step${completed === 1 ? '' : 's'}`;

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
                {thought.status === 'running' ? 'Working in' : 'Finished'}{' '}
                {nodeName(thought.nodeId)}
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

function WorkflowRunOutput({
  run,
  workflowNodes,
  isRunning,
  onRunAgain,
  onClose,
  isChat = false,
  onSend,
}: WorkflowOutputPanelProps) {
  const [message, setMessage] = useState('');
  const duration = durationLabel(run);
  const output = run.messages.map((message) => message.content).join('\n\n');
  const displayNodeName = (nodeId: string) =>
    nodeDisplayName(run, workflowNodes, nodeId);
  const execution: WorkflowRunExecution[] =
    run.execution.length > 0
      ? run.execution
      : workflowTrace(run.finalState).map<WorkflowRunExecution>((entry) => ({
          ...entry,
          status: 'completed',
        }));

  const copyAll = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
  };

  const sendMessage = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || isRunning || !onSend) return;
    onSend({ input: content });
    setMessage('');
  };

  return (
    <>
      <DrawerHeader>
        <DrawerTitle>{isChat ? 'Chat' : 'Run output'}</DrawerTitle>
        <DrawerDescription>
          {statusLabel(run.status)}
          {run.activeNodeId ? ` · ${displayNodeName(run.activeNodeId)}` : ''}
          {duration ? ` · ${duration}` : ''}
        </DrawerDescription>
      </DrawerHeader>

      <div className='flex min-h-0 flex-1 flex-col'>
        {!isChat && isRunning && (
          <div className='text-muted-foreground flex items-center gap-2 px-4 py-2 text-sm'>
            <Spinner className='size-3.5' />
            Running workflow…
          </div>
        )}

        {run.error && (
          <Alert variant='destructive' className='m-4 w-auto'>
            <CircleAlertIcon />
            <AlertTitle>Workflow failed</AlertTitle>
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}

        <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className='gap-4 p-4'>
                {!isChat && execution.length > 0 && (
                  <MessageScrollerItem messageId='execution-start'>
                    <div>
                      <Marker variant='separator'>
                        <MarkerIcon>
                          <CheckCircle2Icon />
                        </MarkerIcon>
                        <MarkerContent>1. Start</MarkerContent>
                      </Marker>
                      <p className='text-muted-foreground mt-2 text-sm'>
                        Workflow started.
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
                            <CheckCircle2Icon />
                          </MarkerIcon>
                          <MarkerContent>
                            {index + 2}. {displayNodeName(entry.nodeId)} ·{' '}
                            {entry.type}
                            {durationMs !== undefined
                              ? ` · ${durationMs}ms`
                              : ''}
                          </MarkerContent>
                        </Marker>
                        <TraceResult entry={entry} />
                        <ExecutionOutput label='Process output' log={log} />
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
                          {execution.length + 2}. End
                        </MarkerContent>
                      </Marker>
                      <p className='text-muted-foreground mt-2 text-sm'>
                        Workflow completed.
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
                            ? 'Thinking…'
                            : 'Waiting for output'
                          : 'No output was produced'}
                      </EmptyTitle>
                      <EmptyDescription>
                        {isChat
                          ? 'Send a message to start this workflow.'
                          : 'Model responses will appear here as they stream.'}
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

                      return (
                        <Fragment key={message.id}>
                          <MessageScrollerItem
                            messageId={message.id}
                            scrollAnchor={message.role === 'user'}
                          >
                            <ChatMessageBubble
                              message={message}
                              nodeName={displayNodeName(message.nodeId)}
                            />
                          </MessageScrollerItem>
                          {message.role === 'user' &&
                            turnExecution.map((entry, index) => {
                              const log = processLog(entry);

                              return (
                                <MessageScrollerItem
                                  key={`${entry.nodeId}-${index}`}
                                  messageId={`chat-${message.id}-execution-${index}`}
                                >
                                  <Marker variant='separator'>
                                    <MarkerIcon>
                                      {entry.status === 'running' ? (
                                        <Spinner />
                                      ) : entry.status === 'failed' ? (
                                        <CircleAlertIcon />
                                      ) : (
                                        <CheckCircle2Icon />
                                      )}
                                    </MarkerIcon>
                                    <MarkerContent>
                                      {displayNodeName(entry.nodeId)} ·{' '}
                                      {entry.type}
                                      {entry.durationMs !== undefined
                                        ? ` · ${entry.durationMs}ms`
                                        : ''}
                                    </MarkerContent>
                                  </Marker>
                                  <TraceResult
                                    entry={entry}
                                    showAgentResponse={false}
                                  />
                                  <ExecutionOutput
                                    label='Process output'
                                    log={log}
                                  />
                                </MessageScrollerItem>
                              );
                            })}
                          {message.role === 'user' &&
                            turnExecution.length === 0 && (
                              <MessageScrollerItem
                                messageId={`${message.id}-thinking`}
                              >
                                <ThinkingProcess
                                  thoughts={run.thoughts.filter(
                                    (thought) =>
                                      thought.turnId === message.turnId,
                                  )}
                                  isRunning={isCurrentTurn}
                                  nodeName={displayNodeName}
                                />
                              </MessageScrollerItem>
                            )}
                        </Fragment>
                      );
                    })
                )}
                {run.finalState && (
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
                              Final state
                            </span>
                            <span className='text-muted-foreground text-xs'>
                              Workflow data at completion
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
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>
      </div>

      {isChat ? (
        <DrawerFooter>
          {(run.status === 'interrupted' || run.status === 'failed') && (
            <Button variant='outline' disabled={isRunning} onClick={onRunAgain}>
              <RotateCcwIcon data-icon='inline-start' />
              {rerunLabel(run.status)}
            </Button>
          )}
          <form className='w-full' onSubmit={sendMessage}>
            <InputGroup className='h-auto'>
              <InputGroupTextarea
                aria-label='Message'
                disabled={isRunning}
                placeholder='What are we working on today?'
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
                  Enter to send · Shift+Enter for new line
                </InputGroupText>
                <InputGroupButton
                  disabled={!message.trim() || isRunning}
                  size='icon-sm'
                  type='submit'
                  variant='default'
                >
                  <ArrowUpIcon />
                  <span className='sr-only'>Send</span>
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </DrawerFooter>
      ) : (
        <DrawerFooter className='flex-row justify-end'>
          <Button variant='outline' disabled={isRunning} onClick={onRunAgain}>
            <RotateCcwIcon data-icon='inline-start' />
            {rerunLabel(run.status)}
          </Button>
          <Button variant='outline' disabled={!output} onClick={copyAll}>
            <ClipboardIcon data-icon='inline-start' />
            Copy all
          </Button>
          <Button type='button' onClick={onClose}>
            Close
          </Button>
        </DrawerFooter>
      )}
    </>
  );
}

export { WorkflowRunOutput };
