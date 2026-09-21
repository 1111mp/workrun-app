import { Badge } from '@workspace/ui/components';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  EvaluationVersionCaseCriterionComparison,
  EvaluationVersionCriterionDiff,
} from '@/services/evaluation';

import { versionCriterionDiffLabel } from './run-panel';

function stringValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

export function ResultJson({
  title,
  value,
}: {
  title: string;
  value: unknown;
}) {
  return (
    <div>
      <div className='mb-1 text-xs font-medium tracking-wider uppercase'>
        {title}
      </div>
      <pre className='bg-muted max-h-52 overflow-auto rounded-lg p-3 text-xs leading-5 wrap-break-word whitespace-pre-wrap'>
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

export function ResultMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <div className='text-muted-foreground text-[11px]'>{label}</div>
      <div className='mt-0.5 text-sm font-medium'>{value}</div>
    </div>
  );
}

export function VersionCriterionComparison({
  comparison,
  baselineLabel,
  candidateLabel,
  nodeNames,
  routeNames,
}: {
  comparison: EvaluationVersionCaseCriterionComparison;
  baselineLabel: string;
  candidateLabel: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  if (!comparison.criteria.length) {
    return (
      <p className='text-muted-foreground text-sm'>
        {t('evaluations.noCriteriaResults')}
      </p>
    );
  }
  return (
    <div className='flex flex-col gap-2'>
      <p className='text-muted-foreground text-xs leading-5'>
        {t('evaluations.regressionLocationDescription')}
      </p>
      {comparison.criteria.map((diff) => (
        <div
          key={diff.key}
          className={
            diff.kind === 'regressed'
              ? 'border-destructive/40 bg-destructive/5 rounded-lg border p-3'
              : 'bg-muted/30 rounded-lg border p-3'
          }
        >
          <div className='flex items-start justify-between gap-3'>
            <span className='min-w-0 text-sm font-medium'>
              {criterionLabel(
                {
                  criterion: diff.key,
                  expected: diff.baseline?.expected ?? diff.candidate?.expected,
                },
                undefined,
                t,
              )}
            </span>
            <Badge
              variant={diff.kind === 'regressed' ? 'destructive' : 'outline'}
              className='shrink-0'
            >
              {versionCriterionDiffLabel(diff, t)}
            </Badge>
          </div>
          <div className='mt-3 grid grid-cols-2 gap-2 text-xs'>
            <CriterionComparisonCell
              label={baselineLabel}
              outcome={diff.baseline}
              criterion={diff.key}
              nodeNames={nodeNames}
              routeNames={routeNames}
            />
            <CriterionComparisonCell
              label={candidateLabel}
              outcome={diff.candidate}
              criterion={diff.key}
              nodeNames={nodeNames}
              routeNames={routeNames}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function CriterionComparisonCell({
  label,
  outcome,
  criterion,
  nodeNames,
  routeNames,
}: {
  label: string;
  outcome?: EvaluationVersionCriterionDiff['baseline'];
  criterion: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className='bg-background/70 rounded-md border px-2.5 py-2'>
      <p className='text-muted-foreground truncate'>{label}</p>
      <p
        className={
          outcome == null
            ? 'text-muted-foreground mt-1'
            : outcome.passed
              ? 'mt-1 text-emerald-600 dark:text-emerald-400'
              : 'text-destructive mt-1'
        }
      >
        {outcome == null
          ? t('evaluations.assertionNotPresent')
          : outcome.passed
            ? t('evaluations.assertionPassed')
            : t('evaluations.assertionFailed')}
      </p>
      {outcome ? (
        <CriterionEvidence
          criterion={criterion}
          expected={outcome.expected}
          actual={outcome.actual}
          nodeNames={nodeNames}
          routeNames={routeNames}
        />
      ) : null}
    </div>
  );
}

export function CriterionEvidence({
  criterion,
  expected,
  actual,
  nodeNames,
  routeNames,
}: {
  criterion: string;
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const actualValue = actual as Record<string, unknown>;
  const expectedValue = expected as Record<string, unknown>;
  let evidence: ReactNode;
  if (criterion.startsWith('nodeTrajectory:')) {
    const executions = Array.isArray(actualValue?.nodeExecutions)
      ? actualValue.nodeExecutions
      : [];
    evidence = executions.length ? (
      <span>
        {executions
          .map((item) => {
            const execution = item as Record<string, unknown>;
            const nodeId = stringValue(execution.nodeId);
            return `${nodeNames[nodeId] ?? nodeId}${execution.completed === true ? ' ✓' : ' ·'}`;
          })
          .join(' → ')}
      </span>
    ) : (
      <span>{renderEvidence(actual)}</span>
    );
  } else if (criterion.startsWith('route:')) {
    const nodeId = stringValue(expectedValue?.nodeId);
    const route = actualValue?.route;
    evidence =
      typeof route === 'string' ? (
        <span>{routeNames[`${nodeId}:${route}`] ?? route}</span>
      ) : (
        <span>{t('evaluations.routeNotRecorded')}</span>
      );
  } else if (criterion.startsWith('nodeToolTrajectory:')) {
    const uses = Array.isArray(actualValue?.toolUses)
      ? actualValue.toolUses
      : [];
    const names = uses
      .map((item) => stringValue((item as Record<string, unknown>).name))
      .filter(Boolean);
    evidence = names.length ? (
      <span>{names.join(' · ')}</span>
    ) : (
      <span>{t('evaluations.noToolCallsConfigured')}</span>
    );
  } else {
    evidence = <span>{renderEvidence(actual)}</span>;
  }
  return (
    <div className='text-muted-foreground mt-2 max-h-20 overflow-auto border-t pt-2 leading-5 wrap-break-word'>
      <span className='mr-1'>{t('evaluations.actual')}:</span>
      {evidence}
    </div>
  );
}

export function ResultValue({ value }: { value: unknown }) {
  const text = (value as { text?: unknown } | undefined)?.text;
  return (
    <pre className='bg-muted mt-3 max-h-48 overflow-auto rounded-lg p-3 text-xs leading-5 wrap-break-word whitespace-pre-wrap'>
      {typeof text === 'string' ? text : JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ResultCriteria({
  value,
  expectation,
  nodeNames,
  routeNames,
}: {
  value: unknown;
  expectation?: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const criteria = Array.isArray(value)
    ? (value as Array<Record<string, unknown>>)
    : [];
  return (
    <div className='mt-3 flex flex-col gap-2'>
      {criteria.map((item, index) => {
        const passed = item.passed === true;
        return (
          <div
            key={`${stringValue(item.criterion)}-${index}`}
            className='bg-background rounded-lg border p-3'
          >
            <div className='flex items-center gap-2'>
              <span
                className={passed ? 'text-emerald-600' : 'text-destructive'}
              >
                {passed
                  ? t('evaluations.assertionPassed')
                  : t('evaluations.assertionFailed')}
              </span>
              <span className='min-w-0 flex-1 truncate text-sm font-medium'>
                {criterionLabel(item, expectation, t)}
              </span>
              <span className='text-muted-foreground text-xs'>
                {Math.round(Number(item.score ?? 0) * 100)}%
              </span>
            </div>
            {stringValue(item.criterion).startsWith('nodeTrajectory:') ? (
              <NodeTrajectoryCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
              />
            ) : stringValue(item.criterion).startsWith('route:') ? (
              <RouteCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
                routeNames={routeNames}
              />
            ) : stringValue(item.criterion).startsWith('nodeOutput:') ? (
              <NodeOutputCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
              />
            ) : stringValue(item.criterion).startsWith('nodeText:') ? (
              <NodeTextCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
              />
            ) : (
              <div className='mt-2 grid gap-2 text-xs sm:grid-cols-2'>
                <EvidenceValue
                  label={t('evaluations.expected')}
                  value={item.expected}
                />
                <EvidenceValue
                  label={t('evaluations.actual')}
                  value={item.actual}
                />
              </div>
            )}
          </div>
        );
      })}
      {!criteria.length ? (
        <p className='text-muted-foreground text-sm'>
          {t('evaluations.noCriteriaResults')}
        </p>
      ) : null}
    </div>
  );
}

export function EvidenceValue({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <div className='min-w-0'>
      <p className='text-muted-foreground mb-1 font-medium'>{label}</p>
      <p className='bg-muted/60 overflow-auto rounded px-2 py-1.5 font-mono leading-5 wrap-break-word whitespace-pre-wrap'>
        {renderEvidence(value)}
      </p>
    </div>
  );
}

export function RouteCriterion({
  expected,
  actual,
  nodeNames,
  routeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const expectedValue = expected as Record<string, unknown>;
  const actualValue = actual as Record<string, unknown>;
  const nodeId = stringValue(expectedValue?.nodeId);
  const routeName = (route: unknown) =>
    typeof route === 'string'
      ? (routeNames[`${nodeId}:${route}`] ?? route)
      : t('evaluations.routeNotRecorded');
  return (
    <div className='bg-muted/30 mt-3 grid gap-3 rounded-md border p-3 text-xs sm:grid-cols-3'>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.routeNode')}
        </p>
        <p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p>
      </div>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.expectedRoute')}
        </p>
        <Badge variant='outline'>{routeName(expectedValue?.route)}</Badge>
      </div>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.actualRoute')}
        </p>
        <Badge variant='outline'>{routeName(actualValue?.route)}</Badge>
      </div>
    </div>
  );
}

export function NodeOutputCriterion({
  expected,
  actual,
  nodeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const rule = expected as Record<string, unknown>;
  const nodeId = stringValue(rule?.nodeId);
  return (
    <div className='bg-muted/30 mt-3 grid gap-3 rounded-md border p-3 text-xs sm:grid-cols-3'>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.outputNode')}
        </p>
        <p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p>
      </div>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.fieldPath')}
        </p>
        <p className='font-mono'>{stringValue(rule?.path)}</p>
      </div>
      <EvidenceValue label={t('evaluations.expected')} value={rule?.value} />
      <div className='sm:col-span-3'>
        <EvidenceValue label={t('evaluations.actual')} value={actual} />
      </div>
    </div>
  );
}

export function NodeTextCriterion({
  expected,
  actual,
  nodeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const rule = expected as Record<string, unknown>;
  const nodeId = stringValue(rule?.nodeId);
  return (
    <div className='bg-muted/30 mt-3 grid gap-3 rounded-md border p-3 text-xs sm:grid-cols-3'>
      <div>
        <p className='text-muted-foreground mb-1'>
          {t('evaluations.agentNode')}
        </p>
        <p className='font-medium'>{nodeNames[nodeId] ?? nodeId}</p>
      </div>
      <EvidenceValue label={t('evaluations.expectedText')} value={rule?.text} />
      <EvidenceValue label={t('evaluations.actual')} value={actual} />
    </div>
  );
}

export function nodeIds(value: unknown) {
  return Array.isArray(value)
    ? value.filter((node): node is string => typeof node === 'string')
    : [];
}

export function NodeBadges({
  ids,
  nodeNames,
}: {
  ids: string[];
  nodeNames: Record<string, string>;
}) {
  return (
    <div className='flex flex-wrap gap-1.5'>
      {ids.map((id) => (
        <Badge key={id} variant='outline'>
          {nodeNames[id] ?? id}
        </Badge>
      ))}
    </div>
  );
}

export function NodeTrajectoryCriterion({
  expected,
  actual,
  nodeNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const expectation = expected as Record<string, unknown>;
  const observation = actual as Record<string, unknown>;
  const required = nodeIds(expectation?.mustExecute);
  const forbidden = nodeIds(expectation?.mustNotExecute);
  const ordered = nodeIds(expectation?.orderedNodes);
  const executions = Array.isArray(observation?.nodeExecutions)
    ? observation.nodeExecutions
    : [];
  const failures = [
    ['missing', 'evaluations.missingNodes'],
    ['forbidden', 'evaluations.forbiddenNodesExecuted'],
    ['incomplete', 'evaluations.incompleteNodes'],
    ['outOfOrder', 'evaluations.outOfOrderNodes'],
  ] as const;

  return (
    <div className='mt-3 grid gap-3 text-xs'>
      <div className='bg-muted/30 grid gap-3 rounded-md border p-3'>
        {required.length || forbidden.length ? (
          <div className='grid gap-3 sm:grid-cols-2'>
            {required.length ? (
              <div>
                <p className='text-muted-foreground mb-1'>
                  {t('evaluations.requiredNodes')}
                </p>
                <NodeBadges ids={required} nodeNames={nodeNames} />
              </div>
            ) : null}
            {forbidden.length ? (
              <div>
                <p className='text-muted-foreground mb-1'>
                  {t('evaluations.forbiddenNodes')}
                </p>
                <NodeBadges ids={forbidden} nodeNames={nodeNames} />
              </div>
            ) : null}
          </div>
        ) : null}
        {required.length || forbidden.length ? (
          <div className='border-t' />
        ) : null}
        <div className='grid gap-3 sm:grid-cols-2'>
          <div>
            <p className='text-muted-foreground mb-1'>
              {t('evaluations.expectedNodePath')}
            </p>
            {ordered.length ? (
              <p>{ordered.map((id) => nodeNames[id] ?? id).join(' → ')}</p>
            ) : (
              <p className='text-muted-foreground'>
                {t('evaluations.noNodeOrder')}
              </p>
            )}
          </div>
          <div>
            <p className='text-muted-foreground mb-1'>
              {t('evaluations.actualNodePath')}
            </p>
            {executions.length ? (
              <div className='flex flex-wrap gap-1.5'>
                {executions.map((execution, index) => {
                  const item = execution as Record<string, unknown>;
                  const id = stringValue(item.nodeId);
                  return (
                    <Badge key={`${id}-${index}`} variant='outline'>
                      {nodeNames[id] ?? id}{' '}
                      {item.completed === true ? '✓' : '○'}
                    </Badge>
                  );
                })}
              </div>
            ) : (
              <p className='text-muted-foreground'>
                {t('evaluations.noNodeExecutions')}
              </p>
            )}
          </div>
        </div>
        {!required.length && !forbidden.length && !ordered.length ? (
          <p className='text-muted-foreground'>
            {t('evaluations.noNodeRules')}
          </p>
        ) : null}
      </div>
      {failures.flatMap(([key, translation]) => {
        const ids = nodeIds(observation?.[key]);
        return ids.length
          ? [
              <div
                key={key}
                className='text-destructive flex flex-wrap items-center gap-2'
              >
                <span>{t(translation)}:</span>
                <NodeBadges ids={ids} nodeNames={nodeNames} />
              </div>,
            ]
          : [];
      })}
    </div>
  );
}

export function ResultTrace({
  value,
  nodeNames,
  toolConfigured,
  nodeConfigured,
}: {
  value: unknown;
  nodeNames: Record<string, string>;
  toolConfigured: boolean;
  nodeConfigured: boolean;
}) {
  const { t } = useTranslation();
  const trace = value as
    | { toolUses?: unknown[]; nodeExecutions?: unknown[] }
    | undefined;
  const tools = Array.isArray(trace?.toolUses) ? trace.toolUses : [];
  const nodes = Array.isArray(trace?.nodeExecutions)
    ? trace.nodeExecutions
    : [];
  return (
    <div className='mt-3'>
      {nodes.length ? (
        <div className='mb-3 flex flex-wrap items-center gap-2'>
          {nodes.map((node, index) => {
            const item = node as Record<string, unknown>;
            return (
              <Badge
                key={`${stringValue(item.nodeId)}-${index}`}
                variant='outline'
              >
                {nodeNames[stringValue(item.nodeId)] ??
                  stringValue(item.nodeId)}{' '}
                {item.completed === true ? '✓' : '○'}
              </Badge>
            );
          })}
        </div>
      ) : null}
      {tools.length ? (
        <div className='flex flex-col gap-2'>
          {tools.map((tool, index) => (
            <pre
              key={index}
              className='bg-background overflow-auto rounded-lg border p-3 text-xs'
            >
              {JSON.stringify(tool, null, 2)}
            </pre>
          ))}
        </div>
      ) : !nodes.length ? (
        <p className='text-muted-foreground rounded-lg border border-dashed px-3 py-4 text-center text-sm'>
          {toolConfigured
            ? t('evaluations.noToolCallsConfigured')
            : nodeConfigured
              ? t('evaluations.noNodeExecutions')
              : t('evaluations.noExecutionEvidenceConfigured')}
        </p>
      ) : null}
    </div>
  );
}

export function hasToolTrajectoryAssertion(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some(
      (criterion) =>
        typeof criterion === 'object' &&
        criterion !== null &&
        stringValue(
          (criterion as Record<string, unknown>).criterion,
        ).startsWith('toolTrajectory:'),
    )
  );
}

export function hasNodeTrajectoryAssertion(value: unknown) {
  return (
    Array.isArray(value) &&
    value.some(
      (criterion) =>
        typeof criterion === 'object' &&
        criterion !== null &&
        stringValue(
          (criterion as Record<string, unknown>).criterion,
        ).startsWith('nodeTrajectory:'),
    )
  );
}

export function renderEvidence(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function criterionLabel(
  criterion: Record<string, unknown>,
  expectation?: unknown,
  t?: (key: string, options?: Record<string, unknown>) => string,
) {
  const id = stringValue(criterion.criterion);
  if (id.startsWith('jsonPath:')) {
    const path = (criterion.expected as Record<string, unknown> | undefined)
      ?.path;
    const legacyPath = Array.isArray(
      (expectation as Record<string, unknown> | undefined)?.assertions,
    )
      ? (
          (expectation as Record<string, unknown>).assertions as Array<
            Record<string, unknown>
          >
        ).find((assertion) => assertion.id === id.slice('jsonPath:'.length))
          ?.path
      : undefined;
    return typeof path === 'string'
      ? (t?.('evaluations.outputField', { path }) ?? `Output field ${path}`)
      : typeof legacyPath === 'string'
        ? (t?.('evaluations.outputField', { path: legacyPath }) ??
          `Output field ${legacyPath}`)
        : (t?.('evaluations.outputFieldAssertion') ?? 'Output field assertion');
  }
  if (id.startsWith('text:'))
    return t?.('evaluations.finalOutputText') ?? 'Final output text';
  if (id.startsWith('toolTrajectory:'))
    return t?.('evaluations.toolTrajectory') ?? 'Tool trajectory';
  if (id.startsWith('nodeTrajectory:'))
    return t?.('evaluations.nodeTrajectory') ?? 'Node path';
  if (id.startsWith('route:'))
    return t?.('evaluations.routeAssertions') ?? 'Route assertion';
  if (id.startsWith('nodeOutput:'))
    return t?.('evaluations.nodeOutputAssertions') ?? 'Node output assertion';
  if (id.startsWith('nodeText:'))
    return (
      t?.('evaluations.agentMessageAssertions') ?? 'Agent message assertion'
    );
  if (id.startsWith('nodeToolTrajectory:'))
    return t?.('evaluations.nodeToolAssertions') ?? 'Node tool assertion';
  if (id.startsWith('safety:'))
    return t?.('evaluations.safetyAssertions') ?? 'Safety assertion';
  return t?.('evaluations.assertion') ?? 'Assertion';
}
