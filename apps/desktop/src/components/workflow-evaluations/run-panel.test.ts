import { describe, expect, it } from 'vitest';

import { selectTrendRuns, versionDisplayLabel } from './run-panel';

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

describe('versionDisplayLabel', () => {
  const t = (key: string, options?: Record<string, string>) =>
    `${key}:${options?.version ?? options?.fingerprint ?? ''}`;

  it('keeps published versions distinct from drafts based on that release', () => {
    expect(
      versionDisplayLabel(
        {
          releaseId: 'release-1',
          releaseVersion: '1.0.0',
          comparisonKey: '1.0.0',
        } as never,
        t,
      ),
    ).toBe('v1.0.0');
    expect(
      versionDisplayLabel(
        {
          releaseVersion: 'draft',
          baseReleaseVersion: '1.0.0',
          comparisonKey: '14feabd6b30319bc',
        } as never,
        t,
      ),
    ).toBe('evaluations.draftBasedOnRelease:1.0.0');
  });

  it('labels legacy draft records without inventing a published base', () => {
    expect(
      versionDisplayLabel(
        {
          releaseVersion: 'draft',
          comparisonKey: '14feabd6b30319bc',
        } as never,
        t,
      ),
    ).toBe('evaluations.draftUnknownBase:14feabd6');
  });
});
