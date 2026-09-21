import { Badge, Button } from '@workspace/ui/components';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  EvaluationRunDetail,
  EvaluationVersionCaseDiff,
  EvaluationVersionCriterionDiff,
  EvaluationVersionSummary,
} from '@/services/evaluation';

export function formatNumber(value?: number | null) {
  return typeof value === 'number'
    ? new Intl.NumberFormat().format(value)
    : '—';
}

export function formatCost(value?: number | null) {
  return typeof value === 'number' ? `$${(value / 1_000_000).toFixed(4)}` : '—';
}

export function formatDuration(value?: number | null) {
  return typeof value === 'number' ? `${(value / 1000).toFixed(1)}s` : '—';
}

export function versionKey(version: EvaluationVersionSummary) {
  return version.comparisonKey;
}

export function versionPassRate(version: EvaluationVersionSummary) {
  return version.totalCases
    ? Math.round((version.passedCases / version.totalCases) * 100)
    : 0;
}

export function versionDiffLabel(
  diff: EvaluationVersionCaseDiff,
  t: (key: string) => string,
) {
  return t(`evaluations.versionDiff.${diff.kind}`);
}

export function versionCriterionDiffLabel(
  diff: EvaluationVersionCriterionDiff,
  t: (key: string) => string,
) {
  return t(`evaluations.criterionDiff.${diff.kind}`);
}

export function selectTrendRuns(
  runs: EvaluationRunDetail[],
  includeRetries: boolean,
) {
  return runs.filter(
    (run) =>
      run.status === 'completed' && (includeRetries || !run.retryOfRunId),
  );
}

export function EvaluationTrends({
  runs,
  versions,
}: {
  runs: EvaluationRunDetail[];
  versions: EvaluationVersionSummary[];
}) {
  const { t } = useTranslation();
  const [includeRetries, setIncludeRetries] = useState(false);
  const completed = selectTrendRuns(runs, includeRetries);
  if (!completed.length) return null;
  const average = (values: number[]) =>
    values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : 0;
  const passRates = completed.map((run) =>
    run.totalCases ? (run.passedCases / run.totalCases) * 100 : 0,
  );
  const averageCost = average(
    completed.map((run) => run.estimatedCostMicrousd ?? 0),
  );
  const averageDuration = average(completed.map((run) => run.durationMs ?? 0));
  const failedRuns = completed.filter((run) => run.failedCases > 0).length;

  return (
    <div className='mt-5 border-t pt-4'>
      <div className='mb-3 flex items-center justify-between'>
        <div>
          <div className='text-muted-foreground text-[10px] font-semibold tracking-[0.16em] uppercase'>
            {t('evaluations.qualityTrends')}
          </div>
          <p className='text-muted-foreground mt-0.5 text-xs'>
            {t('evaluations.completedRuns', { count: completed.length })}
          </p>
        </div>
        <Badge variant='outline' className='text-[10px]'>
          {failedRuns
            ? t('evaluations.failedRuns', { count: failedRuns })
            : t('evaluations.stable')}
        </Badge>
      </div>
      <div className='mb-3 flex justify-end'>
        <Button
          size='sm'
          variant='ghost'
          onClick={() => setIncludeRetries((value) => !value)}
        >
          {includeRetries
            ? t('evaluations.excludeRetries')
            : t('evaluations.includeRetries')}
        </Button>
      </div>
      <p className='text-muted-foreground -mt-2 mb-3 text-[10px]'>
        {includeRetries
          ? t('evaluations.trendsIncludeRetriesHint')
          : t('evaluations.trendsExcludeRetriesHint')}
      </p>
      <div className='grid grid-cols-3 gap-2'>
        <TrendMetric
          label={t('evaluations.averagePassRate')}
          value={`${Math.round(average(passRates))}%`}
        />
        <TrendMetric
          label={t('evaluations.averageCost')}
          value={formatCost(averageCost)}
        />
        <TrendMetric
          label={t('evaluations.averageDuration')}
          value={formatDuration(averageDuration)}
        />
      </div>
      <div className='bg-background/60 mt-3 rounded-lg border p-3'>
        <div className='text-muted-foreground mb-2 text-[10px] font-medium'>
          {t('evaluations.passRateTrend')}
        </div>
        <div
          className='flex h-16 items-end gap-1'
          aria-label={t('evaluations.passRateTrendAria')}
        >
          {completed
            .slice(0, 16)
            .reverse()
            .map((run) => {
              const rate = run.totalCases
                ? (run.passedCases / run.totalCases) * 100
                : 0;
              return (
                <div
                  key={run.id}
                  title={`${new Date(run.startedAt).toLocaleString()}：${Math.round(rate)}%`}
                  className='bg-muted flex h-full min-w-1 flex-1 items-end overflow-hidden rounded-sm'
                >
                  <div
                    className={
                      rate === 100
                        ? 'w-full bg-emerald-500'
                        : rate >= 80
                          ? 'w-full bg-amber-500'
                          : 'w-full bg-rose-500'
                    }
                    style={{ height: `${Math.max(rate, 4)}%` }}
                  />
                </div>
              );
            })}
        </div>
        <div className='text-muted-foreground mt-1 flex justify-between text-[10px]'>
          <span>{t('evaluations.earlier')}</span>
          <span>{t('evaluations.latest')}</span>
        </div>
      </div>
      {versions.length > 1 ? (
        <div className='mt-3 space-y-1.5'>
          <div className='text-muted-foreground text-[10px] font-medium'>
            {t('evaluations.versionPerformance')}
          </div>
          <div className='text-muted-foreground text-[10px]'>
            {t('evaluations.versionPerformanceExcludesRetries')}
          </div>
          {versions.slice(0, 4).map((version) => (
            <div
              key={versionKey(version)}
              className='flex items-center justify-between gap-2 text-xs'
            >
              <span className='truncate font-medium'>
                {version.releaseVersion}
              </span>
              <span className='text-muted-foreground shrink-0'>
                {versionPassRate(version)}% ·{' '}
                {formatCost(version.estimatedCostMicrousd)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TrendMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className='bg-muted/40 rounded-md px-2 py-2 text-center'>
      <div className='text-muted-foreground text-[10px]'>{label}</div>
      <div className='mt-0.5 text-xs font-semibold'>{value}</div>
    </div>
  );
}
