import {
  QueryClient,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Badge,
  Button,
  Dialog,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@workspace/ui/components';
import {
  ArrowUpRightIcon,
  CalendarClockIcon,
  ClockIcon,
  SearchIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { conversationComposerClassName } from '@/components/conversation-layout';
import { WorkspaceHeaderContent } from '@/components/workspace-header-content';
import { scheduleState } from '@/lib/schedule-time';
import { getModelCatalog } from '@/services/cmd';
import {
  createSchedulingSession,
  decideScheduleChange,
  deleteSchedulingSession,
  getSchedule,
  listSchedules,
  listSchedulingSessions,
  changeScheduledTask,
  replySchedulingReceipt,
  sendSchedulingMessage,
  setSchedulingModel,
  stopSchedulingResponse,
  type ScheduleChange,
  type ScheduledTask,
  type SchedulingModelSelection,
  type SchedulingSession,
  type SchedulingStream,
} from '@/services/schedules';
import { useWorkrunStore } from '@/stores';

import {
  readSchedulingModelPreference,
  writeSchedulingModelPreference,
} from './model-preference';
import { ScheduleComposer } from './schedule-composer';
import { ScheduleHistoryMenu } from './schedule-history-menu';
import { ScheduleMessageList } from './schedule-message-list';
import {
  latestSchedulingSession,
  readSchedulingSession,
  rememberSchedulingSession,
} from './session-cache';
import { TaskRule, time } from './task-components';
import { TaskDialogContent } from './task-dialog';
import { useScheduleEvents } from './use-schedule-events';

export function Component() {
  const scope = useEntryWorkspace();
  const entry = (useLocation().state as { scheduleDraft?: string } | null)
    ?.scheduleDraft;
  const [entryKey, setEntryKey] = useState(entry);
  if (entry && entry !== entryKey) setEntryKey(entry);
  // A sidebar entry starts a fresh draft; later in-conversation routes retain its identity.
  return <SchedulesPage key={`${scope}:${entryKey || ''}`} scope={scope} />;
}

function SchedulesPage({ scope }: { scope: string }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const taskId = params.get('task') || '';
  const sessionId = params.get('conversation') || '';
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');
  const [editingTask, setEditingTask] = useState(false);
  const [taskError, setTaskError] = useState('');
  useScheduleEvents(scope);
  const conversationKeys = useRef(new Map<string, string>());
  const [draftId, setDraftId] = useState(() => crypto.randomUUID());
  const tasks = useQuery({
    queryKey: ['schedules', scope],
    queryFn: listSchedules,
  });
  const conversations = useQuery({
    queryKey: ['scheduling-sessions', scope],
    queryFn: listSchedulingSessions,
  });
  const task = useQuery({
    queryKey: ['schedule', scope, taskId],
    queryFn: () => getSchedule(taskId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: Boolean(taskId),
  });
  const session = useQuery({
    queryKey: ['scheduling-session', scope, sessionId],
    queryFn: () => readSchedulingSession(client, scope, sessionId),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: Boolean(sessionId),
  });
  const config = useWorkrunStore((state) => state.config);
  const models = useQuery({
    queryKey: ['model-catalog'],
    queryFn: getModelCatalog,
  });
  const [lastSelection, setLastSelection] = useState(() =>
    readSchedulingModelPreference(scope),
  );
  const modelId =
    session.data?.modelId ||
    (models.data === undefined ||
    models.data.some((model) => model.id === lastSelection?.modelId)
      ? lastSelection?.modelId
      : undefined) ||
    config?.summary_model_profile_id ||
    models.data?.find(
      (m) =>
        m.provider === 'ollama' ||
        config?.provider_credentials?.some(
          (c) => c.provider === m.provider && c.apiKey,
        ),
    )?.id ||
    '';

  const requestedEffort = session.data?.modelId
    ? session.data.reasoningEffort
    : lastSelection?.modelId === modelId
      ? lastSelection.reasoningEffort
      : undefined;
  // A pending catalog must not erase the effort restored from this conversation.
  const effort =
    models.data === undefined ||
    models.data
      .find((model) => model.id === modelId)
      ?.effortOptions?.includes(requestedEffort as ReasoningEffort)
      ? (requestedEffort ?? undefined)
      : undefined;

  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['schedules', scope] }),
      client.invalidateQueries({ queryKey: ['schedule', scope] }),
      client.invalidateQueries({ queryKey: ['scheduling-sessions', scope] }),
      client.invalidateQueries({ queryKey: ['app-schedules'] }),
      client.invalidateQueries({ queryKey: ['workflow-schedules'] }),
    ]);
  };
  const remember = async (value: SchedulingSession) => {
    const saved = await rememberSchedulingSession(client, scope, value);
    void client.invalidateQueries({ queryKey: ['scheduling-sessions', scope] });
    return saved;
  };
  const ensureSession = async () => {
    if (sessionId) return sessionId;
    const created = await createSchedulingSession(
      taskId || undefined,
      modelId ? { modelId, reasoningEffort: effort } : undefined,
    );
    // Transfer the pending view before navigating; creating an ID is not a different UI conversation.
    const pending = client.getQueryData<SchedulingView>([
      'scheduling-stream',
      scope,
      draftId,
    ]);
    if (pending)
      client.setQueryData(['scheduling-stream', scope, created.id], pending);
    conversationKeys.current.set(created.id, draftId);
    await remember(created);
    setParams({
      ...(taskId ? { task: taskId } : {}),
      conversation: created.id,
    });
    return created.id;
  };
  const rememberSelection = (selection: SchedulingModelSelection) => {
    setLastSelection(selection);
    writeSchedulingModelPreference(scope, selection);
  };
  const saveModel = useMutation({
    mutationFn: ({
      id,
      selection,
    }: {
      id: string;
      selection: SchedulingModelSelection;
    }) => setSchedulingModel(id, selection),
    onMutate: async ({ id, selection }) => {
      const key = ['scheduling-session', scope, id];
      await client.cancelQueries({ queryKey: key });
      const previous = client.getQueryData<SchedulingSession>(key);
      if (previous)
        client.setQueryData(key, {
          ...previous,
          ...selection,
          reasoningEffort: selection.reasoningEffort ?? null,
        });
      return { previous };
    },
    onSuccess: remember,
    onError: (error, { id }, context) => {
      if (context?.previous)
        client.setQueryData(
          ['scheduling-session', scope, id],
          (current: SchedulingSession | undefined) =>
            latestSchedulingSession(current, context.previous!),
        );
      setError(String(error));
    },
  });
  const selectModel = (selection: SchedulingModelSelection) => {
    setError('');
    rememberSelection(selection);
    if (sessionId) saveModel.mutate({ id: sessionId, selection });
  };
  const act = useMutation({
    mutationFn: (change: ScheduleChange) => changeScheduledTask(change),
    onMutate: () => setTaskError(''),
    onSuccess: async (updated, change) => {
      setEditingTask(false);
      if (updated) {
        await Promise.all([
          client.cancelQueries({ queryKey: ['schedule', scope, updated.id] }),
          client.cancelQueries({ queryKey: ['schedules', scope] }),
        ]);
        client.setQueryData(['schedule', scope, updated.id], updated);
        client.setQueryData<ScheduledTask[]>(['schedules', scope], (previous) =>
          previous?.map((item) => (item.id === updated.id ? updated : item)),
        );
      } else {
        const next = new URLSearchParams(params);
        next.delete('task');
        setParams(next, { replace: true });
        client.removeQueries({
          queryKey: ['schedule', scope, change.id],
          exact: true,
        });
      }
      toast.success(
        t(
          change.operation === 'delete'
            ? 'apps.schedules.deleted'
            : 'apps.schedules.saved',
        ),
        { toasterId: 'global' },
      );
      await Promise.all([
        client.invalidateQueries({ queryKey: ['schedules', scope] }),
        client.invalidateQueries({ queryKey: ['app-schedules'] }),
        client.invalidateQueries({ queryKey: ['workflow-schedules'] }),
      ]);
    },
    onError: (e) => setTaskError(String(e)),
  });
  const decide = useMutation({
    mutationFn: ({ id, approve }: { id: string; approve: boolean }) =>
      decideScheduleChange(sessionId, id, approve),
    onSuccess: async (value, decision) => {
      const saved = await remember(value);
      if (decision.approve) {
        const key = ['scheduling-stream', scope, saved.id];
        client.setQueryData<SchedulingView>(key, {
          text: '',
          activities: [],
          pending: true,
          baseMessageCount: saved.messages.length,
          receiptRevision: saved.revision ?? 0,
          proposalId: decision.id,
        });
        try {
          const response = await replySchedulingReceipt(saved.id, (event) =>
            receiveSchedulingStream(client, scope, saved.id, event, t),
          );
          await remember(response);
        } catch (error) {
          setError(String(error));
        } finally {
          client.setQueryData(key, {
            text: '',
            activities: [],
            pending: false,
          });
        }
      }
      // A newly created task already has a confirmation card; opening its details is an explicit action.
      if (taskId && saved.scheduleId !== taskId)
        setParams({
          conversation: saved.id,
          ...(saved.scheduleId ? { task: saved.scheduleId } : {}),
        });
      await refresh();
    },
    onError: (e) => setError(String(e)),
  });
  const removeConversation = useMutation({
    mutationFn: deleteSchedulingSession,
    onSuccess: (_, id) => {
      if (id === sessionId) {
        setDraftId(crypto.randomUUID());
        setParams(taskId ? { task: taskId } : {});
      }
      void client.invalidateQueries({
        queryKey: ['scheduling-sessions', scope],
      });
    },
    onError: (e) => setError(String(e)),
  });
  const busy =
    decide.isPending ||
    (saveModel.isPending && saveModel.variables.id === sessionId) ||
    session.data?.status === 'running';
  const visibleTasks = (tasks.data ?? []).filter((item) => {
    const matches = `${item.name} ${item.targetName}`
      .toLowerCase()
      .includes(search.toLowerCase());
    return (
      matches &&
      (filter === 'all' ||
        (filter === 'active' && item.enabled) ||
        (filter === 'paused' && !item.enabled && !item.finishedAt) ||
        (filter === 'ended' && Boolean(item.finishedAt)) ||
        (filter === 'attention' &&
          (item.finishReason === 'missed' ||
            item.finishReason === 'failed' ||
            item.lastError ||
            ['failed', 'interrupted'].includes(item.lastStatus || ''))))
    );
  });
  const openTask = async (item: ScheduledTask) => {
    setError('');
    try {
      const history = conversations.data ?? (await listSchedulingSessions());
      const existing = history.find(
        (c) => c.scheduleId === item.id || c.scheduleIds?.includes(item.id),
      );
      const opened =
        existing ||
        (await createSchedulingSession(item.id, {
          modelId,
          reasoningEffort: effort,
        }));
      if (!existing) await remember(opened as SchedulingSession);
      setParams({ conversation: opened.id });
    } catch (error) {
      setError(String(error));
    }
  };

  const showTasks = params.get('view') === 'tasks';

  return (
    <Tabs
      value={showTasks ? 'tasks' : 'conversation'}
      onValueChange={(value) => {
        setError('');
        // Keep route context while browsing tasks, so returning restores the same conversation.
        const next = new URLSearchParams(params);
        next.set('view', String(value));
        setParams(next);
      }}
      className='@container flex h-full min-h-0 flex-1 flex-col gap-0 overflow-hidden'
    >
      <h1 className='sr-only'>{t('schedules.title')}</h1>
      <WorkspaceHeaderContent>
        <div
          data-schedule-toolbar
          data-tauri-drag-region
          className='flex h-10 w-full shrink-0 items-center justify-between gap-2 px-2 [[data-workspace-header-slot]_&]:px-0'
        >
          <span
            className='text-muted-foreground hidden shrink-0 text-sm sm:inline'
            aria-hidden='true'
          >
            {t('schedules.title')}
          </span>
          <div className='ml-auto flex shrink-0 items-center gap-2 sm:gap-4'>
            <TabsList variant='line' aria-label={t('schedules.navigation')}>
              <TabsTrigger value='conversation'>
                {t('schedules.chat')}
              </TabsTrigger>
              <TabsTrigger value='tasks'>{t('schedules.list')}</TabsTrigger>
            </TabsList>
            <ScheduleHistoryMenu
              conversations={conversations.data ?? []}
              selectedId={sessionId}
              loading={conversations.isPending}
              error={
                conversations.error ? String(conversations.error) : undefined
              }
              deleting={removeConversation.isPending || busy}
              onSelect={(c) => {
                setError('');
                setParams({
                  conversation: c.id,
                });
              }}
              onDelete={(id) => removeConversation.mutate(id)}
              onNew={() => {
                setError('');
                setDraftId(crypto.randomUUID());
                setParams({ view: 'new' });
              }}
            />
          </div>
        </div>
      </WorkspaceHeaderContent>
      <main className='flex min-h-0 min-w-0 flex-1 flex-col'>
        {((showTasks && error) ||
          (!task.data && !session.data && (task.error || session.error))) && (
          <div
            role='alert'
            className='text-destructive border-b px-5 py-3 text-sm'
          >
            {error || String(task.error || session.error)}
            <Button
              variant='ghost'
              size='sm'
              onClick={() => {
                setError('');
                void task.refetch();
                void session.refetch();
              }}
            >
              {t('schedules.retry')}
            </Button>
          </div>
        )}
        <TabsContent
          value='tasks'
          className='min-h-0 overflow-y-auto px-5 py-6 sm:px-8'
        >
          <section className='mx-auto flex max-w-4xl flex-col gap-6'>
            <div>
              <h2 className='text-xl font-semibold tracking-tight'>
                {t('schedules.scheduled')}
              </h2>
              <p className='text-muted-foreground mt-2 text-sm'>
                {t('schedules.listDescription')}
              </p>
            </div>
            <div className='flex items-center gap-3'>
              <div className='relative min-w-0 flex-1'>
                <SearchIcon className='text-muted-foreground pointer-events-none absolute top-2 left-3 size-4' />
                <Input
                  className='pl-9'
                  aria-label={t('schedules.search')}
                  placeholder={t('schedules.search')}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <Select
                value={filter}
                onValueChange={(value) => {
                  if (value) setFilter(value);
                }}
              >
                <SelectTrigger aria-label={t('schedules.filter')}>
                  <SelectValue>{t(`schedules.${filter}`)}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {['all', 'active', 'paused', 'ended', 'attention'].map(
                      (value) => (
                        <SelectItem key={value} value={value}>
                          {t(`schedules.${value}`)}
                        </SelectItem>
                      ),
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className='divide-y'>
              {tasks.isPending && (
                <p className='text-muted-foreground py-10 text-center text-sm'>
                  {t('schedules.loading')}
                </p>
              )}
              {tasks.error && (
                <div role='alert' className='text-destructive py-6 text-sm'>
                  {String(tasks.error)}
                  <Button variant='ghost' onClick={() => void tasks.refetch()}>
                    {t('schedules.retry')}
                  </Button>
                </div>
              )}
              {tasks.isSuccess && !visibleTasks.length && (
                <p className='text-muted-foreground py-12 text-center text-sm'>
                  {t(
                    tasks.data.length
                      ? 'schedules.noMatches'
                      : 'schedules.emptyList',
                  )}
                </p>
              )}
              {visibleTasks.map((item) => (
                <button
                  key={item.id}
                  className='hover:bg-muted/40 flex w-full items-center gap-4 rounded-lg px-3 py-5 text-left transition-colors'
                  onClick={() => void openTask(item)}
                >
                  <span className='bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-xl'>
                    <CalendarClockIcon className='size-5' />
                  </span>
                  <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
                    <span className='truncate text-sm font-medium'>
                      {item.name}
                    </span>
                    <span className='text-muted-foreground truncate text-xs'>
                      {item.targetName} · <TaskRule task={item} />
                    </span>
                    <span className='text-muted-foreground text-xs sm:hidden'>
                      {item.enabled
                        ? time(item.nextRunAt, item.timezone, i18n.language)
                        : t(scheduleState(item))}
                    </span>
                  </div>
                  <div className='hidden flex-col items-end gap-1.5 sm:flex'>
                    <span className='text-muted-foreground text-xs'>
                      {t('schedules.next')}
                    </span>
                    <span className='text-xs tabular-nums'>
                      {item.enabled
                        ? time(item.nextRunAt, item.timezone, i18n.language)
                        : '—'}
                    </span>
                  </div>
                  <Badge variant='outline' className='shrink-0'>
                    {t(
                      item.lastError ||
                        ['failed', 'interrupted'].includes(
                          item.lastStatus || '',
                        )
                        ? 'schedules.attention'
                        : item.enabled
                          ? 'schedules.active'
                          : scheduleState(item),
                    )}
                  </Badge>
                  <ArrowUpRightIcon className='text-muted-foreground hidden size-4 shrink-0 sm:block' />
                </button>
              ))}
            </div>
            <p className='text-muted-foreground text-xs leading-5'>
              {t('schedules.localNotice')}
            </p>
          </section>
        </TabsContent>
        <TabsContent
          value='conversation'
          keepMounted
          className={showTasks ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        >
          {sessionId && !session.data && session.isPending ? (
            <p className='text-muted-foreground p-8'>
              {t('schedules.loading')}
            </p>
          ) : (
            <Conversation
              key={
                sessionId
                  ? conversationKeys.current.get(sessionId) || sessionId
                  : draftId
              }
              readError={
                error ||
                (session.data && session.error
                  ? String(session.error)
                  : undefined)
              }
              focusProposalId={params.get('proposal') || undefined}
              draftId={draftId}
              session={session.data}
              modelId={modelId}
              models={models.data ?? []}
              effort={effort}
              onEffortChange={(value) =>
                selectModel({ modelId, reasoningEffort: value ?? null })
              }
              onModelChange={(value) =>
                selectModel({ modelId: value, reasoningEffort: null })
              }
              ensureSession={ensureSession}
              remember={remember}
              refresh={refresh}
              busy={busy}
              scope={scope}
              onDecision={(id, approve) => {
                setError('');
                decide.mutate({ id, approve });
              }}
            />
          )}
        </TabsContent>
        <Dialog
          open={Boolean(taskId && task.data && !task.error)}
          onOpenChange={(open) => {
            if (!open) {
              setEditingTask(false);
              setTaskError('');
              const next = new URLSearchParams(params);
              next.delete('task');
              setParams(next, { replace: true });
            }
          }}
        >
          <TaskDialogContent
            task={task.data}
            error={taskError || (task.error ? String(task.error) : undefined)}
            disabled={act.isPending}
            editing={editingTask}
            onEdit={setEditingTask}
            onChange={(change) => act.mutate(change)}
            onClose={() => {
              setEditingTask(false);
              setTaskError('');
              const next = new URLSearchParams(params);
              next.delete('task');
              setParams(next, { replace: true });
            }}
          />
        </Dialog>
      </main>
    </Tabs>
  );
}

type SchedulingView = {
  text: string;
  activities: string[];
  reasoning?: import('@/services/assistant').AssistantReasoning[];
  receiptRevision?: number;
  proposalId?: string;
  phaseId?: string;
  pending: boolean;
  userMessage?: SchedulingSession['messages'][number];
  baseMessageCount?: number;
  error?: string;
};

function receiveSchedulingStream(
  client: QueryClient,
  scope: string,
  id: string,
  event: SchedulingStream,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  client.setQueryData<SchedulingView>(
    ['scheduling-stream', scope, id],
    (old) => {
      const next: SchedulingView = {
        text: '',
        activities: [],
        ...old,
        pending: true,
      };
      if (event.type === 'reasoning') {
        const thought = {
          id: event.id || event.phaseId || 'reasoning',
          turnId: id,
          phaseId: event.phaseId || '',
          text: event.text || '',
          durationMs: event.durationMs || 0,
          complete: Boolean(event.complete),
        };
        return {
          ...next,
          reasoning: [
            ...(next.reasoning || []).filter((item) => item.id !== thought.id),
            thought,
          ],
        };
      }
      if (event.type === 'phase_start')
        return {
          ...next,
          text: '',
          phaseId: event.phaseId,
          activities: [
            ...next.activities,
            t(
              next.activities.length
                ? 'schedules.progress.responding'
                : 'schedules.progress.understanding',
            ),
          ],
        };
      if (event.phaseId && next.phaseId && event.phaseId !== next.phaseId)
        return next;
      if (event.type === 'tool_start')
        return {
          ...next,
          activities: [
            ...next.activities,
            t(`schedules.progress.${event.name}`, {
              defaultValue: t('schedules.thinking'),
            }),
          ],
        };
      if (event.type === 'activity')
        return {
          ...next,
          activities: [...next.activities, event.summary || ''],
        };
      if (event.type === 'phase_end')
        return event.kind === 'activity'
          ? {
              ...next,
              text: '',
              activities: [...next.activities, next.text].filter(Boolean),
            }
          : next;
      return {
        ...next,
        text:
          event.type === 'text_replace'
            ? event.text || ''
            : next.text + (event.text || ''),
      };
    },
  );
}

function Conversation({
  focusProposalId,
  readError,
  draftId,
  session,
  models,
  modelId,
  onModelChange,
  effort,
  onEffortChange,
  ensureSession,
  remember,
  refresh,
  busy,
  scope,
  onDecision,
}: {
  focusProposalId?: string;
  readError?: string;
  draftId: string;
  session?: SchedulingSession;
  models: ModelDefinition[];
  modelId: string;
  onModelChange: (id: string) => void;
  effort?: ReasoningEffort;
  onEffortChange: (effort?: ReasoningEffort) => void;
  ensureSession: () => Promise<string>;
  remember: (s: SchedulingSession) => Promise<SchedulingSession>;
  refresh: () => Promise<void>;
  busy: boolean;
  scope: string;
  onDecision: (id: string, approve: boolean) => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [text, setText] = useState('');
  const streamState = useQuery<SchedulingView>({
    queryKey: ['scheduling-stream', scope, session?.id || draftId],
    queryFn: () => ({ text: '', activities: [], pending: false }),
    enabled: false,
  });
  const stream = streamState.data?.text || '';
  const activities = streamState.data?.activities ?? [];
  const viewport = useRef<HTMLDivElement>(null);
  const send = useMutation({
    mutationFn: async (message: string) => {
      const sourceKey = ['scheduling-stream', scope, session?.id || draftId];
      let responseKey = sourceKey;
      try {
        const id = await ensureSession();
        responseKey = ['scheduling-stream', scope, id];
        // Cache transport state independently of the mounted conversation: creating
        // a session changes the route before authentication/inference has finished.
        return await sendSchedulingMessage(
          id,
          modelId,
          message,
          (event) => {
            receiveSchedulingStream(client, scope, id, event, t);
          },
          effort,
        );
      } catch (error) {
        client.setQueryData<SchedulingView>(responseKey, (old) => ({
          text: '',
          activities: [],
          ...old,
          pending: false,
          error: String(error),
        }));
        throw error;
      }
    },
    onSuccess: async (value) => {
      await remember(value);
      // The route may already expose the native ID by the time this receipt arrives.
      // Always retire the transferred draft so it cannot reappear on a task-only route.
      client.removeQueries({
        queryKey: ['scheduling-stream', scope, draftId],
        exact: true,
      });
      client.setQueryData(['scheduling-stream', scope, value.id], {
        text: '',
        activities: [],
        pending: false,
      });
      void refresh();
    },
    onError: () => {
      void client.invalidateQueries({
        queryKey: ['scheduling-session', scope],
      });
    },
  });
  // Card decisions and preference writes lock controls without starting a model reply.
  const replying =
    session?.status === 'running' ||
    send.isPending ||
    Boolean(streamState.data?.pending);
  const active = busy || replying;
  const submit = (message: string) => {
    if (!message.trim() || !modelId || active) return;
    // This response cache survives route changes and idle snapshots fetched
    // before the native host has persisted the user turn.
    client.setQueryData<SchedulingView>(
      ['scheduling-stream', scope, session?.id || draftId],
      {
        text: '',
        activities: [],
        pending: true,
        userMessage: { id: crypto.randomUUID(), role: 'user', text: message },
        baseMessageCount: session?.messages.length ?? 0,
      },
    );
    send.mutate(message);
    setText('');
  };
  const landing =
    !session?.messages.length &&
    !session?.proposals.length &&
    !session?.questions.length &&
    !active &&
    !session?.error &&
    !streamState.data?.error;
  const composer = (
    <ScheduleComposer
      text={text}
      onTextChange={setText}
      onSubmit={() => submit(text)}
      models={models}
      modelId={modelId}
      onModelChange={onModelChange}
      effort={effort}
      onEffortChange={onEffortChange}
      active={active}
      canStop={Boolean(session?.id)}
      onStop={() => {
        if (session) void stopSchedulingResponse(session.id);
      }}
      modifying={false}
    />
  );
  const pendingUser = streamState.data?.userMessage;
  const messages = session?.messages ?? [];
  const hasNativeUser =
    pendingUser &&
    messages
      .slice(streamState.data?.baseMessageCount ?? 0)
      .some(
        (message) =>
          message.role === 'user' && message.text === pendingUser.text,
      );
  const displayedMessages =
    pendingUser && !hasNativeUser ? [...messages, pendingUser] : messages;
  const nativeUserIndex = pendingUser
    ? messages.findIndex(
        (message, index) =>
          index >= (streamState.data?.baseMessageCount ?? 0) &&
          message.role === 'user' &&
          message.text === pendingUser.text,
      )
    : -1;
  const nativeSettled =
    session?.status !== 'running' &&
    (nativeUserIndex >= 0 ||
      (streamState.data?.receiptRevision !== undefined &&
        (session?.revision ?? 0) > streamState.data.receiptRevision));
  const hasNativeAnswer =
    nativeUserIndex >= 0 &&
    messages
      .slice(nativeUserIndex + 1)
      .some((message) => message.role === 'assistant');
  const error =
    session?.error ||
    streamState.data?.error ||
    (send.error ? String(send.error) : undefined) ||
    readError;
  return (
    <>
      {landing ? (
        <div
          ref={viewport}
          className='flex min-h-0 flex-1 flex-col overflow-y-auto py-8 sm:py-12'
        >
          <div className='mx-auto my-auto w-full max-w-4xl shrink-0 px-6'>
            <div
              className='mx-auto flex w-full flex-col items-center gap-7'
              data-schedule-landing
            >
              <div className='flex flex-col items-center gap-3 text-center'>
                <ClockIcon className='text-muted-foreground mb-1 size-7' />
                <h2 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
                  {t('schedules.hero')}
                </h2>
                <p className='text-muted-foreground max-w-md text-sm leading-6'>
                  {t('schedules.heroDescription')}
                </p>
              </div>
              {composer}
              {error && (
                <p role='alert' className='text-destructive w-full text-sm'>
                  {error}
                </p>
              )}
              <div className='flex w-full flex-wrap justify-center gap-2'>
                {['exampleWeekly', 'exampleDaily', 'exampleManage'].map(
                  (key) => (
                    <Button
                      key={key}
                      variant='outline'
                      size='sm'
                      className='h-auto max-w-full rounded-full py-2 text-xs whitespace-normal'
                      onClick={() => {
                        setText(t(`schedules.${key}`));
                        viewport.current?.querySelector('textarea')?.focus();
                      }}
                    >
                      {t(`schedules.${key}`)}
                    </Button>
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <ScheduleMessageList
          focusProposalId={focusProposalId}
          positionKey={`schedule:${scope}:${session?.id || draftId}`}
          messages={displayedMessages}
          proposals={session?.proposals ?? []}
          questions={active && !nativeSettled ? [] : (session?.questions ?? [])}
          stream={nativeSettled || hasNativeAnswer ? '' : stream}
          activities={activities}
          reasoning={streamState.data?.reasoning ?? []}
          resultProposalId={streamState.data?.proposalId}
          animateFrom={streamState.data?.baseMessageCount}
          active={replying && !nativeSettled}
          disabled={active || !modelId}
          interrupted={session?.status === 'interrupted'}
          error={error}
          onDecision={onDecision}
          onAnswer={submit}
        />
      )}
      {!landing && (
        <div className={conversationComposerClassName}>{composer}</div>
      )}
    </>
  );
}
