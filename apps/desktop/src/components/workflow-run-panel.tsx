import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Button,
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DialogFooter,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
  Switch,
  Textarea,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import type { Node } from '@xyflow/react';
import {
  ArchiveIcon,
  CheckIcon,
  ChevronDownIcon,
  EllipsisIcon,
  MessageSquareIcon,
  PlayIcon,
  PlusIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { ArtifactFiles } from '@/components/artifact-files';
import {
  LiveWorkflowTaskOutput,
  WorkflowRunOutput,
} from '@/components/workflow-output-panel';
import { artifactReferences, type ArtifactRef } from '@/services/artifact';
import type { RunSpan } from '@/services/run-history';
import type { ChatSession } from '@/services/workflow';
import { useWorkflowRunStore } from '@/stores';
import { workflowRunView } from '@/stores/workflow-run.store';

type RunValues = Record<
  string,
  string | boolean | ArtifactRef | ArtifactRef[] | undefined
>;

type WorkflowRunPanelProps = {
  settings: WorkflowSettings;
  nodes: Node[];
  onRun: (initialState: Record<string, unknown>) => void;
  onResume: () => void;
  readOnly?: boolean;
  onHistoricalClose?: () => void;
  spans?: RunSpan[];
  spansByTurn?: Record<string, RunSpan[]>;
  chatSessions?: ChatSession[];
  activeChatSessionId?: string;
  isRestoringChatSession?: boolean;
  workflowChangedForChatSession?: boolean;
  onRestoreChatSession?: (sessionId: string) => Promise<void>;
  onArchiveChatSession?: (sessionId: string) => Promise<boolean>;
  onNewChat?: () => void;
};

type ChatSessionGroup = 'today' | 'yesterday' | 'earlier';

function chatSessionGroup(updatedAt: string): ChatSessionGroup {
  const sessionDate = new Date(updatedAt);
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  const startOfSessionDay = new Date(
    sessionDate.getFullYear(),
    sessionDate.getMonth(),
    sessionDate.getDate(),
  );
  const daysAgo = Math.round(
    (startOfToday.getTime() - startOfSessionDay.getTime()) / 86_400_000,
  );
  if (daysAgo === 0) return 'today';
  if (daysAgo === 1) return 'yesterday';
  return 'earlier';
}

function chatSessionTitle(session?: ChatSession) {
  const title = session?.latestTurnMessage?.replace(/\s+/g, ' ').trim();
  return title?.slice(0, 72);
}

const chatMessageInput: WorkflowInput = {
  id: 'chat-message',
  key: 'input',
  label: 'Message',
  type: 'textarea',
  required: true,
  description: 'Send a message to start this workflow.',
};

function runInputs(settings: WorkflowSettings): WorkflowInput[] {
  if (settings.mode === 'task') {
    return settings.inputSchema.fields;
  }

  return [
    chatMessageInput,
    ...settings.inputSchema.fields.filter((input) => input.key !== 'input'),
  ];
}

function initialValues(settings: WorkflowSettings): RunValues {
  return Object.fromEntries(
    runInputs(settings).map(
      (input) => [input.key, input.type === 'boolean' ? false : ''] as const,
    ),
  );
}

type WorkflowRunFormProps = {
  settings: WorkflowSettings;
  isRunning: boolean;
  onClose: () => void;
  onRun: (initialState: Record<string, unknown>) => void;
  initialInput?: Record<string, unknown>;
  layout?: 'drawer' | 'dialog';
};

export function WorkflowRunForm({
  settings,
  isRunning,
  onClose,
  onRun,
  initialInput,
  layout = 'drawer',
}: WorkflowRunFormProps) {
  const { t } = useTranslation();
  const Footer = layout === 'dialog' ? DialogFooter : DrawerFooter;
  const inputs = runInputs(settings);
  const [values, setValues] = useState<RunValues>(
    () =>
      ({
        ...initialValues(settings),
        // Number controls store text until submission converts it back.
        ...Object.fromEntries(
          Object.entries(initialInput ?? {}).map(([key, value]) => [
            key,
            typeof value === 'number' ? String(value) : value,
          ]),
        ),
      }) as RunValues,
  );
  const [errors, setErrors] = useState<Set<string>>(new Set());

  const submit = (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const missing = new Set(
      inputs.flatMap((input) => {
        const value = values[input.key];
        return input.required &&
          input.type !== 'boolean' &&
          (input.type === 'file' || input.type === 'files'
            ? artifactReferences(value).length === 0
            : !(typeof value === 'string' && value.trim()))
          ? [input.key]
          : [];
      }),
    );
    if (missing.size > 0) {
      setErrors(missing);
      return;
    }

    const state = Object.fromEntries(
      inputs.flatMap((input) => {
        const value = values[input.key];
        if (input.type === 'boolean') return [[input.key, value === true]];
        if (
          value === undefined ||
          value === '' ||
          (Array.isArray(value) && value.length === 0)
        )
          return [];
        return [[input.key, input.type === 'number' ? Number(value) : value]];
      }),
    );
    onRun(state);
  };

  return (
    <form className='flex min-h-0 flex-1 flex-col' onSubmit={submit}>
      <div
        className={cn(
          'min-h-0 flex-1 overflow-y-auto',
          layout === 'dialog' ? 'px-5 py-5 sm:px-6' : 'px-4 py-4',
        )}
      >
        <FieldGroup>
          {inputs.map((input) => {
            const invalid = errors.has(input.key);
            const value = values[input.key];
            return (
              <Field key={input.id} data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={`run-input-${input.id}`}>
                  {input.label}
                </FieldLabel>
                {input.description && (
                  <FieldDescription>{input.description}</FieldDescription>
                )}
                {input.type === 'file' || input.type === 'files' ? (
                  <ArtifactFiles
                    value={value}
                    multiple={input.type === 'files'}
                    disabled={isRunning}
                    onChange={(value) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: value,
                      }))
                    }
                  />
                ) : input.type === 'textarea' ? (
                  <Textarea
                    id={`run-input-${input.id}`}
                    aria-invalid={invalid || undefined}
                    required={input.required}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: event.target.value,
                      }))
                    }
                  />
                ) : input.type === 'boolean' ? (
                  <Field orientation='horizontal'>
                    <Switch
                      id={`run-input-${input.id}`}
                      checked={value === true}
                      onCheckedChange={(checked) =>
                        setValues((current) => ({
                          ...current,
                          [input.key]: checked,
                        }))
                      }
                    />
                    <FieldContent>
                      <FieldDescription>
                        {t('workflowEditor.enabled')}
                      </FieldDescription>
                    </FieldContent>
                  </Field>
                ) : (
                  <Input
                    id={`run-input-${input.id}`}
                    type={input.type === 'number' ? 'number' : 'text'}
                    aria-invalid={invalid || undefined}
                    required={input.required}
                    value={typeof value === 'string' ? value : ''}
                    onChange={(event) =>
                      setValues((current) => ({
                        ...current,
                        [input.key]: event.target.value,
                      }))
                    }
                  />
                )}
              </Field>
            );
          })}
        </FieldGroup>
      </div>
      <Footer
        className={
          layout === 'dialog'
            ? 'bg-muted/15 border-t px-5 py-4 sm:px-6'
            : undefined
        }
      >
        <Button type='button' variant='outline' onClick={onClose}>
          {t('apps.new.cancel')}
        </Button>
        <Button type='submit' disabled={isRunning}>
          {isRunning ? (
            <Spinner data-icon='inline-start' />
          ) : (
            <PlayIcon data-icon='inline-start' />
          )}
          {t('workflows.run')}
        </Button>
      </Footer>
    </form>
  );
}

