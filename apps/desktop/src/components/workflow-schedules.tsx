import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Switch,
  Textarea,
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

import { isTeamMode } from '@/lib/constant';
import { previewCron } from '@/lib/cron';
import {
  deleteWorkflowSchedule,
  listWorkflowReleases,
  listWorkflowSchedules,
  saveWorkflowSchedule,
  setWorkflowScheduleEnabled,
  toWorkflowDsl,
  type WorkflowDocument,
  type WorkflowRelease,
  type WorkflowSchedule,
  type WorkflowScheduleRequest,
} from '@/services/workflow';

type Frequency = 'daily' | 'weekdays' | 'weekly' | 'custom';

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

function cronFor(frequency: Frequency, time: string, custom: string) {
  if (frequency === 'custom') return custom.trim();
  const [hour = '09', minute = '00'] = time.split(':');
  return frequency === 'weekdays'
    ? `${minute} ${hour} * * 1-5`
    : frequency === 'weekly'
      ? `${minute} ${hour} * * 1`
      : `${minute} ${hour} * * *`;
}

function deviceTimezone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

type ScheduleInputValues = Record<string, string | boolean>;

function initialInputValues(
  fields: WorkflowInput[],
  input: Record<string, unknown> | undefined,
): ScheduleInputValues {
  return Object.fromEntries(
    fields.map((field) => {
      const value = input?.[field.key];
      return [
        field.key,
        field.type === 'boolean' ? value === true : (value?.toString() ?? ''),
      ];
    }),
  );
}

function scheduleInput(
  fields: WorkflowInput[],
  values: ScheduleInputValues,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.flatMap((field) => {
      const value = values[field.key];
      if (field.type === 'boolean') return [[field.key, value === true]];
      if (value === undefined || value === '') return [];
      return [[field.key, field.type === 'number' ? Number(value) : value]];
    }),
  );
}

