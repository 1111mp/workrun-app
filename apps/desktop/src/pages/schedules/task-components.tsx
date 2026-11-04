import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Input,
  Textarea,
  Field,
  FieldGroup,
  FieldLabel,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import {
  CalendarClockIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useSearchParams } from 'react-router';
import { toast } from 'sonner';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { previewCron } from '@/lib/cron';
import { localScheduleTime, scheduleState } from '@/lib/schedule-time';
import type {
  ScheduledTask,
  ScheduleChange,
  ScheduleProposal,
  ScheduleQuestion,
} from '@/services/schedules';
import { getSchedule, listSchedules } from '@/services/schedules';

export function time(
  value: string | null | undefined,
  timezone: string,
  language: string,
) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat(language, {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}
export function TaskRule({ task }: { task: ScheduledTask }) {
  const { t, i18n } = useTranslation();
  if (task.scheduleKind === 'once')
    return (
      <>
        {time(task.runAt, task.timezone, i18n.language)} · {t('schedules.once')}
      </>
    );
  const preview = previewCron(
    task.cronExpression,
    task.timezone,
    i18n.language,
  );
  return <>{preview.valid ? preview.description : task.cronExpression}</>;
}

function TargetSource({ task }: { task: ScheduledTask }) {
  const { t } = useTranslation();
  return task.source ? (
    <p className='text-muted-foreground text-xs'>
      {t(`schedules.source.${task.source.kind}`)}
      {task.source.releaseVersion ? ` · ${task.source.releaseVersion}` : ''}
    </p>
  ) : null;
}

export function TaskDetail({
  task,
  disabled,
  onEdit,
  onChange,
}: {
  task: ScheduledTask;
  disabled: boolean;
  onEdit: () => void;
  onChange: (c: ScheduleChange) => void;
}) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const returnState = {
    assistantReturnTo: `${location.pathname}${location.search}${location.hash}`,
  };
  return (
    <section className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <div className='mb-2 flex items-center gap-2'>
            <Badge variant='outline'>
              {t(
                task.targetType === 'app'
                  ? 'navigation.apps'
                  : 'navigation.workflow',
              )}
            </Badge>
            <Badge variant='secondary'>{t(scheduleState(task))}</Badge>
          </div>
          <Link
            state={returnState}
            className='text-muted-foreground mt-1 inline-block text-sm underline underline-offset-4'
            to={`/${task.targetType === 'app' ? 'apps' : 'workflows'}/${encodeURIComponent(task.targetId)}`}
          >
            {task.targetName}
          </Link>
        </div>
        <div className='flex flex-wrap gap-2'>
          <Button
            variant='outline'
            size='sm'
            disabled={disabled}
            aria-label={t('schedules.edit')}
            onClick={onEdit}
          >
            <PencilIcon data-icon='inline-start' />
            {t('schedules.edit')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={disabled || Boolean(task.finishedAt)}
            aria-label={t(
              task.enabled ? 'schedules.pause' : 'schedules.resume',
            )}
            onClick={() =>
              onChange({
                operation: task.enabled ? 'pause' : 'resume',
                id: task.id,
                version: task.version,
              })
            }
          >
            {task.enabled ? (
              <PauseIcon data-icon='inline-start' />
            ) : (
              <PlayIcon data-icon='inline-start' />
            )}
            {t(task.enabled ? 'schedules.pause' : 'schedules.resume')}
          </Button>
          <Button
            variant='outline'
            size='sm'
            disabled={disabled}
            aria-label={t('schedules.delete')}
            onClick={() =>
              onChange({
                operation: 'delete',
                id: task.id,
                version: task.version,
              })
            }
          >
            <Trash2Icon data-icon='inline-start' />
            {t('schedules.delete')}
          </Button>
        </div>
      </div>
      <TargetSource task={task} />
      <FieldGroup>
        <Field>
          <FieldLabel>{t('apps.schedules.name')}</FieldLabel>
          <Input readOnly value={task.name} />
        </Field>
        <Field>
          <FieldLabel>{t('apps.schedules.frequency')}</FieldLabel>
          <div className='bg-muted/25 rounded-lg border px-3 py-2 text-sm'>
            <TaskRule task={task} />
          </div>
        </Field>
        <Field>
          <FieldLabel>{t('apps.schedules.timezone')}</FieldLabel>
          <Input readOnly value={task.timezone} />
        </Field>
      </FieldGroup>
      {task.lastError && (
        <p role='alert' className='text-destructive text-sm'>
          {task.lastError}
        </p>
      )}
      {task.input && Object.keys(task.input).length > 0 && (
        <details className='text-sm'>
          <summary className='text-muted-foreground cursor-pointer'>
            {t('schedules.input')}
          </summary>
          <pre className='bg-muted mt-2 overflow-auto rounded-lg p-3 text-xs'>
            {JSON.stringify(task.input, null, 2)}
          </pre>
        </details>
      )}
      <details className='text-sm' open={Boolean(task.occurrences?.length)}>
        <summary className='text-muted-foreground cursor-pointer'>
          {t('schedules.recentRuns')}
        </summary>
        <div className='mt-2 divide-y'>
          {!task.occurrences?.length && (
            <p className='text-muted-foreground py-3 text-xs'>
              {t('schedules.noRuns')}
            </p>
          )}
          {task.occurrences?.map((run) => (
            <div
              key={run.id}
              className='flex flex-wrap items-center justify-between gap-2 py-3'
            >
              <div>
                <p className='text-xs'>
                  {time(run.scheduledFor, task.timezone, i18n.language)}
                </p>
                <p className='text-muted-foreground mt-1 text-xs'>
                  {t(`schedules.status.${run.status}`, {
                    defaultValue: run.status,
                  })}
                  {run.error || run.reason
                    ? ` · ${run.error || run.reason}`
                    : ''}
                </p>
              </div>
              {run.runId && (
                <Link
                  state={returnState}
                  className='text-xs underline underline-offset-4'
                  to={
                    task.targetType === 'app'
                      ? `/apps?${new URLSearchParams({ runId: run.runId })}`
                      : `/workflows/${encodeURIComponent(task.targetId)}?${new URLSearchParams({ runId: run.runId, live: 'true' })}`
                  }
                >
                  {t('schedules.viewResult')}
                </Link>
              )}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

export function TaskEditor({
  task,
  disabled,
  onCancel,
  onSubmit,
}: {
  task: ScheduledTask;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (c: ScheduleChange) => void;
}) {
  const { t, i18n } = useTranslation();
  const [name, setName] = useState(task.name);
  const [cron, setCron] = useState(task.cronExpression || '0 9 * * *');
  const [kind, setKind] = useState(task.scheduleKind ?? 'recurring');
  const [runAt, setRunAt] = useState(
    localScheduleTime(task.runAt, task.timezone),
  );
  const [timezone, setTimezone] = useState(task.timezone);
  const [input, setInput] = useState(JSON.stringify(task.input ?? {}, null, 2));
  const [error, setError] = useState('');
  const preview = previewCron(cron, timezone, i18n.language);
  return (
    <Card className='min-w-0'>
      <form
        className='flex flex-col gap-4'
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const parsed: unknown = JSON.parse(input);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
              throw new Error(t('schedules.inputObject'));
            onSubmit({
              operation: 'update',
              id: task.id,
              version: task.version,
              name,
              scheduleKind: kind,
              ...(kind === 'once'
                ? { runAt }
                : { cronExpression: cron, runAt: null }),
              timezone,
              ...(task.targetType === 'workflow'
                ? { input: parsed as Record<string, unknown> }
                : {}),
            });
          } catch (err) {
            setError(String(err));
          }
        }}
      >
        <CardHeader>
          <CardTitle>{t('schedules.edit')}</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          <label className='block space-y-2 text-sm'>
            <span>{t('schedules.name')}</span>
            <Input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <div
            className='flex gap-2'
            role='group'
            aria-label={t('schedules.timeRule')}
          >
            {(['once', 'recurring'] as const).map((value) => (
              <Button
                key={value}
                type='button'
                variant={kind === value ? 'secondary' : 'outline'}
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {t(`schedules.${value}`)}
              </Button>
            ))}
          </div>
          <div className='grid gap-4 sm:grid-cols-2'>
            <label className='block space-y-2 text-sm'>
              <span>
                {t(kind === 'once' ? 'schedules.runAt' : 'schedules.cron')}
              </span>
              <Input
                required
                type={kind === 'once' ? 'datetime-local' : 'text'}
                value={kind === 'once' ? runAt : cron}
                onChange={(e) =>
                  kind === 'once'
                    ? setRunAt(e.target.value)
                    : setCron(e.target.value)
                }
              />
            </label>
            <label className='block space-y-2 text-sm'>
              <span>{t('schedules.timezone')}</span>
              <Input
                required
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </label>
          </div>
          <p className='text-muted-foreground text-xs'>
            {kind === 'once'
              ? t('schedules.onceNotice')
              : preview.valid
                ? preview.description
                : t('schedules.invalidTime')}
          </p>
          {task.targetType === 'workflow' && (
            <label className='block space-y-2 text-sm'>
              <span>{t('schedules.input')}</span>
              <Textarea
                value={input}
                className='font-mono text-xs'
                onChange={(e) => setInput(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p role='alert' className='text-destructive text-sm'>
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className='justify-end gap-2'>
          <Button type='button' variant='ghost' onClick={onCancel}>
            {t('schedules.cancel')}
          </Button>
          <Button
            type='submit'
            disabled={
              disabled ||
              (kind === 'once' ? !runAt : !preview.valid) ||
              !name.trim()
            }
          >
            {t('apps.schedules.save')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

type ChangeField = 'name' | 'cronExpression' | 'timezone' | 'input';
function changeValue(
  task: ScheduledTask | null,
  field: ChangeField,
  language: string,
) {
  if (!task) return '—';
  const value = task[field];
  if (field === 'cronExpression') {
    if (task.scheduleKind === 'once')
      return time(task.runAt, task.timezone, language);
    const preview = previewCron(task.cronExpression, task.timezone, language);
    return preview.valid ? preview.description : task.cronExpression;
  }
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? '—');
}

/** A saved task is a result of the assistant reply, distinct from its confirmation request. */
export function TaskResultCard({ proposal }: { proposal: ScheduleProposal }) {
  const { t, i18n } = useTranslation();
  const [params, setParams] = useSearchParams();
  const client = useQueryClient();
  const scope = useEntryWorkspace();
  // Observe shared task data without starting per-card requests. The saved
  // proposal remains immutable history; its task control reflects current state.
  const tasks = useQuery({
    queryKey: ['schedules', scope],
    queryFn: listSchedules,
    enabled: false,
  });
  const detail = useQuery({
    queryKey: ['schedule', scope, proposal.after.id],
    queryFn: () => getSchedule(proposal.after.id),
    enabled: false,
  });
  const task =
    tasks.data?.find((item) => item.id === proposal.after.id) ??
    detail.data ??
    proposal.after;
  const next = new URLSearchParams(params);
  next.set('task', task.id);
  next.delete('view');
  const open = useMutation({
    // Validate every click against native storage, including previously cached tasks.
    // Publish the data before opening so the dialog never grows from a loading shell.
    mutationFn: () => getSchedule(task.id),
    onSuccess: (fresh) => {
      client.setQueryData(['schedule', scope, task.id], fresh);
      client.setQueryData<ScheduledTask[]>(['schedules', scope], (previous) =>
        previous?.map((item) => (item.id === fresh.id ? fresh : item)),
      );
    },
    onError: (error) => {
      const missing =
        /not found|does not exist|was deleted|不存在|已删除/i.test(
          String(error),
        );
      toast.error(
        t(missing ? 'schedules.taskDeleted' : 'schedules.openTaskFailed'),
        { toasterId: 'global' },
      );
    },
  });
  return (
    <Card className='my-2 min-w-0 gap-0' role='region' aria-label={task.name}>
      <CardContent className='flex flex-wrap items-center gap-4 py-5'>
        <span className='bg-primary/10 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl'>
          <CalendarClockIcon className='size-5' />
        </span>
        <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
          <div className='flex flex-wrap items-center gap-2'>
            <p className='font-medium wrap-break-word'>{task.name}</p>
            <Badge variant='secondary'>
              {t(
                proposal.operation === 'delete'
                  ? 'apps.schedules.deleted'
                  : scheduleState(task),
              )}
            </Badge>
          </div>
          <p className='text-sm'>
            <TaskRule task={task} />
          </p>
          <p className='text-muted-foreground text-xs'>
            {task.timezone} · {t('schedules.next')}:{' '}
            {task.enabled
              ? time(task.nextRunAt, task.timezone, i18n.language)
              : '—'}
          </p>
          <span className='sr-only' role='status'>
            {t('schedules.saved')}
          </span>
        </div>
        {proposal.operation !== 'delete' && (
          <Button
            variant='outline'
            size='sm'
            nativeButton={false}
            role='link'
            render={<Link to={`/schedules?${next}`} />}
            disabled={open.isPending}
            onClick={(event) => {
              event.preventDefault();
              if (!open.isPending)
                open.mutate(undefined, { onSuccess: () => setParams(next) });
            }}
          >
            {t('schedules.viewTask')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function ProposalCard({
  proposal: p,
  disabled,
  onDecision,
}: {
  proposal: ScheduleProposal;
  disabled: boolean;
  onDecision: (id: string, approve: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const after = p.after;
  const changed =
    p.before &&
    (['name', 'cronExpression', 'timezone', 'input'] as const).filter(
      (field) =>
        JSON.stringify(p.before?.[field]) !== JSON.stringify(after[field]) ||
        (field === 'cronExpression' &&
          (p.before?.runAt !== after.runAt ||
            p.before?.scheduleKind !== after.scheduleKind)),
    );
  return (
    <Card
      role='region'
      className={cn(
        'my-2 min-w-0 border-l-4',
        p.status === 'waiting'
          ? 'border-l-primary'
          : 'border-l-muted-foreground/30',
      )}
      aria-label={t('schedules.taskCard')}
    >
      <CardHeader className='border-b'>
        <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
          <span className='text-muted-foreground flex items-center gap-2 text-xs font-medium'>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-lg',
                p.status === 'waiting'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted',
              )}
            >
              <CalendarClockIcon className='size-4' aria-hidden='true' />
            </span>
            {t(`schedules.operation.${p.operation}`)}
          </span>
          <Badge variant={p.status === 'waiting' ? 'secondary' : 'outline'}>
            {t(`schedules.cardStatus.${p.status}`)}
          </Badge>
        </div>
        <CardTitle className='wrap-break-word'>{after.name}</CardTitle>
        <CardDescription>{after.targetName}</CardDescription>
      </CardHeader>
      <CardContent className='flex min-w-0 flex-col gap-3'>
        <TargetSource task={after} />
        {p.operation !== 'delete' && (
          <>
            <p className='text-sm'>
              <TaskRule task={after} />
            </p>
            <p className='text-muted-foreground text-xs'>
              {after.timezone}
              {after.scheduleKind !== 'once' && (
                <>
                  {' '}
                  · {t('schedules.next')}:{' '}
                  {time(after.nextRunAt, after.timezone, i18n.language)}
                </>
              )}
            </p>
          </>
        )}
        {Boolean(changed && changed.length) && (
          <div className='flex flex-col gap-2 border-t pt-3'>
            {changed &&
              changed.map((field) => (
                <div key={field} className='text-xs'>
                  <p className='text-muted-foreground mb-1'>
                    {t(
                      `schedules.${field === 'cronExpression' ? 'timeRule' : field}`,
                    )}
                  </p>
                  <div className='overflow-auto whitespace-pre-wrap'>
                    <span className='text-muted-foreground line-through'>
                      {changeValue(p.before, field, i18n.language)}
                    </span>
                    <span className='mx-2'>→</span>
                    <span>{changeValue(after, field, i18n.language)}</span>
                  </div>
                </div>
              ))}
          </div>
        )}
        {after.input &&
          Object.keys(after.input).length > 0 &&
          !changed?.includes('input') && (
            <pre className='bg-muted overflow-auto rounded-lg p-3 text-xs'>
              {JSON.stringify(after.input, null, 2)}
            </pre>
          )}
        <p className='text-muted-foreground text-xs'>
          {t(
            p.operation === 'delete'
              ? 'schedules.deleteNotice'
              : p.operation === 'pause'
                ? 'schedules.pauseNotice'
                : after.scheduleKind === 'once'
                  ? 'schedules.onceNotice'
                  : 'schedules.localNotice',
          )}
        </p>
      </CardContent>
      {p.status === 'waiting' && (
        <CardFooter className='justify-end gap-2'>
          <Button
            variant='ghost'
            disabled={disabled}
            onClick={() => onDecision(p.id, false)}
          >
            {t('schedules.cancel')}
          </Button>
          <Button
            variant={p.operation === 'delete' ? 'destructive' : 'default'}
            disabled={disabled}
            onClick={() => onDecision(p.id, true)}
          >
            {t(`schedules.confirm.${p.operation}`)}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

export function Questions({
  questions,
  disabled,
  onSubmit,
}: {
  questions: ScheduleQuestion[];
  disabled: boolean;
  onSubmit: (s: string) => void;
}) {
  const { t } = useTranslation();
  const [answers, setAnswers] = useState<string[]>(questions.map(() => ''));
  return (
    <Card className='my-2 min-w-0'>
      <form
        className='flex flex-col gap-4'
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(
            questions.map((q, i) => `${q.title}\n${answers[i]}`).join('\n\n'),
          );
        }}
      >
        <CardHeader>
          <CardTitle>{t('schedules.detailsNeeded')}</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-5'>
          {questions.map((q, index) => (
            <fieldset key={index} className='space-y-3' disabled={disabled}>
              <legend className='mb-2 text-sm font-medium'>{q.title}</legend>
              {q.options?.map((option) => (
                <button
                  type='button'
                  key={option}
                  aria-pressed={answers[index] === option}
                  className={`hover:bg-muted w-full rounded-lg border px-3 py-2.5 text-left text-sm ${answers[index] === option ? 'border-primary bg-muted' : ''}`}
                  onClick={() =>
                    setAnswers((old) =>
                      old.map((a, i) => (i === index ? option : a)),
                    )
                  }
                >
                  {option}
                </button>
              ))}
              <Input
                aria-label={q.title}
                placeholder={t('schedules.answer')}
                value={answers[index]}
                onChange={(e) =>
                  setAnswers((old) =>
                    old.map((a, i) => (i === index ? e.target.value : a)),
                  )
                }
              />
            </fieldset>
          ))}
        </CardContent>
        <CardFooter className='justify-end'>
          <Button
            type='submit'
            disabled={disabled || answers.some((a) => !a.trim())}
          >
            {t('schedules.continue')}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
