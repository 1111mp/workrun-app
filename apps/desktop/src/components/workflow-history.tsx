import { useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  Spinner,
} from '@workspace/ui/components';
import { ActivityIcon, HistoryIcon, PlayIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { getProcessNodes, type ProcessNode } from '@/services/process-node';
import type {
  RunObservability,
  RunRecordSummary,
  RunStatus,
  SpanMetricSummary,
  VersionMetricSummary,
} from '@/services/run-history';

const RUN_STATUS_STYLES: Record<RunStatus, string> = {
  queued: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  completed:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/30 bg-destructive/10 text-destructive',
  cancelled: 'border-muted-foreground/30 bg-muted text-muted-foreground',
  interrupted:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  running: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
  waiting_for_input:
    'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

function WorkflowHistory({
  runs,
  isLoading,
  hasMore,
  isLoadingMore,
  observability,
  scopedObservability,
  isObservabilityLoading,
  period,
  onPeriodChange,
  selectedVersion,
  onSelectedVersionChange,
  onLoadMore,
  onView,
}: {
  runs: RunRecordSummary[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  observability?: RunObservability;
  scopedObservability?: RunObservability;
  isObservabilityLoading: boolean;
  period: '7d' | '30d' | 'all';
  onPeriodChange: (period: '7d' | '30d' | 'all') => void;
  selectedVersion: string;
  onSelectedVersionChange: (version: string) => void;
  onLoadMore: () => void;
  onView: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const processNodes = useQuery({
    queryKey: ['processNodes'],
    queryFn: getProcessNodes,
  });
  return (
    <div className='bg-muted/20 flex min-h-0 flex-1 flex-col overflow-y-auto bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_95%_93%/0.5),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_95%_94%/0.24),transparent)] p-5 sm:p-7 dark:bg-[radial-gradient(ellipse_95%_75%_at_50%_-10%,hsl(214_70%_20%/0.32),transparent),radial-gradient(ellipse_65%_50%_at_0%_100%,hsl(190_70%_18%/0.18),transparent)]'>
      <div className='mx-auto flex w-full max-w-4xl flex-col gap-5'>
        <div>
          <div className='text-muted-foreground mb-2 flex items-center gap-2 text-xs font-medium tracking-[0.16em] uppercase'>
            <HistoryIcon className='size-3.5' />{' '}
            {t('workflowEditor.history.title')}
          </div>
          <h2 className='text-xl font-semibold tracking-tight'>
            {t('workflowEditor.history.executions')}
          </h2>
          <p className='text-muted-foreground mt-1 text-sm'>
            {t('workflowEditor.history.description')}
          </p>
        </div>
        <ObservabilitySummary
          observability={observability}
          scopedObservability={scopedObservability}
          isLoading={isObservabilityLoading}
          period={period}
          onPeriodChange={onPeriodChange}
          selectedVersion={selectedVersion}
          onSelectedVersionChange={onSelectedVersionChange}
          processNodes={processNodes.data ?? []}
        />
        {isLoading ? (
          <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-8 text-sm'>
            <Spinner /> {t('workflowEditor.history.loading')}
          </div>
        ) : runs.length ? (
          <>
            <ItemGroup>
              {runs.map((run) => (
                <Item
                  key={run.id}
                  variant='outline'
                  className='bg-card/50 border-l-4 border-l-violet-400/60'
                >
                  <ItemContent>
                    <ItemTitle>
                      {new Date(run.startedAt).toLocaleString(i18n.language)}
                    </ItemTitle>
                    <ItemDescription>
                      {run.durationMs !== undefined
                        ? t('apps.history.duration', {
                            seconds: (run.durationMs / 1000).toFixed(1),
                          })
                        : t('apps.history.durationUnavailable')}
                      {typeof run.modelTokens === 'number'
                        ? ` · ${t(
                            'workflowEditor.history.observability.tokens',
                            {
                              count: formatNumber(
                                run.modelTokens,
                                i18n.language,
                              ),
                            },
                          )}`
                        : ''}
                      {typeof run.modelEstimatedCostMicrousd === 'number'
                        ? ` · ${t(
                            'workflowEditor.output.telemetry.estimatedCost',
                            {
                              cost: formatUsd(
                                run.modelEstimatedCostMicrousd,
                                i18n.language,
                              ),
                            },
                          )}`
                        : ''}
                      {run.error ? ` · ${run.error}` : ''}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Badge
                      variant='outline'
                      className={RUN_STATUS_STYLES[run.status]}
                    >
                      {t(`runs.runStatus.${run.status}`)}
                    </Badge>
                    <Button size='sm' onClick={() => onView(run.id)}>
                      <PlayIcon data-icon='inline-start' />{' '}
                      {t('runs.viewOutput')}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
            {hasMore ? (
              <div className='flex justify-center'>
                <Button
                  variant='outline'
                  size='sm'
                  disabled={isLoadingMore}
                  onClick={onLoadMore}
                >
                  {isLoadingMore ? <Spinner data-icon='inline-start' /> : null}
                  {t('runs.loadMore')}
                </Button>
              </div>
            ) : (
              <p className='text-muted-foreground text-center text-xs'>
                {t('runs.allLoaded')}
              </p>
            )}
          </>
        ) : (
          <Empty className='min-h-64 border border-dashed'>
            <EmptyHeader>
              <EmptyMedia variant='icon'>
                <HistoryIcon />
              </EmptyMedia>
              <EmptyTitle>{t('runs.emptyTitle')}</EmptyTitle>
              <EmptyDescription>
                {t('workflowEditor.history.emptyDescription')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </div>
  );
}

function ObservabilitySummary({
  observability,
  scopedObservability,
  isLoading,
  period,
  onPeriodChange,
  selectedVersion,
  onSelectedVersionChange,
  processNodes,
}: {
  observability?: RunObservability;
  scopedObservability?: RunObservability;
  isLoading: boolean;
  period: '7d' | '30d' | 'all';
  onPeriodChange: (period: '7d' | '30d' | 'all') => void;
  selectedVersion: string;
  onSelectedVersionChange: (version: string) => void;
  processNodes: ProcessNode[];
}) {
  const { t, i18n } = useTranslation();
  if (isLoading) {
    return (
      <div className='text-muted-foreground bg-card flex items-center gap-2 rounded-xl border px-4 py-3 text-sm'>
        <Spinner /> {t('workflowEditor.history.observability.calculating')}
      </div>
    );
  }
  if (!observability || observability.overall.count === 0) return null;

  const scoped =
    selectedVersion === 'all' ? observability : scopedObservability;
  if (!scoped) return null;
  const { overall } = scoped;
  const attention = [...scoped.spans]
    .filter((span) => span.failedCount > 0)
    .sort(
      (left, right) =>
        right.failedCount - left.failedCount ||
        (right.p95DurationMs ?? 0) - (left.p95DurationMs ?? 0),
    )
    .slice(0, 3);
  return (
    <section className='bg-card overflow-hidden rounded-xl border shadow-sm'>
      <div className='flex flex-wrap items-center gap-2 border-b px-4 py-3'>
        <span className='flex size-7 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300'>
          <ActivityIcon className='size-4' />
        </span>
        <div>
          <h3 className='text-sm font-semibold'>
            {t('workflowEditor.history.observability.runtimeHealth')}
          </h3>
          <p className='text-muted-foreground text-xs'>
            {t('workflowEditor.history.observability.localRuns')}
          </p>
        </div>
        <div
          className='ml-auto flex items-center gap-1'
          aria-label={t('workflowEditor.history.observability.timeRange')}
        >
          {(['7d', '30d', 'all'] as const).map((value) => (
            <Button
              key={value}
              size='sm'
              variant={period === value ? 'secondary' : 'ghost'}
              onClick={() => onPeriodChange(value)}
            >
              {t(`workflowEditor.history.observability.periods.${value}`)}
            </Button>
          ))}
        </div>
      </div>
      {observability.versions.length > 1 ? (
        <div className='flex flex-wrap items-center gap-3 border-t px-4 py-3'>
          <label
            className='text-muted-foreground text-xs font-medium'
            htmlFor='observability-version'
          >
            {t('workflowEditor.history.observability.version')}
          </label>
          <select
            id='observability-version'
            className='bg-background border-input h-8 rounded-md border px-2 text-xs'
            value={selectedVersion}
            onChange={(event) => onSelectedVersionChange(event.target.value)}
          >
            <option value='all'>
              {t('workflowEditor.history.observability.allVersions')}
            </option>
            {observability.versions.map((version) => (
              <option
                key={version.releaseVersion}
                value={version.releaseVersion}
              >
                {version.releaseVersion}
              </option>
            ))}
          </select>
          <VersionComparison versions={observability.versions} />
        </div>
      ) : null}
      <div className='grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0'>
        <MetricCell
          label={t('workflowEditor.history.observability.runs')}
          value={String(overall.count)}
          detail={t('workflowEditor.history.observability.completed', {
            count: overall.completedCount,
          })}
        />
        <MetricCell
          label={t('workflowEditor.history.observability.successRate')}
          value={formatRate(overall.successRate)}
          detail={t('workflowEditor.history.observability.failed', {
            count: overall.failedCount,
          })}
        />
        <MetricCell
          label={t('workflowEditor.history.observability.p95Duration')}
          value={formatDuration(overall.p95DurationMs)}
          detail={t('workflowEditor.history.observability.average', {
            duration: formatDuration(overall.averageDurationMs),
          })}
        />
        <MetricCell
          label={t('workflowEditor.history.observability.modelTokens')}
          value={formatNumber(overall.totalTokens, i18n.language)}
          detail={t('workflowEditor.history.observability.inputOutput', {
            inputTokens: formatNumber(overall.inputTokens, i18n.language),
            outputTokens: formatNumber(overall.outputTokens, i18n.language),
          })}
        />
      </div>
      {attention.length > 0 ? (
        <div className='border-t px-4 py-3'>
          <p className='text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase'>
            {t('workflowEditor.history.observability.needsAttention')}
          </p>
          <div className='space-y-1.5'>
            {attention.map((span) => (
              <AttentionRow
                key={spanKey(span)}
                span={span}
                processNodes={processNodes}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function VersionComparison({ versions }: { versions: VersionMetricSummary[] }) {
  const { t, i18n } = useTranslation();
  return (
    <div className='flex min-w-0 flex-1 gap-2 overflow-x-auto'>
      {versions.map((version) => (
        <div
          key={version.releaseVersion}
          className='bg-muted/50 min-w-36 rounded-md px-2.5 py-1.5 text-xs'
        >
          <p className='font-medium'>{version.releaseVersion}</p>
          <p className='text-muted-foreground mt-0.5'>
            {formatRate(version.successRate)} ·{' '}
            {formatDuration(version.p95DurationMs)} ·{' '}
            {t('workflowEditor.history.observability.tokens', {
              count: formatNumber(version.totalTokens, i18n.language),
            })}
          </p>
        </div>
      ))}
    </div>
  );
}

function MetricCell({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className='min-w-0 px-4 py-3'>
      <p className='text-muted-foreground text-xs'>{label}</p>
      <p className='mt-1 truncate text-lg font-semibold tracking-tight'>
        {value}
      </p>
      <p className='text-muted-foreground mt-0.5 truncate text-xs'>{detail}</p>
    </div>
  );
}

function AttentionRow({
  span,
  processNodes,
}: {
  span: SpanMetricSummary;
  processNodes: ProcessNode[];
}) {
  const { t } = useTranslation();
  const label =
    processToolDisplayName(span.toolName, processNodes) ??
    span.model ??
    span.nodeId ??
    span.kind.replaceAll('_', ' ');
  return (
    <div className='bg-muted/50 flex items-center gap-3 rounded-md px-3 py-2 text-sm'>
      <span className='min-w-0 flex-1 truncate font-medium'>{label}</span>
      <span className='text-destructive shrink-0 text-xs'>
        {t('workflowEditor.history.observability.failed', {
          count: span.failedCount,
        })}
      </span>
      <span className='text-muted-foreground shrink-0 font-mono text-xs'>
        {formatDuration(span.p95DurationMs)}
      </span>
    </div>
  );
}

function processToolDisplayName(
  name: string | undefined,
  processNodes: ProcessNode[],
) {
  const matched =
    /^process_([0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12})$/i.exec(name ?? '');
  if (!matched) return name;
  const id = matched[1].replaceAll('_', '-');
  return (
    processNodes.find((node) => node.definition.id === id)?.definition.name ??
    name
  );
}

function formatRate(rate: number | undefined) {
  return rate === undefined ? '—' : `${Math.round(rate * 100)}%`;
}

function formatDuration(duration: number | undefined) {
  if (duration === undefined) return '—';
  return duration >= 1_000
    ? `${(duration / 1_000).toFixed(1)}s`
    : `${duration}ms`;
}

function formatNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale).format(value);
}

function formatUsd(microusd: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 6,
  }).format(microusd / 1_000_000);
}

function spanKey(span: SpanMetricSummary) {
  return [
    span.kind,
    span.nodeId,
    span.provider,
    span.model,
    span.toolName,
  ].join(':');
}

export { WorkflowHistory };