function WorkflowScheduleDialog({
  open,
  onOpenChange,
  schedule,
  workflowId,
  document,
  dsl,
  release,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: WorkflowSchedule;
  workflowId: string;
  document: WorkflowDocument;
  dsl: unknown;
  release?: WorkflowRelease;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();

  const releases = useQuery({
    queryKey: ['workflow-releases', workflowId],
    queryFn: () => listWorkflowReleases(workflowId),
    enabled: isTeamMode(),
  });

  const initial = useMemo(() => {
    const [minute = '0', hour = '9'] =
      schedule?.cronExpression.split(/\s+/) ?? [];
    return {
      name: schedule?.name ?? `${document.settings.name} schedule`,
      // Cron alone cannot distinguish a user-selected Custom expression from
      // an equivalent preset. Only legacy saved rows need the Custom fallback;
      // a brand-new schedule keeps the intentional daily default.
      frequency: schedule
        ? ((schedule.editorMode as Frequency | undefined) ?? 'custom')
        : 'daily',
      time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
      cron: schedule?.cronExpression ?? '0 9 * * *',
      timezone: schedule?.timezone ?? deviceTimezone(),
    };
  }, [document.settings.name, schedule]);

  const [draft, setDraft] = useState(initial);
  const inputs = document.settings.inputSchema.fields;
  const [inputValues, setInputValues] = useState<ScheduleInputValues>(() =>
    initialInputValues(inputs, schedule?.input),
  );
  const [inputErrors, setInputErrors] = useState<Set<string>>(new Set());

  const cron = cronFor(draft.frequency, draft.time, draft.cron);
  const preview = useMemo(
    () => previewCron(cron, draft.timezone, i18n.language),
    [cron, draft.timezone, i18n.language],
  );

  const [releaseId, setReleaseId] = useState<string>(release?.id ?? '');

  const selectedRelease =
    releases.data?.find((item) => item.id === releaseId) ?? release;
  const targetSnapshot = selectedRelease?.document ?? document;
  const source: WorkflowScheduleRequest['source'] = isTeamMode()
    ? selectedRelease
      ? {
          kind: 'published_release',
          dsl:
            selectedRelease.id === release?.id
              ? dsl
              : toWorkflowDsl(
                  workflowId,
                  selectedRelease.document.nodes,
                  selectedRelease.document.edges,
                  selectedRelease.document.settings,
                ),
          releaseId: selectedRelease.id,
          releaseVersion: selectedRelease.version,
        }
      : { kind: 'latest_local' }
    : { kind: 'latest_local' };
  const configuredInput = scheduleInput(inputs, inputValues);

  const save = useMutation({
    mutationFn: () =>
      saveWorkflowSchedule({
        id: schedule?.id,
        name: draft.name,
        targetId: workflowId,
        targetName: document.settings.name,
        targetSnapshot,
        cronExpression: cron,
        timezone: draft.timezone,
        enabled: schedule?.enabled ?? true,
        source,
        input: configuredInput,
        initialState: configuredInput,
        editorMode: draft.frequency,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['workflow-schedules', workflowId],
      });
      toast.success(t('workflowEditor.schedules.saved'), {
        toasterId: 'global',
      });
      onOpenChange(false);
    },
    onError: (error) =>
      toast.error(t('workflowEditor.schedules.failed'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      }),
  });
  const teamReleaseRequired = isTeamMode() && !selectedRelease;
  const submit = () => {
    const missing = new Set(
      inputs.flatMap((field) =>
        field.required &&
        field.type !== 'boolean' &&
        !String(inputValues[field.key] ?? '').trim()
          ? [field.key]
          : [],
      ),
    );
    if (missing.size) {
      setInputErrors(missing);
      return;
    }
    save.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        forceOverlay
        overlayClassName='z-60 bg-black/45 supports-backdrop-filter:backdrop-blur-sm'
        className='z-60 max-w-4xl! gap-0 overflow-hidden p-0'
      >
        <DialogHeader className='via-background to-background relative border-b bg-linear-to-br from-violet-500/14 px-7 py-7 pr-16'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(264_80%_60%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
          <div className='relative flex items-start gap-4'>
            <div className='bg-background/80 flex size-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 text-violet-700 shadow-sm dark:text-violet-300'>
              <CalendarClockIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg tracking-tight'>
                {t('workflowEditor.schedules.dialogTitle', {
                  name: document.settings.name,
                })}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-2xl leading-5'>
                {isTeamMode()
                  ? release
                    ? t('workflowEditor.schedules.teamDescription', {
                        version: release.version,
                      })
                    : t('workflowEditor.schedules.noRelease')
                  : t('workflowEditor.schedules.localDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='grid max-h-[min(70vh,680px)] overflow-y-auto lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]'>
          <div className='px-7 py-7'>
            <FieldGroup className='gap-7'>
              <Field>
                <FieldLabel htmlFor='workflow-schedule-name'>
                  {t('workflowEditor.schedules.name')}
                </FieldLabel>
                <Input
                  id='workflow-schedule-name'
                  value={draft.name}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </Field>
              {inputs.length ? (
                <Field className='bg-muted/15 gap-4 rounded-xl border p-4'>
                  <div>
                    <FieldLabel>
                      {t('workflowEditor.schedules.input')}
                    </FieldLabel>
                    <FieldDescription>
                      {t('workflowEditor.schedules.inputHelp')}
                    </FieldDescription>
                  </div>
                  <FieldGroup className='gap-4'>
                    {inputs.map((input) => {
                      const invalid = inputErrors.has(input.key);
                      const value = inputValues[input.key];
                      return (
                        <Field
                          key={input.id}
                          data-invalid={invalid || undefined}
                        >
                          <FieldLabel
                            htmlFor={`workflow-schedule-input-${input.id}`}
                          >
                            {input.label}
                            {input.required ? (
                              <span className='text-destructive'> *</span>
                            ) : null}
                          </FieldLabel>
                          {input.description ? (
                            <FieldDescription>
                              {input.description}
                            </FieldDescription>
                          ) : null}
                          {input.type === 'textarea' ? (
                            <Textarea
                              id={`workflow-schedule-input-${input.id}`}
                              aria-invalid={invalid || undefined}
                              value={typeof value === 'string' ? value : ''}
                              onChange={(event) =>
                                setInputValues((current) => ({
                                  ...current,
                                  [input.key]: event.target.value,
                                }))
                              }
                            />
                          ) : input.type === 'boolean' ? (
                            <Switch
                              id={`workflow-schedule-input-${input.id}`}
                              checked={value === true}
                              onCheckedChange={(checked) =>
                                setInputValues((current) => ({
                                  ...current,
                                  [input.key]: checked,
                                }))
                              }
                            />
                          ) : (
                            <Input
                              id={`workflow-schedule-input-${input.id}`}
                              type={input.type === 'number' ? 'number' : 'text'}
                              aria-invalid={invalid || undefined}
                              value={typeof value === 'string' ? value : ''}
                              onChange={(event) =>
                                setInputValues((current) => ({
                                  ...current,
                                  [input.key]: event.target.value,
                                }))
                              }
                            />
                          )}
                          {invalid ? (
                            <FieldDescription
                              className='text-destructive'
                              role='alert'
                            >
                              {t('workflowEditor.schedules.requiredInput')}
                            </FieldDescription>
                          ) : null}
                        </Field>
                      );
                    })}
                  </FieldGroup>
                </Field>
              ) : null}
              <Field>
                <FieldLabel>
                  {t('workflowEditor.schedules.frequency')}
                </FieldLabel>
                <div className='grid gap-2 sm:grid-cols-2'>
                  {(['daily', 'weekdays', 'weekly', 'custom'] as const).map(
                    (frequency) => (
                      <FrequencyOption
                        key={frequency}
                        frequency={frequency}
                        selected={draft.frequency === frequency}
                        label={t(`workflowEditor.schedules.${frequency}`)}
                        onSelect={() => setDraft({ ...draft, frequency })}
                      />
                    ),
                  )}
                </div>
              </Field>
              {draft.frequency === 'custom' ? (
                <Field>
                  <FieldLabel htmlFor='workflow-schedule-cron'>
                    {t('workflowEditor.schedules.cron')}
                  </FieldLabel>
                  <Input
                    id='workflow-schedule-cron'
                    className='font-mono'
                    value={draft.cron}
                    onChange={(event) =>
                      setDraft({ ...draft, cron: event.target.value })
                    }
                  />
                  <FieldDescription>
                    {t('workflowEditor.schedules.cronHelp')}
                  </FieldDescription>
                </Field>
              ) : (
                <Field>
                  <FieldLabel htmlFor='workflow-schedule-time'>
                    {t('workflowEditor.schedules.time')}
                  </FieldLabel>
                  <Input
                    id='workflow-schedule-time'
                    type='time'
                    value={draft.time}
                    onChange={(event) =>
                      setDraft({ ...draft, time: event.target.value })
                    }
                  />
                </Field>
              )}
              {isTeamMode() ? (
                <Field>
                  <FieldLabel htmlFor='workflow-schedule-release'>
                    {t('workflowEditor.schedules.release')}
                  </FieldLabel>
                  <Select
                    items={(releases.data ?? []).map((item) => ({
                      value: item.id,
                      label: item.version,
                    }))}
                    value={releaseId}
                    onValueChange={(value) => setReleaseId(value ?? '')}
                  >
                    <SelectTrigger id='workflow-schedule-release'>
                      <SelectValue
                        placeholder={
                          releases.isLoading
                            ? t('workflowEditor.schedules.loadingReleases')
                            : t('workflowEditor.schedules.chooseRelease')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {(releases.data ?? []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    {t('workflowEditor.schedules.releaseHelp')}
                  </FieldDescription>
                </Field>
              ) : null}
              <Field>
                <FieldLabel htmlFor='workflow-schedule-timezone'>
                  {t('workflowEditor.schedules.timezone')}
                </FieldLabel>
                <Input
                  id='workflow-schedule-timezone'
                  value={draft.timezone}
                  onChange={(event) =>
                    setDraft({ ...draft, timezone: event.target.value })
                  }
                />
                <FieldDescription>
                  {t('workflowEditor.schedules.overlap')}
                </FieldDescription>
              </Field>
            </FieldGroup>
          </div>
          <aside className='bg-muted/25 border-t px-6 py-7 lg:border-t-0 lg:border-l'>
            <p className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
              {t('workflowEditor.schedules.preview')}
            </p>
            <div className='bg-background mt-3 rounded-xl border p-4 shadow-sm'>
              <div className='flex items-center gap-2 text-sm font-medium'>
                <span className='bg-primary/10 text-primary flex size-7 items-center justify-center rounded-lg'>
                  <ClockIcon className='size-3.5' />
                </span>
                {preview.valid
                  ? preview.description
                  : t('workflowEditor.schedules.invalidCron')}
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
              <p className='flex items-start gap-3 text-sm'>
                <span className='flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'>
                  <CheckIcon className='size-3.5' />
                </span>
                {t('workflowEditor.schedules.overlap')}
              </p>
              <p className='flex items-start gap-3 text-sm'>
                <span className='flex size-7 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700 dark:text-sky-300'>
                  <ShieldCheckIcon className='size-3.5' />
                </span>
                {t('workflowEditor.schedules.openOnly')}
              </p>
            </div>
          </aside>
        </div>
        <DialogFooter className='bg-muted/15 mx-0 mb-0 border-t px-7 py-4'>
          <Button variant='outline' onClick={() => onOpenChange(false)}>
            {t('workflowEditor.schedules.cancel')}
          </Button>
          <Button
            disabled={
              save.isPending ||
              teamReleaseRequired ||
              !draft.name.trim() ||
              !preview.valid
            }
            onClick={submit}
          >
            {save.isPending
              ? t('workflowEditor.schedules.saving')
              : t('workflowEditor.schedules.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WorkflowSchedules({
  workflowId,
  document,
  dsl,
  release,
}: {
  workflowId: string;
  document: WorkflowDocument;
  dsl: unknown;
  release?: WorkflowRelease;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WorkflowSchedule>();
  const [deleting, setDeleting] = useState<WorkflowSchedule>();
  const schedules = useQuery({
    queryKey: ['workflow-schedules', workflowId],
    queryFn: () => listWorkflowSchedules(workflowId),
  });
  const enabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setWorkflowScheduleEnabled(id, enabled),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ['workflow-schedules', workflowId],
      }),
  });
  const remove = useMutation({
    mutationFn: deleteWorkflowSchedule,
    onSuccess: () => {
      setDeleting(undefined);
      void queryClient.invalidateQueries({
        queryKey: ['workflow-schedules', workflowId],
      });
    },
  });
  return (
    <Card className='shadow-sm' aria-labelledby='workflow-schedules-title'>
      <CardHeader>
        <div>
          <CardTitle id='workflow-schedules-title'>
            {t('workflowEditor.schedules.title')}
          </CardTitle>
          <CardDescription>
            {t('workflowEditor.schedules.description')}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className='space-y-3'>
        {schedules.isLoading ? (
          <div className='flex justify-center py-5'>
            <Spinner />
          </div>
        ) : schedules.data?.length ? (
          <div className='space-y-2'>
            {schedules.data.map((schedule) => (
              <article
                key={schedule.id}
                className='bg-background flex items-center gap-3 rounded-lg border p-3'
              >
                <CalendarClockIcon className='text-primary size-4 shrink-0' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <p className='truncate text-sm font-medium'>
                      {schedule.name}
                    </p>
                    <Badge variant={schedule.enabled ? 'secondary' : 'outline'}>
                      {schedule.enabled
                        ? t('workflowEditor.schedules.active')
                        : t('workflowEditor.schedules.paused')}
                    </Badge>
                  </div>
                  <p className='text-muted-foreground mt-0.5 truncate font-mono text-xs'>
                    {schedule.cronExpression} · {schedule.timezone}
                  </p>
                </div>
                <Switch
                  aria-label={t(
                    schedule.enabled
                      ? 'workflowEditor.schedules.pause'
                      : 'workflowEditor.schedules.resume',
                    { name: schedule.name },
                  )}
                  checked={schedule.enabled}
                  onCheckedChange={(value) =>
                    enabled.mutate({ id: schedule.id, enabled: value })
                  }
                />
                <Button
                  type='button'
                  size='icon-sm'
                  variant='ghost'
                  aria-label={t('workflowEditor.schedules.edit', {
                    name: schedule.name,
                  })}
                  onClick={() => setEditing(schedule)}
                >
                  <PencilIcon />
                </Button>
                <Button
                  type='button'
                  size='icon-sm'
                  variant='ghost'
                  aria-label={t('workflowEditor.schedules.delete', {
                    name: schedule.name,
                  })}
                  onClick={() => setDeleting(schedule)}
                >
                  <Trash2Icon />
                </Button>
              </article>
            ))}
          </div>
        ) : (
          <p className='text-muted-foreground py-4 text-sm'>
            {t('workflowEditor.schedules.empty')}
          </p>
        )}
        <div className='flex justify-center pt-2'>
          <Button variant='outline' onClick={() => setCreating(true)}>
            <PlusIcon data-icon='inline-start' />
            {t('workflowEditor.schedules.new')}
          </Button>
        </div>
      </CardContent>
      {creating ? (
        <WorkflowScheduleDialog
          open
          onOpenChange={setCreating}
          workflowId={workflowId}
          document={document}
          dsl={dsl}
          release={release}
        />
      ) : null}
      {editing ? (
        <WorkflowScheduleDialog
          open
          schedule={editing}
          onOpenChange={(open) => !open && setEditing(undefined)}
          workflowId={workflowId}
          document={document}
          dsl={dsl}
          release={release}
        />
      ) : null}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => !open && setDeleting(undefined)}
      >
        <AlertDialogContent forceOverlay={true}>
          <AlertDialogHeader>
            <AlertDialogMedia className='bg-destructive/10 text-destructive dark:bg-destructive/20 dark:text-destructive'>
              <Trash2Icon />
            </AlertDialogMedia>
            <AlertDialogTitle>
              {t('workflowEditor.schedules.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('workflowEditor.schedules.deleteConfirmDescription', {
                name: deleting?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t('workflowEditor.schedules.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {t('workflowEditor.schedules.deleteAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
