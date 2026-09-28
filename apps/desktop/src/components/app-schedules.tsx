import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Input,
  Spinner,
  Switch,
} from '@workspace/ui/components';
import {
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  PencilIcon,
  PlusIcon,
  ShieldCheckIcon,
  Trash2Icon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { previewCron } from '@/lib/cron';
import {
  deleteSchedule,
  listAppSchedules,
  saveAppSchedule,
  setScheduleEnabled,
  type AppSchedule,
  type ProcessNode,
} from '@/services/process-node';

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'custom';

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function cronFor(frequency: Frequency, time: string, custom: string) {
  if (frequency === 'custom') return custom.trim();
  const [hour = '09', minute = '00'] = time.split(':');
  const weekday =
    frequency === 'weekdays' ? '1-5' : frequency === 'weekly' ? '1' : '*';
  return `${Number(minute)} ${Number(hour)} * * ${weekday}`;
}

const frequencyIcons = {
  daily: ClockIcon,
  weekdays: CalendarClockIcon,
  weekly: CalendarClockIcon,
  custom: PencilIcon,
};

function FrequencyOption({
  frequency,
  selected,
  label,
  onSelect,
}: {
  frequency: Frequency;
  selected: boolean;
  label: string;
  onSelect: () => void;
}) {
  const Icon = frequencyIcons[frequency];
  return (
    <button
      type='button'
      aria-pressed={selected}
      onClick={onSelect}
      className={`group focus-visible:ring-ring flex min-h-16 items-center gap-3 rounded-xl border px-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none ${selected ? 'border-primary bg-primary/7 shadow-sm' : 'hover:bg-muted/60'}`}
    >
      <span
        className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:bg-background'}`}
      >
        <Icon className='size-4' />
      </span>
      <span className='text-sm font-medium'>{label}</span>
    </button>
  );
}

function PreviewRule({
  icon: Icon,
  className,
  text,
}: {
  icon: typeof CheckIcon;
  className: string;
  text: string;
}) {
  return (
    <div className='flex gap-3 rounded-lg px-1'>
      <span
        className={`flex size-7 shrink-0 items-center justify-center rounded-full ${className}`}
      >
        <Icon className='size-3.5' />
      </span>
      <p className='text-muted-foreground pt-0.5 text-sm leading-5'>{text}</p>
    </div>
  );
}

function ScheduleDescription({
  schedule,
  language,
}: {
  schedule: AppSchedule;
  language: string;
}) {
  const preview = previewCron(
    schedule.cronExpression,
    schedule.timezone,
    language,
  );
  return <>{preview.valid ? preview.description : schedule.cronExpression}</>;
}

function ScheduleRow({
  schedule,
  language,
  readOnly,
  onToggle,
  onEdit,
  onDelete,
}: {
  schedule: AppSchedule;
  language: string;
  readOnly?: boolean;
  onToggle: (enabled: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const nextRun = new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: schedule.timezone,
  }).format(new Date(schedule.nextRunAt));

  return (
    <article className='group relative grid gap-4 rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-muted/25 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center'>
      <div className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${schedule.enabled ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'}`}>
        <CalendarClockIcon className='size-5' />
      </div>
      <div className='min-w-0'>
        <div className='flex flex-wrap items-center gap-2'>
          <h3 className='truncate text-sm font-semibold'>{schedule.name}</h3>
          <Badge variant={schedule.enabled ? 'secondary' : 'outline'} className='h-5 rounded-full px-2 text-[10px] font-medium'>
            {schedule.enabled ? t('apps.schedules.active') : t('apps.schedules.paused')}
          </Badge>
        </div>
        <p className='text-muted-foreground mt-1 truncate text-sm'>
          <ScheduleDescription schedule={schedule} language={language} />
        </p>
        <div className='text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs'>
          <span className='font-mono'>{schedule.timezone}</span>
          <span className='hidden size-1 rounded-full bg-border sm:inline-block' />
          <span>{schedule.enabled ? t('apps.schedules.next', { time: nextRun }) : t('apps.schedules.schedulingPaused')}</span>
        </div>
      </div>
      {!readOnly ? (
        <div className='flex items-center justify-end gap-1 border-t pt-3 sm:border-t-0 sm:pt-0'>
          <Switch
            aria-label={schedule.enabled ? t('apps.schedules.pause') : t('apps.schedules.resume')}
            checked={schedule.enabled}
            onCheckedChange={onToggle}
          />
          <Button variant='ghost' size='icon-sm' aria-label={t('apps.schedules.edit')} onClick={onEdit}>
            <PencilIcon />
          </Button>
          <Button variant='ghost' size='icon-sm' aria-label={t('apps.schedules.delete')} onClick={onDelete}>
            <Trash2Icon />
          </Button>
        </div>
      ) : null}
    </article>
  );
}

function ScheduleDialog({
  app,
  schedule,
  open,
  onOpenChange,
}: {
  app: ProcessNode;
  schedule?: AppSchedule;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const initial = useMemo(() => {
    const [minute = '0', hour = '9', , , weekday = '*'] =
      schedule?.cronExpression.split(/\s+/) ?? [];
    return {
      name: schedule?.name ?? `${app.definition.name} schedule`,
      frequency: (weekday === '1-5'
        ? 'weekdays'
        : weekday === '1'
          ? 'weekly'
          : weekday === '*'
            ? 'daily'
            : 'custom') as Frequency,
      time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      cron: schedule?.cronExpression ?? '0 9 * * 1-5',
      timezone: schedule?.timezone ?? deviceTimezone(),
    };
  }, [app.definition.name, schedule]);

  const [draft, setDraft] = useState(initial);

  const cron = cronFor(draft.frequency, draft.time, draft.cron);

  const preview = useMemo(
    () => previewCron(cron, draft.timezone, i18n.language),
    [cron, draft.timezone, i18n.language],
  );

  const save = useMutation({
    mutationFn: () =>
      saveAppSchedule({
        id: schedule?.id,
        name: draft.name,
        targetId: app.definition.id,
        targetName: app.definition.name,
        targetSnapshot: app.definition,
        cronExpression: cron,
        timezone: draft.timezone,
        enabled: schedule?.enabled ?? true,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['app-schedules', app.definition.id],
      });
      toast.success(t('apps.schedules.saved'), { toasterId: 'global' });
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(t('apps.schedules.failed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      }),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-4xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='via-background to-background relative border-b bg-linear-to-br from-sky-500/14 px-7 py-7 pr-16'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
          <div className='relative flex items-start gap-4'>
            <div className='bg-background/80 flex size-11 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              <CalendarClockIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg tracking-tight'>
                {t('apps.schedules.dialogTitle', { name: app.definition.name })}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-2xl leading-5'>
                {t('apps.schedules.dialogDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='grid max-h-[min(70vh,680px)] overflow-y-auto lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]'>
          <div className='px-7 py-7'>
            <FieldGroup className='gap-7'>
              <Field>
                <FieldLabel htmlFor='app-schedule-name'>
                  {t('apps.schedules.name')}
                </FieldLabel>
                <Input
                  id='app-schedule-name'
                  className='max-w-xl'
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel>{t('apps.schedules.frequency')}</FieldLabel>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {(['daily', 'weekdays', 'weekly', 'custom'] as const).map(
                    (frequency) => (
                      <FrequencyOption
                        key={frequency}
                        frequency={frequency}
                        selected={draft.frequency === frequency}
                        label={t(`apps.schedules.${frequency}`)}
                        onSelect={() => setDraft({ ...draft, frequency })}
                      />
                    ),
                  )}
                </div>
              </Field>
              {draft.frequency === 'custom' ? (
                <Field>
                  <FieldLabel htmlFor='app-schedule-cron'>
                    {t('apps.schedules.cron')}
                  </FieldLabel>
                  <Input
                    id='app-schedule-cron'
                    className='font-mono'
                    value={draft.cron}
                    onChange={(event) =>
                      setDraft({ ...draft, cron: event.target.value })
                    }
                  />
                  <FieldDescription>
                    {t('apps.schedules.cronHelp')}
                  </FieldDescription>
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor='app-schedule-time'>
                    {t('apps.schedules.time')}
                  </FieldLabel>
                  <Input
                    id='app-schedule-time'
                    type='time'
                    value={draft.time}
                    onChange={(event) =>
                      setDraft({ ...draft, time: event.target.value })
                    }
                  />
                </Field>
              )}
              <Field>
                <FieldLabel htmlFor='app-schedule-timezone'>
                  {t('apps.schedules.timezone')}
                </FieldLabel>
                <Input
                  id='app-schedule-timezone'
                  className='max-w-xl font-mono text-sm'
                  value={draft.timezone}
                  onChange={(event) =>
                    setDraft({ ...draft, timezone: event.target.value })
                  }
                />
              </Field>
            </FieldGroup>
          </div>
          <aside className='bg-muted/25 border-t px-6 py-7 lg:border-t-0 lg:border-l'>
            <p className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
              {t('apps.schedules.preview')}
            </p>
            <div className='bg-background mt-3 rounded-xl border p-4 shadow-sm'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <span className='bg-primary/10 text-primary flex size-7 items-center justify-center rounded-lg'>
                  <ClockIcon className='size-3.5' />
                </span>
                {preview.valid
                  ? preview.description
                  : t('apps.schedules.invalidCron')}
              </div>
              <p className='text-muted-foreground mt-3 border-t pt-3 font-mono text-xs'>
                {cron || '—'}
              </p>
              <p className='text-muted-foreground mt-1 text-xs'>
                {draft.timezone}
              </p>
              {preview.valid ? (
                <div className='mt-4 space-y-1.5 border-t pt-3'>
                  {preview.occurrences.map((occurrence) => (
                    <p
                      key={occurrence.toISOString()}
                      className='text-muted-foreground text-xs'
                    >
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                        timeZone: draft.timezone,
                      }).format(occurrence)}
                    </p>
                  ))}
                </div>
              ) : (
                <p className='text-destructive mt-3 text-xs'>{preview.error}</p>
              )}
            </div>
            <div className='mt-5 space-y-3'>
              <PreviewRule
                icon={CheckIcon}
                className='bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                text={t('apps.schedules.overlap')}
              />
              <PreviewRule
                icon={ShieldCheckIcon}
                className='bg-sky-500/10 text-sky-700 dark:text-sky-300'
                text={t('apps.schedules.openOnly')}
              />
            </div>
          </aside>
        </div>
        <DialogFooter className='bg-muted/15 border-t px-7 py-4'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('apps.schedules.cancel')}
          </Button>
          <Button
            disabled={save.isPending || !draft.name.trim() || !preview.valid}
            onClick={() => save.mutate()}
          >
            {save.isPending ? <Spinner data-icon='inline-start' /> : null}
            {t('apps.schedules.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AppSchedules({
  app,
  readOnly,
}: {
  app: ProcessNode;
  readOnly?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<AppSchedule>();
  const [creating, setCreating] = useState(false);
  const schedules = useQuery({
    queryKey: ['app-schedules', app.definition.id],
    queryFn: () => listAppSchedules(app.definition.id),
  });
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ['app-schedules', app.definition.id],
    });
  const setEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setScheduleEnabled(id, enabled),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: deleteSchedule,
    onSuccess: () => {
      refresh();
      toast.success(t('apps.schedules.deleted'), { toasterId: 'global' });
    },
  });

  return (
    <Card className='shadow-sm'>
      <CardHeader>
        <div>
          <CardTitle>{t('apps.schedules.title')}</CardTitle>
          <CardDescription>{t('apps.schedules.description')}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {schedules.isLoading ? (
          <div className='flex justify-center py-4'>
            <Spinner />
          </div>
        ) : null}
        {!schedules.isLoading && !schedules.data?.length ? (
          <div className='flex min-h-52 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/15 px-6 py-8 text-center'>
            <span className='bg-primary/10 text-primary flex size-11 items-center justify-center rounded-xl'>
              <CalendarClockIcon className='size-5' />
            </span>
            <p className='mt-4 text-sm font-medium'>{t('apps.schedules.empty')}</p>
            <p className='text-muted-foreground mt-1 max-w-sm text-sm'>
              {t('apps.schedules.description')}
            </p>
            {!readOnly ? (
              <Button className='mt-5' onClick={() => setCreating(true)}>
                <PlusIcon data-icon='inline-start' />
                {t('apps.schedules.new')}
              </Button>
            ) : null}
          </div>
        ) : null}
        {schedules.data?.map((schedule) => (
          <ScheduleRow
            key={schedule.id}
            schedule={schedule}
            language={i18n.language}
            readOnly={readOnly}
            onToggle={(enabled) => setEnabled.mutate({ id: schedule.id, enabled })}
            onEdit={() => setEditing(schedule)}
            onDelete={() => remove.mutate(schedule.id)}
          />
        ))}
        {!readOnly && schedules.data?.length ? (
          <div className='flex justify-center pt-2'>
            <Button variant='outline' onClick={() => setCreating(true)}>
              <PlusIcon data-icon='inline-start' />
              {t('apps.schedules.new')}
            </Button>
          </div>
        ) : null}
      </CardContent>
      {creating ? (
        <ScheduleDialog app={app} open onOpenChange={setCreating} />
      ) : null}
      {editing ? (
        <ScheduleDialog
          app={app}
          schedule={editing}
          open
          onOpenChange={(open) => !open && setEditing(undefined)}
        />
      ) : null}
    </Card>
  );
}
