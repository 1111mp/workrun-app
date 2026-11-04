/** Timing metadata is shared by the task center and the original target editors. */
export type ScheduleTiming = {
  scheduleKind?: 'recurring' | 'once';
  runAt?: string | null;
  finishedAt?: string | null;
  finishReason?: 'triggered' | 'missed' | 'skipped' | 'failed' | null;
};

export function scheduleState(task: ScheduleTiming & { enabled: boolean }) {
  return task.finishedAt
    ? `schedules.finish.${task.finishReason ?? 'triggered'}`
    : task.enabled
      ? 'schedules.active'
      : 'schedules.paused';
}

export function localScheduleTime(
  value: string | null | undefined,
  timezone: string,
) {
  if (!value) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(value));
    const field = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value;
    return `${field('year')}-${field('month')}-${field('day')}T${field('hour')}:${field('minute')}`;
  } catch {
    return '';
  }
}
