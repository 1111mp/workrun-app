import type { SchedulingModelSelection } from '@/services/schedules';

export function readSchedulingModelPreference(
  scope: string,
): SchedulingModelSelection | undefined {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`schedule-agent:last-model:${scope}`) || 'null',
    );
    if (
      !value ||
      typeof value !== 'object' ||
      !('modelId' in value) ||
      typeof value.modelId !== 'string'
    )
      return;
    const effort =
      'reasoningEffort' in value ? value.reasoningEffort : undefined;
    return {
      modelId: value.modelId,
      reasoningEffort:
        typeof effort === 'string' ? (effort as ReasoningEffort) : undefined,
    };
  } catch {
    // Model selection still works when preferences are unavailable or malformed.
    return undefined;
  }
}

export function writeSchedulingModelPreference(
  scope: string,
  selection: SchedulingModelSelection,
) {
  try {
    localStorage.setItem(
      `schedule-agent:last-model:${scope}`,
      JSON.stringify(selection),
    );
  } catch {
    // The current renderer retains the preference even when storage is disabled.
  }
}
