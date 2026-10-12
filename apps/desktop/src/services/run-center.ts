import type { PendingAction, RunRecordSummary } from './run-history';

export type RunCenterEntry = {
  run: RunRecordSummary;
  actions: PendingAction[];
  runCount: number;
};

/** Keep each invocation selectable, including interrupted tasks from the same workflow. */
export function runCenterEntries(
  runs: RunRecordSummary[],
  actions: PendingAction[],
): RunCenterEntry[] {
  const actionsByRun = new Map<string, PendingAction[]>();
  for (const action of actions) {
    if (action.status !== 'pending') continue;
    const pending = actionsByRun.get(action.runId) ?? [];
    pending.push(action);
    actionsByRun.set(action.runId, pending);
  }
  const priority = (run: RunRecordSummary) =>
    actionsByRun.has(run.id)
      ? 0
      : run.status === 'waiting_for_input'
        ? 1
        : run.status === 'interrupted'
          ? 2
          : run.status === 'running'
            ? 3
            : 4;
  const compare = (a: RunRecordSummary, b: RunRecordSummary) =>
    priority(a) - priority(b) ||
    Date.parse(b.startedAt) - Date.parse(a.startedAt);
  return [...runs].sort(compare).map((run) => ({
    run,
    runCount: 1,
    actions: actionsByRun.get(run.id) ?? [],
  }));
}

export function runDetailsPath(run: RunRecordSummary) {
  const params = new URLSearchParams({ runId: run.id });
  if (run.targetType === 'app') return `/apps?${params}`;
  params.set('live', 'true');
  return `/workflows/${encodeURIComponent(run.targetId)}?${params}`;
}
