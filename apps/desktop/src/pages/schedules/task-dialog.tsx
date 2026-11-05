import {
  Alert,
  AlertDescription,
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogAction,
  AlertDialogCancel,
  Button,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components';
import {
  CalendarClockIcon,
  CheckIcon,
  ClockIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { previewCron } from '@/lib/cron';
import type { ScheduledTask, ScheduleChange } from '@/services/schedules';

import { TaskDetail, TaskEditor, TaskRule, time } from './task-components';

/** Match the existing App/Workflow scheduling dialogs: identity, fields, preview, footer. */
export function TaskDialogContent({
  task,
  error,
  disabled,
  editing,
  onEdit,
  onChange,
  onClose,
}: {
  task?: ScheduledTask;
  error?: string;
  disabled: boolean;
  editing: boolean;
  onEdit: (editing: boolean) => void;
  onChange: (change: ScheduleChange) => void;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const preview =
    task?.scheduleKind !== 'once' && task
      ? previewCron(task.cronExpression, task.timezone, i18n.language)
      : undefined;
  const occurrences =
    task?.scheduleKind === 'once'
      ? [task.runAt]
      : preview?.valid
        ? preview.occurrences.map((date) => date.toISOString())
        : [];
  return (
    <DialogContent className='w-[calc(100vw-2rem)]! max-w-4xl! gap-0 overflow-hidden p-0'>
      <DialogHeader className='via-background to-background relative border-b bg-linear-to-br from-sky-500/14 px-7 py-7 pr-16'>
        <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
        <div className='relative flex items-start gap-4'>
          <span className='bg-background/80 text-primary flex size-11 shrink-0 items-center justify-center rounded-xl border shadow-sm'>
            <CalendarClockIcon className='size-5' />
          </span>
          <div className='min-w-0'>
            <DialogTitle className='text-lg tracking-tight'>
              {task?.name || t('schedules.viewTask')}
            </DialogTitle>
            <DialogDescription className='mt-1 leading-5'>
              {task?.targetName || t('schedules.loading')}
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>
      {task ? (
        <div className='grid max-h-[min(70vh,680px)] overflow-y-auto lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]'>
          <div className='flex min-w-0 flex-col gap-6 px-7 py-7'>
            {error && (
              <Alert variant='destructive'>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            {!editing && (
              <TaskDetail
                task={task}
                disabled={disabled}
                onEdit={() => onEdit(!editing)}
                onChange={(change) => {
                  if (change.operation === 'delete') setConfirmDelete(true);
                  else onChange(change);
                }}
              />
            )}
            {editing && (
              <TaskEditor
                task={task}
                disabled={disabled}
                onCancel={() => onEdit(false)}
                onSubmit={onChange}
              />
            )}
          </div>
          <aside className='bg-muted/25 flex min-w-0 flex-col gap-5 border-t px-6 py-7 lg:border-t-0 lg:border-l'>
            <div>
              <p className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
                {t('apps.schedules.preview')}
              </p>
              <div className='bg-background mt-3 flex flex-col gap-3 rounded-xl border p-4 shadow-sm'>
                <div className='flex items-center gap-2 text-sm font-medium'>
                  <span className='bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-lg'>
                    <ClockIcon className='size-3.5' />
                  </span>
                  <TaskRule task={task} />
                </div>
                <p className='text-muted-foreground border-t pt-3 text-xs'>
                  {task.timezone}
                </p>
                <div className='flex flex-col gap-2 border-t pt-3'>
                  {occurrences
                    ?.filter(Boolean)
                    .slice(0, 3)
                    .map((date) => (
                      <p key={date} className='text-muted-foreground text-xs'>
                        {time(date, task.timezone, i18n.language)}
                      </p>
                    ))}
                </div>
              </div>
            </div>
            <p className='text-muted-foreground flex items-start gap-3 text-xs leading-5'>
              <CheckIcon className='text-primary mt-0.5 size-4 shrink-0' />
              {t('apps.schedules.overlap')}
            </p>
            <p className='text-muted-foreground flex items-start gap-3 text-xs leading-5'>
              <ShieldCheckIcon className='text-primary mt-0.5 size-4 shrink-0' />
              {t('schedules.localNotice')}
            </p>
          </aside>
        </div>
      ) : (
        <p role={error ? 'alert' : 'status'} className='p-7 text-sm'>
          {error || t('schedules.loading')}
        </p>
      )}
      <DialogFooter className='border-t px-7 py-5'>
        <Button variant='outline' onClick={onClose}>
          {t('common.close')}
        </Button>
      </DialogFooter>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent forceOverlay>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('apps.schedules.deleteConfirmTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('apps.schedules.deleteConfirmDescription', {
                name: task?.name,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disabled}
              onClick={() => {
                if (task)
                  onChange({
                    operation: 'delete',
                    id: task.id,
                    version: task.version,
                  });
                setConfirmDelete(false);
              }}
            >
              {t('schedules.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContent>
  );
}
