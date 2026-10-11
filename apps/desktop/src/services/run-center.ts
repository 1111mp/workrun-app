import type { PendingAction, RunRecordSummary } from './run-history';

export type RunCenterEntry = {
  run: RunRecordSummary;
  actions: PendingAction[];
  runCount: number;
};

/** One entry per target. Keep the selected run ID so navigation opens the
 * precise invocation that needs attention, rather than starting another run. */
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
        : run.status === 'running'
          ? 2
          : 3;
  const compare = (a: RunRecordSummary, b: RunRecordSummary) =>
    priority(a) - priority(b) ||
    Date.parse(b.startedAt) - Date.parse(a.startedAt);
  const grouped = new Map<string, RunCenterEntry>();
  for (const run of [...runs].sort(compare)) {
    const key = `${run.targetType}:${run.targetId}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.runCount++;
      existing.actions.push(...(actionsByRun.get(run.id) ?? []));
    } else {
      grouped.set(key, {
        run,
        runCount: 1,
        actions: [...(actionsByRun.get(run.id) ?? [])],
      });
    }
  }
  return [...grouped.values()];
}

export function runDetailsPath(run: RunRecordSummary) {
  const params = new URLSearchParams({ runId: run.id });
  if (run.targetType === 'app') return `/apps?${params}`;
  params.set('live', 'true');
  return `/workflows/${encodeURIComponent(run.targetId)}?${params}`;
}
