import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Bubble,
  BubbleContent,
  Button,
  Message,
  MessageContent,
  MessageFooter,
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { RefreshCcwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { ArtifactFiles } from '@/components/artifact-files';
import { WorkflowChatComposer } from '@/components/workflow-chat-composer';
import { WorkflowRunForm } from '@/components/workflow-run-panel';
import { artifactReferences, type ArtifactRef } from '@/services/artifact';
import type { AssistantMessage } from '@/services/assistant';
import { getModelCatalog } from '@/services/cmd';
import { useWorkrunStore } from '@/stores';
import {
  createAssistantSession,
  decideAssistantPlan,
  decideAssistantTool,
  declineAssistantWorkflow,
  loadAssistantSession,
  provideAssistantInputs,
  resumeAssistant,
  sendAssistantMessage,
  setAssistantFeedback,
  setAssistantModel,
  useAssistantStore,
} from '@/stores/assistant.store';

import { AssistantMessageActions } from './assistant-message-actions';
import { AssistantMessageText } from './assistant-message-text';
import { AssistantToolConfirmationCard } from './assistant-tool-confirmation';
import { groupAssistantMessages } from './assistant-turn';
import { AssistantTurnThinking } from './assistant-turn-activity';
import { AssistantWorkflowPlan } from './assistant-workflow-plan';
import { AssistantWorkflowRun } from './assistant-workflow-run';

function StartPage() {
  const scope = useEntryWorkspace();
  const location = useLocation();
  return <AssistantChat key={`${scope}:${location.key}`} scope={scope} />;
}

const attachmentsField: WorkflowInput = {
  id: 'attachments',
  key: 'attachments',
  type: 'files',
  required: false,
  label: 'Files',
};

function AssistantChat({ scope }: { scope: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const id = params.get('session') ?? undefined;
  const client = useQueryClient();
  const config = useWorkrunStore((state) => state.config);
  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<ArtifactRef[]>([]);
  const [chosenModel, setChosenModel] = useState('');
  const [creating, setCreating] = useState(false);
  const submitting = useRef(false);
  const cached = useAssistantStore((state) =>
    id && state.scopes[id] === scope ? state.sessions[id] : undefined,
  );
  const stream = useAssistantStore((state) =>
    id && state.scopes[id] === scope ? state.streams[id] : undefined,
  );
  const restored = useQuery({
    queryKey: ['assistant-session', scope, id],
    queryFn: () => loadAssistantSession(id!, scope),
    enabled: Boolean(id),
    retry: false,
  });
  const session = cached ?? restored.data;
  const messages: AssistantMessage[] = (session?.messages ?? []).map(
    (message) => ({ ...message }),
  );
  if (stream && !messages.some((message) => message.id === stream.messageId)) {
    messages.push({
      id: stream.messageId,
      role: 'assistant',
      text: stream.text,
      content: { role: 'model', parts: [] },
    });
  }

  // A run keeps its presentation identity when the pending call becomes a
  // durable tool receipt, preserving expansion and the inner scroll position.
  if (session?.activeCall?.runId) {
    messages.push({
      id: `workflow-run-${session.activeCall.runId}`,
      role: 'tool',
      text: 'running',
      runId: session.activeCall.runId,
      workflowName: session.activeCall.workflow.document.settings.name,
      content: { role: 'function', parts: [] },
    });
  }
  for (const message of messages) {
    if (message.role === 'tool' && message.runId)
      message.id = `workflow-run-${message.runId}`;
  }

  const groups = groupAssistantMessages(messages, [
    ...(session?.workflowPlans ?? []).map((entry) => entry.turnId),
    ...(session?.toolConfirmations ?? []).map((entry) => entry.turnId),
  ]);
  const latestMessageId = messages.at(-1)?.id;
  const latestUserId = [...messages]
    .reverse()
    .find((message) => message.role === 'user')?.id;
  if (
    latestUserId &&
    (session?.status === 'thinking' ||
      session?.activities?.some((item) => item.turnId === latestUserId) ||
      session?.workflowPlans?.some((entry) => entry.turnId === latestUserId) ||
      session?.toolConfirmations?.some(
        (entry) => entry.turnId === latestUserId,
      )) &&
    !groups.some(
      (group) => group.role === 'assistant' && group.turnId === latestUserId,
    )
  ) {
    groups.push({
      id: `reply-${latestUserId}`,
      turnId: latestUserId,
      role: 'assistant',
      messages: [],
      progress: [],
    });
  }
  const models = useQuery({
    queryKey: ['model-catalog'],
    queryFn: getModelCatalog,
  });
  const modelId =
    chosenModel ||
    session?.modelId ||
    config?.summary_model_profile_id ||
    models.data?.find(
      (model) =>
        model.provider === 'ollama' ||
        config?.provider_credentials?.some(
          (credential) =>
            credential.provider === model.provider && credential.apiKey,
        ),
    )?.id ||
    '';
  const busy =
    creating || session?.status === 'thinking' || session?.status === 'running';
  const active = session?.activeCall;

  useEffect(() => {
    void client.invalidateQueries({ queryKey: ['assistant-sessions'] });
  }, [client, session?.id, session?.messages.length]);

  const submit = async () => {
    if (
      submitting.current ||
      busy ||
      active ||
      (!draft.trim() && !files.length) ||
      !modelId
    )
      return;
    submitting.current = true;
    setCreating(true);
    try {
      const current =
        session ??
        (await createAssistantSession(
          modelId,
          draft.trim() || t('assistant.fileTask'),
          scope,
        ));
      if (current.modelId !== modelId)
        await setAssistantModel(current.id, modelId, scope);
      const text = draft.trim();
      const attachments = files;
      setDraft('');
      setFiles([]);
      void sendAssistantMessage(current.id, text, scope, attachments);
      if (!id)
        await navigate(
          `/start?${new URLSearchParams({ session: current.id })}`,
        );
    } catch (error) {
      toast.error(String(error), { toasterId: 'global' });
    } finally {
      setCreating(false);
      submitting.current = false;
    }
  };

  return (
    <div className='@container flex h-full min-h-0 flex-col'>
      {restored.isError && (
        <Alert variant='destructive'>
          <AlertTitle>{t('assistant.loadFailed')}</AlertTitle>
          <AlertDescription>
            {String(restored.error)}
            <Button
              variant='outline'
              size='sm'
              onClick={() => void restored.refetch()}
            >
              {t('assistant.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!session?.messages.length ? (
        <div className='mx-auto flex w-full max-w-[clamp(48rem,72cqw,76rem)] flex-1 flex-col justify-center gap-6 px-6 pb-10'>
          <div className='text-center'>
            <h1 className='text-3xl font-medium tracking-tight sm:text-4xl'>
              {t('start.title')}
            </h1>
            <p className='text-muted-foreground mt-3 text-sm'>
              {t('assistant.subtitle')}
            </p>
          </div>
          {id && restored.isPending ? <Spinner /> : renderComposer()}
        </div>
      ) : (
        <>
          <div className='min-h-0 flex-1'>
            <MessageScrollerProvider autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  <MessageScrollerContent className='mx-auto w-full max-w-[clamp(56rem,80cqw,84rem)] px-6 py-5'>
                    {groups.map((group) => (
                      <MessageScrollerItem
                        key={group.id}
                        messageId={group.id}
                        scrollAnchor={group.role === 'user'}
                      >
                        <Message
                          align={group.role === 'user' ? 'end' : 'start'}
                        >
                          <MessageContent>
                            {group.role === 'assistant' && (
                              <AssistantTurnThinking
                                session={session}
                                turnId={group.turnId}
                                busy={Boolean(
                                  session.status === 'thinking' &&
                                  !session.activeCall &&
                                  (!stream?.text ||
                                    session.reasoning?.some(
                                      (item) =>
                                        item.phaseId ===
                                          session.responsePhaseId &&
                                        !item.complete,
                                    )) &&
                                  group.turnId === latestUserId,
                                )}
                              />
                            )}
                            {group.role === 'assistant' &&
                              session.workflowPlans
                                ?.filter(
                                  (entry) => entry.turnId === group.turnId,
                                )
                                .map((entry) => (
                                  <div
                                    key={`${entry.plan.id}-${entry.plan.version}`}
                                  >
                                    <AssistantWorkflowPlan
                                      plan={entry.plan}
                                      busy={Boolean(busy)}
                                      active={
                                        entry ===
                                          session.workflowPlans?.at(-1) &&
                                        entry.plan.status ===
                                          session.workflowPlan?.status
                                      }
                                      onDecide={(decision) =>
                                        void decideAssistantPlan(
                                          session.id,
                                          entry.plan.id,
                                          entry.plan.version,
                                          decision,
                                          t(
                                            decision === 'approve'
                                              ? 'assistant.plan.approveMessage'
                                              : 'assistant.plan.cancelMessage',
                                            { version: entry.plan.version },
                                          ),
                                          scope,
                                        ).catch(() =>
                                          toast.error(
                                            t('assistant.plan.decisionFailed'),
                                            { toasterId: 'global' },
                                          ),
                                        )
                                      }
                                      onDiscuss={(question) => {
                                        // Keep an unfinished reply when the user selects another question.
                                        setDraft((current) =>
                                          current.trim()
                                            ? current
                                            : question
                                              ? t(
                                                  'assistant.plan.answerPrompt',
                                                  {
                                                    version: entry.plan.version,
                                                    question,
                                                  },
                                                )
                                              : t('assistant.plan.editPrompt'),
                                        );
                                        document
                                          .querySelector<HTMLTextAreaElement>(
                                            'textarea',
                                          )
                                          ?.focus();
                                      }}
                                    />
                                  </div>
                                ))}
                            {group.role === 'assistant' &&
                              session.toolConfirmations
                                ?.filter(
                                  (entry) => entry.turnId === group.turnId,
                                )
                                .map((entry) => {
                                  const active =
                                    session.pendingTool?.id === entry.id;
                                  const confirmation = active
                                    ? session.pendingTool!
                                    : entry;
                                  return (
                                    <AssistantToolConfirmationCard
                                      key={entry.id}
                                      confirmation={confirmation}
                                      active={active}
                                      busy={Boolean(busy)}
                                      onDecide={(decision) =>
                                        void decideAssistantTool(
                                          session.id,
                                          confirmation,
                                          decision,
                                          t(
                                            decision === 'approve'
                                              ? 'assistant.toolConfirmation.approveMessage'
                                              : 'assistant.toolConfirmation.denyMessage',
                                            {
                                              tool: confirmation.tool
                                                .displayName,
                                            },
                                          ),
                                          scope,
                                        ).catch(() =>
                                          toast.error(
                                            t(
                                              'assistant.toolConfirmation.failed',
                                            ),
                                            { toasterId: 'global' },
                                          ),
                                        )
                                      }
                                    />
                                  );
                                })}
                            {group.messages.map((message) => (
                              <div
                                key={message.id}
                                className={cn(
                                  'min-w-0',
                                  group.role === 'user' &&
                                    'flex flex-col items-end gap-2',
                                )}
                              >
                                {message.role === 'user' &&
                                  Boolean(message.artifacts?.length) && (
                                    <ArtifactFiles
                                      compact
                                      hidePicker
                                      value={message.artifacts}
                                      multiple
                                    />
                                  )}
                                {message.role === 'tool' ? (
                                  message.runId ? (
                                    <AssistantWorkflowRun
                                      runId={message.runId}
                                      name={message.workflowName}
                                      status={message.text}
                                      scope={scope}
                                    />
                                  ) : (
                                    <span className='text-muted-foreground text-sm'>
                                      {message.workflowName ?? message.toolName}{' '}
                                      ·{' '}
                                      {t(`runs.runStatus.${message.text}`, {
                                        defaultValue: message.text,
                                      })}
                                    </span>
                                  )
                                ) : (
                                  <Bubble
                                    variant={
                                      message.role === 'user'
                                        ? 'secondary'
                                        : 'ghost'
                                    }
                                  >
                                    <BubbleContent>
                                      <AssistantMessageText
                                        text={
                                          message.notice ===
                                          'plan_confirmation_required'
                                            ? t(
                                                'assistant.plan.confirmationRequired',
                                              )
                                            : message.text
                                        }
                                        animate={
                                          message.id === stream?.messageId
                                        }
                                      />
                                    </BubbleContent>
                                  </Bubble>
                                )}
                                {message.role !== 'user' &&
                                  Boolean(message.artifacts?.length) && (
                                    <ArtifactFiles
                                      compact
                                      hidePicker
                                      value={message.artifacts}
                                      multiple
                                    />
                                  )}
                                {message.role !== 'tool' &&
                                  message.text &&
                                  message.id !== stream?.messageId && (
                                    <MessageFooter
                                      className={cn(
                                        'gap-2 pt-1 transition-opacity motion-reduce:transition-none',
                                        message.id !== latestMessageId &&
                                          '[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/message:opacity-100 [@media(hover:hover)]:group-focus-within/message:opacity-100',
                                      )}
                                    >
                                      {session.error &&
                                        message.id === latestUserId && (
                                          <div className='flex items-center'>
                                            <span className='text-destructive'>
                                              {t('assistant.responseFailed')}
                                            </span>
                                            <Button
                                              variant='ghost'
                                              size='icon-xs'
                                              aria-label={t(
                                                'assistant.retryResponse',
                                              )}
                                              title={t(
                                                'assistant.retryResponse',
                                              )}
                                              disabled={Boolean(busy)}
                                              onClick={() =>
                                                void resumeAssistant(
                                                  session.id,
                                                  scope,
                                                )
                                              }
                                            >
                                              <RefreshCcwIcon />
                                            </Button>
                                          </div>
                                        )}
                                      <AssistantMessageActions
                                        text={message.text}
                                        feedback={message.feedback}
                                        disabled={Boolean(
                                          busy || session.activeCall,
                                        )}
                                        onFeedback={
                                          message.role === 'assistant'
                                            ? (value) =>
                                                void setAssistantFeedback(
                                                  session.id,
                                                  message.id,
                                                  value,
                                                  scope,
                                                ).catch(() =>
                                                  toast.error(
                                                    t(
                                                      'assistant.feedbackFailed',
                                                    ),
                                                    { toasterId: 'global' },
                                                  ),
                                                )
                                            : undefined
                                        }
                                      />
                                    </MessageFooter>
                                  )}
                              </div>
                            ))}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}

                    {active && !active.runId && (
                      <MessageScrollerItem
                        messageId={`call-${active.toolName}`}
                      >
                        <Message>
                          <MessageContent>
                            <div className='flex flex-wrap items-center gap-2'>
                              <Badge variant='outline'>
                                {active.workflow.document.settings.name}
                              </Badge>
                              <span className='text-muted-foreground text-xs'>
                                {t(
                                  session.status === 'needs_input'
                                    ? 'assistant.inputsNeeded'
                                    : 'assistant.preparing',
                                )}
                              </span>
                            </div>
                            {session.status === 'needs_input' && (
                              <WorkflowRunForm
                                key={session.messages.length}
                                settings={active.workflow.document.settings}
                                initialInput={active.input}
                                isRunning={busy}
                                onClose={() =>
                                  void declineAssistantWorkflow(
                                    session.id,
                                    scope,
                                  )
                                }
                                onRun={(input) =>
                                  void provideAssistantInputs(
                                    session.id,
                                    input,
                                    scope,
                                  )
                                }
                                layout='dialog'
                              />
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )}
                    {session.error && (
                      <MessageScrollerItem messageId='error'>
                        <Alert variant='destructive'>
                          <AlertTitle>{t('assistant.failed')}</AlertTitle>
                          <AlertDescription>
                            <p>{session.error}</p>
                          </AlertDescription>
                        </Alert>
                      </MessageScrollerItem>
                    )}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>
          </div>
          <div className='mx-auto w-full max-w-[clamp(56rem,80cqw,84rem)] shrink-0 px-6 pt-3 pb-5'>
            {renderComposer()}
          </div>
        </>
      )}
    </div>
  );

  function renderComposer() {
    return (
      <div className='flex flex-col gap-3'>
        {!modelId && (
          <Alert>
            <AlertTitle>{t('assistant.selectModel')}</AlertTitle>
            <AlertDescription>
              <Link to='/settings'>{t('assistant.configureModel')}</Link>
            </AlertDescription>
          </Alert>
        )}
        <WorkflowChatComposer
          toolbarActions={
            <Select
              value={modelId || null}
              onValueChange={(value) => setChosenModel(value ?? '')}
            >
              <SelectTrigger
                className='max-w-40 border-none! bg-transparent! sm:max-w-64'
                aria-label={t('assistant.model')}
              >
                <SelectValue placeholder={t('assistant.selectModel')}>
                  {models.data?.find((model) => model.id === modelId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className='max-h-[min(24rem,var(--available-height))] w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-(--anchor-width)'>
                <SelectGroup>
                  {models.data?.map((model) => (
                    <SelectItem
                      key={model.id}
                      value={model.id}
                      className='[&>span:first-child]:min-w-0 [&>span:first-child]:shrink [&>span:first-child]:whitespace-normal'
                    >
                      <span className='flex min-w-0 flex-col gap-0.5'>
                        <span className='wrap-anywhere whitespace-normal'>
                          {model.name}
                        </span>
                        <span className='text-muted-foreground text-xs'>
                          {model.provider}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
          fileInputs={[{ ...attachmentsField, label: t('assistant.files') }]}
          filesForInput={() => files}
          onFileChange={(_key, value) => setFiles(artifactReferences(value))}
          message={draft}
          onMessageChange={setDraft}
          disabled={Boolean(busy || active || !modelId || (id && !session))}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        />
        {!session && (
          <p className='text-muted-foreground text-center text-xs'>
            {t('assistant.hint')}
          </p>
        )}
      </div>
    );
  }
}

export { StartPage as Component };
