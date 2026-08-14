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
import type { WorkflowRunView } from '@/services/workflow';

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
        {!isChat && run.nodes.length > 0 && (
          <div className='text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 px-4 py-2 text-xs'>
            {run.nodes.map((node) => (
              <span key={node.id}>
                {node.status === 'running'
                  ? 'Running'
                  : node.status === 'failed'
                    ? 'Failed'
                    : 'Finished'}{' '}
                {node.name ?? node.id}
                {node.durationMs !== undefined ? ` (${node.durationMs}ms)` : ''}
              </span>
            ))}
          </div>
        )}

        {run.error && (
          <Alert variant='destructive' className='m-4 w-auto'>
            <CircleAlertIcon />
            <AlertTitle>Workflow failed</AlertTitle>
            <AlertDescription>{run.error}</AlertDescription>
          </Alert>
        )}

        {run.processLogs.length > 0 && (
          <div className='space-y-2 px-4 py-2'>
            {run.processLogs.map((log) => (
              <Collapsible key={log.nodeId}>
                <CollapsibleTrigger
                  render={
                    <Button variant='ghost' className='w-full justify-start' />
                  }
                >
                  <TerminalIcon />
                  {log.name} logs
                  <ChevronDownIcon className='ml-auto group-data-panel-open/button:rotate-180' />
                </CollapsibleTrigger>
                <CollapsibleContent className='bg-muted h-52 overflow-hidden rounded-md'>
                  <LazyLog
                    text={`${log.stdout}${log.stderr ? `${log.stdout ? '\n' : ''}stderr\n${log.stderr}` : ''}`}
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
                </CollapsibleContent>
              </Collapsible>
            ))}
          </div>
        )}

        <MessageScrollerProvider autoScroll scrollPreviousItemPeek={64}>
          <MessageScroller>
            <MessageScrollerViewport>
              <MessageScrollerContent className='gap-4 p-4'>
                {run.messages.length === 0 ? (
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
                  run.messages.map((message, index) => (
                    <Fragment key={message.id}>
                      <MessageScrollerItem
                        messageId={message.id}
                        scrollAnchor={
                          isChat
                            ? message.role === 'user'
                            : index === run.messages.length - 1
                        }
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
                              align={message.role === 'user' ? 'end' : 'start'}
                              variant={
                                message.role === 'user' ? 'secondary' : 'ghost'
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
                                      <li className='leading-6'>{children}</li>
                                    ),
                                    ol: ({ children }) => (
                                      <ol className='list-decimal pl-5'>
                                        {children}
                                      </ol>
                                    ),
                                    p: ({ children }) => (
                                      <p className='leading-6'>{children}</p>
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
                      {isChat && message.role === 'user' && (
                        <MessageScrollerItem
                          messageId={`${message.id}-thinking`}
                        >
                          <ThinkingProcess
                            thoughts={run.thoughts.filter(
                              (thought) => thought.turnId === message.turnId,
                            )}
                            isRunning={
                              isRunning &&
                              message.turnId === run.messages.at(-1)?.turnId
                            }
                            nodeName={displayNodeName}
                          />
                        </MessageScrollerItem>
                      )}
                    </Fragment>
                  ))
                )}

                {!isChat && run.finalState && (
                  <MessageScrollerItem messageId='final-state'>
                    <Collapsible defaultOpen={false}>
                      <CollapsibleTrigger render={<Button variant='ghost' />}>
                        <Marker>
                          <MarkerContent>Final state</MarkerContent>
                        </Marker>
                        <ChevronDownIcon className='ml-auto group-data-panel-open/button:rotate-180' />
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <pre className='bg-muted mt-3 overflow-x-auto rounded-md p-3 text-xs'>
                          {JSON.stringify(run.finalState, null, 2)}
                        </pre>
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
