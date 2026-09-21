import { describe, expect, it } from 'vitest';

import { selectTrendRuns } from './run-panel';

describe('selectTrendRuns', () => {
  const runs = [
    { id: 'baseline', status: 'completed' },
    { id: 'retry', status: 'completed', retryOfRunId: 'baseline' },
    { id: 'active', status: 'running' },
  ] as never[];

  it('excludes retry batches from baseline trends by default', () => {
    expect(selectTrendRuns(runs, false).map((run) => run.id)).toEqual([
      'baseline',
    ]);
  });

  it('includes retry batches when explicitly requested', () => {
    expect(selectTrendRuns(runs, true).map((run) => run.id)).toEqual([
      'baseline',
      'retry',
    ]);
  });
});
