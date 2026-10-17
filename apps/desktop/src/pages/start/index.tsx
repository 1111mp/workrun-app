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
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { ArtifactFiles } from '@/components/artifact-files';
import { WorkflowActionCards } from '@/components/workflow-actions';
import { WorkflowChatComposer } from '@/components/workflow-chat-composer';
import { WorkflowRunForm } from '@/components/workflow-run-panel';
import { artifactReferences, type ArtifactRef } from '@/services/artifact';
import type { AssistantMessage } from '@/services/assistant';
import { getModelCatalog } from '@/services/cmd';
import { inspectRunRecord } from '@/services/run-history';
import { cancelBackgroundWorkflowRun } from '@/services/workflow';
import { useRunWorkspaceStore, useWorkrunStore } from '@/stores';
import {
  createAssistantSession,
  declineAssistantWorkflow,
  loadAssistantSession,
  provideAssistantInputs,
  resumeAssistant,
  sendAssistantMessage,
  setAssistantFeedback,
  useAssistantStore,
} from '@/stores/assistant.store';

import { AssistantMessageActions } from './assistant-message-actions';
import { AssistantMessageText } from './assistant-message-text';

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
  const messages: AssistantMessage[] = [...(session?.messages ?? [])];
  if (stream && !messages.some((message) => message.id === stream.messageId)) {
    messages.push({
      id: stream.messageId,
      role: 'assistant',
      text: stream.text,
      content: { role: 'model', parts: [] },
    });
  }

  const latestMessageId = messages.at(-1)?.id;
  const latestUserId = [...messages]
    .reverse()
    .find((message) => message.role === 'user')?.id;
  const models = useQuery({
    queryKey: ['model-catalog'],
    queryFn: getModelCatalog,
  });
  const modelId =
    session?.modelId ||
    chosenModel ||
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
  const run = useQuery({
    queryKey: ['run-history', 'assistant', active?.runId],
    queryFn: () => inspectRunRecord(active!.runId!),
    enabled: Boolean(active?.runId),
    refetchInterval: active?.runId ? 1000 : false,
  });

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
      <div className='flex shrink-0 items-center justify-between gap-3 px-6 pb-3'>
        <div className='min-w-0 flex-1'>
          {session ? (
            <p className='truncate text-sm font-medium'>{session.title}</p>
          ) : (
            <Select
              value={modelId || null}
              onValueChange={(value) => setChosenModel(value ?? '')}
            >
              <SelectTrigger
                className='max-w-full sm:max-w-80'
                aria-label={t('assistant.model')}
              >
                <SelectValue placeholder={t('assistant.selectModel')}>
                  {models.data?.find((model) => model.id === modelId)?.name}
                </SelectValue>
              </SelectTrigger>
              <SelectContent
                align='start'
                alignItemWithTrigger={false}
                className='max-h-[min(24rem,var(--available-height))] w-max max-w-[min(22rem,calc(100vw-2rem))] min-w-(--anchor-width)'
              >
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
          )}
        </div>
        <Button
          variant='ghost'
          size='sm'
          nativeButton={false}
          render={<Link to='/start/library' />}
        >
          {t('assistant.browse')}
        </Button>
      </div>
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
                    {messages.map((message) => (
                      <MessageScrollerItem
                        key={message.id}
                        messageId={message.id}
                        scrollAnchor={message.role === 'user'}
                        className={
                          !message.text && !message.artifacts?.length
                            ? 'hidden'
                            : undefined
                        }
                      >
                        <Message
                          align={message.role === 'user' ? 'end' : 'start'}
                        >
                          <MessageContent>
                            {message.role === 'tool' ? (
                              <div className='flex flex-wrap items-center gap-2'>
                                <Badge variant='outline'>
                                  {message.workflowName}
                                </Badge>
                                <span className='text-muted-foreground text-xs'>
                                  {t(`runs.runStatus.${message.text}`, {
                                    defaultValue: message.text,
                                  })}
                                </span>
                                {message.runId && (
                                  <Button
                                    variant='ghost'
                                    size='sm'
                                    onClick={async () => {
                                      try {
                                        const record = await inspectRunRecord(
                                          message.runId!,
                                        );
                                        useRunWorkspaceStore
                                          .getState()
                                          .openRun(record);
                                      } catch (error) {
                                        toast.error(String(error), {
                                          toasterId: 'global',
                                        });
                                      }
                                    }}
                                  >
                                    {t('assistant.details')}
                                  </Button>
                                )}
                              </div>
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
                                    text={message.text}
                                    animate={message.id === stream?.messageId}
                                  />
                                </BubbleContent>
                              </Bubble>
                            )}
                            {Boolean(message.artifacts?.length) && (
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
                                                t('assistant.feedbackFailed'),
                                                { toasterId: 'global' },
                                              ),
                                            )
                                        : undefined
                                    }
                                  />
                                  {session.error &&
                                    message.id === latestUserId && (
                                      <>
                                        <span className='text-destructive'>
                                          {t('assistant.responseFailed')}
                                        </span>
                                        <Button
                                          variant='ghost'
                                          size='icon-xs'
                                          aria-label={t(
                                            'assistant.retryResponse',
                                          )}
                                          title={t('assistant.retryResponse')}
                                          disabled={Boolean(busy)}
                                          onClick={() =>
                                            void resumeAssistant(
                                              session.id,
                                              scope,
                                            )
                                          }
                                        >
                                          <RotateCcwIcon />
                                        </Button>
                                      </>
                                    )}
                                </MessageFooter>
                              )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ))}
                    {active && (
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
                                {session.status === 'needs_input'
                                  ? t('assistant.inputsNeeded')
                                  : run.data
                                    ? t(`runs.runStatus.${run.data.status}`)
                                    : t('assistant.preparing')}
                              </span>
                              {run.data && (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={() =>
                                    useRunWorkspaceStore
                                      .getState()
                                      .openRun(run.data!)
                                  }
                                >
                                  {t('assistant.details')}
                                </Button>
                              )}
                              {active.runId && (
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={() =>
                                    void cancelBackgroundWorkflowRun(
                                      active.runId!,
                                    ).catch((error) =>
                                      toast.error(String(error), {
                                        toasterId: 'global',
                                      }),
                                    )
                                  }
                                >
                                  {t('assistant.cancel')}
                                </Button>
                              )}
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
                            {active.runId && (
                              <WorkflowActionCards runId={active.runId} />
                            )}
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    )}
                    {session.status === 'thinking' && !stream?.text && (
                      <MessageScrollerItem messageId='thinking'>
                        <div
                          role='status'
                          className='text-muted-foreground flex items-center gap-2 text-sm'
                        >
                          <Spinner />
                          {t('assistant.thinking')}
                        </div>
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
          <div className='mx-auto w-full max-w-[clamp(48rem,72cqw,76rem)] shrink-0 px-6 pt-3 pb-5'>
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
