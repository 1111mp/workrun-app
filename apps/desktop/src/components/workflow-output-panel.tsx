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
import {
  ArrowUpIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleAlertIcon,
  CircleIcon,
  ClipboardIcon,
  RotateCcwIcon,
  TerminalIcon,
} from 'lucide-react';
import { Children, Fragment, type ReactNode, useState } from 'react';
import Markdown from 'react-markdown';

import { WorkflowCodeBlock } from '@/components/workflow-code-block';
import type {
  WorkflowRunExecution,
  WorkflowRunView,
} from '@/services/workflow';

type WorkflowOutputPanelProps = {
  run: WorkflowRunView;
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

function durationLabel(run: WorkflowRunView) {
  if (!run.startedAt) return undefined;
  const end = run.endedAt ?? Date.now();
  return `${((end - run.startedAt) / 1000).toFixed(1)}s`;
}

function nodeDisplayName(run: WorkflowRunView, nodeId: string) {
  return run.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
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
  const trace = finalState?.['workflow.trace'];
  if (!Array.isArray(trace)) return [];

  return trace.filter(
    (entry): entry is WorkflowTraceEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).nodeId === 'string' &&
      typeof (entry as Record<string, unknown>).type === 'string',
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

function TraceResult({
  entry,
  showAgentResponse = true,
}: {
  entry: WorkflowTraceEntry;
  showAgentResponse?: boolean;
}) {
  if (entry.type === 'if_else') {
    const result =
      typeof entry.result === 'object' && entry.result !== null
        ? (entry.result as Record<string, unknown>)
        : undefined;
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
    const result =
      typeof entry.result === 'object' && entry.result !== null
        ? (entry.result as Record<string, unknown>)
        : undefined;
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
    if (!showAgentResponse) {
      return (
        <p className='text-muted-foreground mt-2 text-sm'>
          {entry.status === 'running'
            ? 'Generating response…'
            : 'Response ready.'}
        </p>
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

    return responses.length > 0 ? (
      <div className='border-primary/25 mt-2 space-y-2 border-l-2 pl-3'>
        {responses.map((response, index) => (
          <div key={index} className='text-sm leading-6'>
            <Markdown>{response}</Markdown>
          </div>
        ))}
      </div>
    ) : (
      <p className='text-muted-foreground mt-2 text-sm'>
        {entry.status === 'running'
          ? 'Waiting for a response…'
          : 'Completed without a text response.'}
      </p>
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
  isRunning,
  onRunAgain,
  onClose,
  isChat = false,
  onSend,
}: WorkflowOutputPanelProps) {
  const [message, setMessage] = useState('');
  const duration = durationLabel(run);
  const output = run.messages.map((message) => message.content).join('\n\n');
  const displayNodeName = (nodeId: string) => nodeDisplayName(run, nodeId);
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

  const sendMessage = (event: React.FormEvent<HTMLFormElement>) => {
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
                        {log && (
                          <div className='mt-3'>
                            <p className='text-muted-foreground mb-1 text-xs font-medium'>
                              Process output
                            </p>
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
                        )}
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
                            <Message
                              align={message.role === 'user' ? 'end' : 'start'}
                            >
                              <MessageContent>
                                {message.role !== 'user' && (
                                  <MessageHeader>
                                    {displayNodeName(message.nodeId)}
                                  </MessageHeader>
                                )}
                                <Bubble
                                  align={
                                    message.role === 'user' ? 'end' : 'start'
                                  }
                                  variant={
                                    message.role === 'user'
                                      ? 'secondary'
                                      : 'ghost'
                                  }
                                >
                                  <BubbleContent>
                                    <Markdown
                                      components={{
                                        a: ({ children, ...props }) => (
                                          <a
                                            {...props}
                                            className='text-primary underline underline-offset-3'
                                            target='_blank'
                                            rel='noreferrer'
                                          >
                                            {children}
                                          </a>
                                        ),
                                        blockquote: ({ children }) => (
                                          <blockquote className='text-muted-foreground border-border border-l pl-3'>
                                            {children}
                                          </blockquote>
                                        ),
                                        code: ({ children, className }) =>
                                          className ? (
                                            <WorkflowCodeBlock
                                              className={className}
                                              code={codeText(children)}
                                            />
                                          ) : (
                                            <code className='bg-muted rounded px-1 py-0.5'>
                                              {children}
                                            </code>
                                          ),
                                        h1: ({ children }) => (
                                          <h1 className='text-base font-semibold'>
                                            {children}
                                          </h1>
                                        ),
                                        h2: ({ children }) => (
                                          <h2 className='text-sm font-semibold'>
                                            {children}
                                          </h2>
                                        ),
                                        li: ({ children }) => (
                                          <li className='leading-6'>
                                            {children}
                                          </li>
                                        ),
                                        ol: ({ children }) => (
                                          <ol className='list-decimal pl-5'>
                                            {children}
                                          </ol>
                                        ),
                                        p: ({ children }) => (
                                          <p className='leading-6'>
                                            {children}
                                          </p>
                                        ),
                                        pre: ({ children }) => (
                                          <pre className='bg-background border-border overflow-x-auto rounded-md border p-3'>
                                            {children}
                                          </pre>
                                        ),
                                        ul: ({ children }) => (
                                          <ul className='list-disc pl-5'>
                                            {children}
                                          </ul>
                                        ),
                                      }}
                                    >
                                      {message.content}
                                    </Markdown>
                                  </BubbleContent>
                                </Bubble>
                                {message.isStreaming && (
                                  <span className='text-muted-foreground flex items-center gap-1 px-3 text-xs'>
                                    <Spinner /> Streaming
                                  </span>
                                )}
                              </MessageContent>
                            </Message>
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
                                  {log && (
                                    <div className='mt-3'>
                                      <p className='text-muted-foreground mb-1 text-xs font-medium'>
                                        Process output
                                      </p>
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
                                  )}
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
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        {!isChat && run.finalState && (
          <Collapsible className='border-border border-t px-4 py-2'>
            <CollapsibleTrigger
              render={<Button variant='ghost' className='w-full' />}
            >
              <Marker>
                <MarkerContent>Final state</MarkerContent>
              </Marker>
              <ChevronDownIcon className='ml-auto group-data-panel-open/button:rotate-180' />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <pre className='bg-muted mt-3 max-h-52 overflow-auto rounded-md p-3 text-xs'>
                {JSON.stringify(run.finalState, null, 2)}
              </pre>
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>

      {isChat ? (
        <DrawerFooter>
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
            Run again
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
