import { expect, it } from 'vitest';

import { runCenterEntries, runDetailsPath } from './run-center';
import type { PendingAction, RunRecordSummary } from './run-history';

function run(
  id: string,
  status: RunRecordSummary['status'],
  extra: Partial<RunRecordSummary> = {},
): RunRecordSummary {
  return {
    id,
    status,
    targetId: 'weather',
    targetType: 'workflow',
    targetName: 'Weather workflow',
    startedAt: '2026-10-11T00:00:00Z',
    ...extra,
  };
}
const question: PendingAction = {
  id: 'question-1',
  runId: 'waiting',
  status: 'pending',
  kind: 'ask_user_question',
  createdAt: '2026-10-11T00:01:00Z',
  payload: {},
};

it('merges a workflow and its pending requests into one task entry', () => {
  const entries = runCenterEntries(
    [run('waiting', 'waiting_for_input')],
    [question],
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].run.id).toBe('waiting');
  expect(entries[0].actions).toEqual([question]);
  expect(entries[0].runCount).toBe(1);
});

it('shows one entry per target and prioritizes the exact run that needs input', () => {
  const entries = runCenterEntries(
    [
      run('new-running', 'running', { startedAt: '2026-10-11T00:03:00Z' }),
      run('waiting', 'waiting_for_input'),
      run('queued', 'queued'),
      run('app-running', 'running', { targetType: 'app' }),
    ],
    [question],
  );
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({
    run: { id: 'waiting' },
    runCount: 3,
    actions: [question],
  });
  expect(entries[1].run.targetType).toBe('app');
});

it('retains requests from multiple invocations and chooses the newest active run without requests', () => {
  const other = { ...question, id: 'question-2', runId: 'other-waiting' };
  const grouped = runCenterEntries(
    [
      run('waiting', 'waiting_for_input'),
      run('other-waiting', 'waiting_for_input'),
    ],
    [question, other],
  );
  expect(grouped).toHaveLength(1);
  expect(grouped[0].actions).toHaveLength(2);
  expect(
    runCenterEntries(
      [
        run('older', 'running'),
        run('newer', 'running', { startedAt: '2026-10-11T00:05:00Z' }),
      ],
      [],
    )[0].run.id,
  ).toBe('newer');
});

it('opens existing runs in workflow details or the app list without starting execution', () => {
  expect(runDetailsPath(run('waiting', 'waiting_for_input'))).toBe(
    '/workflows/weather?runId=waiting&live=true',
  );
  expect(
    runDetailsPath(
      run('app-run', 'running', { targetType: 'app', targetId: 'report app' }),
    ),
  ).toBe('/apps?runId=app-run');
});