function WorkflowRunPanel({
  settings,
  nodes,
  onRun,
  onResume,
  readOnly = false,
  onHistoricalClose,
  spans,
  spansByTurn,
  chatSessions = [],
  activeChatSessionId,
  isRestoringChatSession = false,
  workflowChangedForChatSession = false,
  onRestoreChatSession,
  onArchiveChatSession,
  onNewChat,
}: WorkflowRunPanelProps) {
  const { t } = useTranslation();
  const {
    lastRunInput,
    open,
    projection,
    runStatus,
    showOutput,
    setRunPanelOpen: onOpenChange,
  } = useWorkflowRunStore(
    useShallow((state) => ({
      lastRunInput: state.lastRunInput,
      open: state.runPanelOpen,
      // Select the stable projection reference. Calling workflowRunView here
      // would create a new selector result during getSnapshot and make chat
      // mode loop before a run has even started.
      projection:
        settings.mode === 'chat' || readOnly ? state.projection : undefined,
      runStatus: state.projection.status,
      showOutput: state.showRunOutput,
      setRunPanelOpen: state.setRunPanelOpen,
    })),
  );

  const run = useMemo(
    () => (projection ? workflowRunView(projection) : undefined),
    [projection],
  );

  const isRunning = runStatus === 'running';
  const currentSession = chatSessions.find(
    (session) => session.id === activeChatSessionId,
  );
  const currentTitle =
    chatSessionTitle(currentSession) ??
    run?.messages.find((message) => message.role === 'user')?.content ??
    t('workflowEditor.settings.newChat');
  const sessionGroups = useMemo(
    () =>
      chatSessions.reduce<Record<ChatSessionGroup, ChatSession[]>>(
        (groups, session) => {
          groups[chatSessionGroup(session.updatedAt)].push(session);
          return groups;
        },
        { today: [], yesterday: [], earlier: [] },
      ),
    [chatSessions],
  );
  const [archiveCandidate, setArchiveCandidate] = useState<ChatSession>();
  const [isArchiving, setIsArchiving] = useState(false);
  const formKey = `${open}:${JSON.stringify(settings)}`;
  const runAgain = () => {
    if (runStatus === 'interrupted') {
      onResume();
      return;
    }
    if (lastRunInput) onRun(lastRunInput);
  };

  return (
    <>
      <Drawer
        open={open}
        defaultHorizontalSnapPoint='48rem'
        horizontalSnapPoints={['31rem', '48rem', '64rem', '86rem']}
        swipeDirection='right'
        onOpenChange={(open) => {
          if (!open && readOnly) onHistoricalClose?.();
          else onOpenChange(open);
        }}
      >
        <DrawerContent>
          {settings.mode === 'chat' ? (
            <>
              <div className='bg-muted/20 flex items-center justify-between border-b px-4 py-2'>
                {readOnly ? (
                  <div className='flex min-w-0 items-center gap-2 px-2 font-medium'>
                    <MessageSquareIcon className='size-4 shrink-0' />
                    <span className='truncate'>{currentTitle}</span>
                  </div>
                ) : (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant='ghost'
                          className='max-w-[min(22rem,calc(100vw-12rem))] justify-start px-2 font-medium'
                        >
                          <MessageSquareIcon data-icon='inline-start' />
                          <span className='truncate'>{currentTitle}</span>
                          <ChevronDownIcon className='text-muted-foreground ml-1 size-3.5 shrink-0' />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align='start' className='w-80 p-2'>
                      <DropdownMenuGroup>
                        <DropdownMenuLabel className='px-2 py-1.5'>
                          {t('workflowEditor.settings.conversations')}
                        </DropdownMenuLabel>
                      </DropdownMenuGroup>
                      {(['today', 'yesterday', 'earlier'] as const).map(
                        (group) =>
                          sessionGroups[group].length > 0 ? (
                            <DropdownMenuGroup key={group}>
                              <DropdownMenuLabel className='px-2 pt-3 tracking-wider uppercase'>
                                {t(`workflowEditor.settings.${group}`)}
                              </DropdownMenuLabel>
                              {sessionGroups[group].map((session) => {
                                const title =
                                  chatSessionTitle(session) ??
                                  t('workflowEditor.settings.newChat');
                                const selected =
                                  session.id === activeChatSessionId;
                                return (
                                  <DropdownMenuItem
                                    key={session.id}
                                    aria-current={selected ? 'true' : undefined}
                                    className={`group min-h-14 gap-3 rounded-lg border px-2.5 py-2 transition-none ${
                                      selected
                                        ? 'border-primary/25 bg-primary/10 data-highlighted:bg-primary/15 shadow-sm'
                                        : 'data-highlighted:bg-muted/80 border-transparent'
                                    }`}
                                    disabled={isRestoringChatSession}
                                    onClick={() =>
                                      void onRestoreChatSession?.(session.id)
                                    }
                                  >
                                    <span
                                      className={
                                        selected
                                          ? 'bg-primary text-primary-foreground flex size-5 shrink-0 items-center justify-center rounded-md shadow-sm'
                                          : 'flex size-5 shrink-0 items-center justify-center'
                                      }
                                    >
                                      {selected ? (
                                        <CheckIcon className='size-3.5' />
                                      ) : (
                                        <span
                                          className={`size-1.5 rounded-full ${session.activeRunId ? 'bg-amber-500' : 'bg-muted-foreground/35'}`}
                                        />
                                      )}
                                    </span>
                                    <span className='min-w-0 flex-1'>
                                      <span
                                        className={`block truncate text-sm ${selected ? 'font-semibold' : ''}`}
                                      >
                                        {title}
                                      </span>
                                      <span
                                        className={`block text-xs ${selected ? 'text-primary/80 font-medium' : 'text-muted-foreground'}`}
                                      >
                                        {session.activeRunId
                                          ? t('workflowEditor.running')
                                          : new Date(
                                              session.updatedAt,
                                            ).toLocaleTimeString([], {
                                              hour: '2-digit',
                                              minute: '2-digit',
                                            })}
                                      </span>
                                    </span>
                                    <Button
                                      size='icon-sm'
                                      variant='ghost'
                                      disabled={Boolean(session.activeRunId)}
                                      aria-label={t(
                                        'workflowEditor.settings.archiveChat',
                                      )}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setArchiveCandidate(session);
                                      }}
                                    >
                                      <EllipsisIcon />
                                    </Button>
                                  </DropdownMenuItem>
                                );
                              })}
                            </DropdownMenuGroup>
                          ) : null,
                      )}
                      {chatSessions.length > 0 ? (
                        <DropdownMenuSeparator />
                      ) : null}
                      <DropdownMenuItem
                        disabled={isRestoringChatSession}
                        onClick={onNewChat}
                      >
                        <PlusIcon />
                        {t('workflowEditor.settings.newChat')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
                {!readOnly ? (
                  <Button
                    size='sm'
                    disabled={isRestoringChatSession}
                    onClick={onNewChat}
                  >
                    <PlusIcon data-icon='inline-start' />
                    {t('workflowEditor.settings.newChat')}
                  </Button>
                ) : null}
              </div>
              {workflowChangedForChatSession ? (
                <p className='text-muted-foreground border-b px-4 py-2 text-xs'>
                  {t('workflowEditor.settings.sessionWorkflowFixed')}
                </p>
              ) : null}
              {run?.contextCompactionStage === 'summarizing' ? (
                <p className='text-muted-foreground border-b px-4 py-2 text-xs'>
                  {t('workflowEditor.settings.contextCompressing')}
                </p>
              ) : run?.contextCompactionStage === 'failed' ? (
                <p className='text-muted-foreground border-b px-4 py-2 text-xs'>
                  {t('workflowEditor.settings.contextCompressionFallback')}
                </p>
              ) : currentSession?.summaryStatus === 'ready' ? (
                <p className='text-muted-foreground border-b px-4 py-2 text-xs'>
                  {t('workflowEditor.settings.contextCompressed', {
                    count: currentSession.summaryThroughSequence + 1,
                  })}
                </p>
              ) : currentSession?.summaryStatus === 'failed' ? (
                <p className='text-muted-foreground border-b px-4 py-2 text-xs'>
                  {t('workflowEditor.settings.contextCompressionFallback')}
                </p>
              ) : null}
              <WorkflowRunOutput
                run={run!}
                workflowNodes={nodes}
                isRunning={isRunning}
                isChat
                fileInputs={settings.inputSchema.fields.filter(
                  (field) => field.type === 'file' || field.type === 'files',
                )}
                readOnly={readOnly}
                onRunAgain={runAgain}
                onSend={onRun}
                onClose={() =>
                  readOnly ? onHistoricalClose?.() : onOpenChange(false)
                }
                spans={spans}
                spansByTurn={spansByTurn}
              />
            </>
          ) : showOutput ? (
            readOnly ? (
              <WorkflowRunOutput
                run={run!}
                workflowNodes={nodes}
                isRunning={isRunning}
                readOnly={readOnly}
                onRunAgain={runAgain}
                onClose={() =>
                  readOnly ? onHistoricalClose?.() : onOpenChange(false)
                }
                spans={spans}
              />
            ) : (
              <LiveWorkflowTaskOutput
                workflowNodes={nodes}
                readOnly={readOnly}
                onRunAgain={runAgain}
                onClose={() => onOpenChange(false)}
                spans={spans}
              />
            )
          ) : (
            <>
              <DrawerHeader>
                <DrawerTitle>{t('workflowEditor.testRun')}</DrawerTitle>
                <DrawerDescription>
                  {t('workflowEditor.testRunDescription')}
                </DrawerDescription>
              </DrawerHeader>
              <WorkflowRunForm
                key={formKey}
                settings={settings}
                isRunning={isRunning}
                onClose={() => onOpenChange(false)}
                onRun={onRun}
              />
            </>
          )}
        </DrawerContent>
      </Drawer>
      <AlertDialog
        open={Boolean(archiveCandidate)}
        onOpenChange={(open) => {
          if (!open) setArchiveCandidate(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia>
              <ArchiveIcon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('workflowEditor.settings.archiveChatTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workflowEditor.settings.archiveChatDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('apps.new.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isArchiving}
              onClick={async (event) => {
                event.preventDefault();
                if (!archiveCandidate || !onArchiveChatSession) return;
                setIsArchiving(true);
                await onArchiveChatSession(archiveCandidate.id);
                setIsArchiving(false);
                // Keep the list intact on failure, but do not trap the user
                // in a confirmation dialog after the error toast explains it.
                setArchiveCandidate(undefined);
              }}
            >
              {t('workflowEditor.settings.archiveChat')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { WorkflowRunPanel };
