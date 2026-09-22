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
  toolNames,
}: {
  comparison: EvaluationVersionCaseCriterionComparison;
  baselineLabel: string;
  candidateLabel: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
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
          {isToolTrajectoryCriterion(diff.key) ? (
            <VersionToolTrajectoryComparison
              baselineLabel={baselineLabel}
              candidateLabel={candidateLabel}
              baseline={diff.baseline}
              candidate={diff.candidate}
              nodeNames={nodeNames}
              toolNames={toolNames}
            />
          ) : (
            <div className='mt-3 grid grid-cols-2 items-start gap-2 text-xs'>
              <CriterionComparisonCell
                label={baselineLabel}
                outcome={diff.baseline}
                criterion={diff.key}
                nodeNames={nodeNames}
                routeNames={routeNames}
                toolNames={toolNames}
              />
              <CriterionComparisonCell
                label={candidateLabel}
                outcome={diff.candidate}
                criterion={diff.key}
                nodeNames={nodeNames}
                routeNames={routeNames}
                toolNames={toolNames}
              />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function isToolTrajectoryCriterion(criterion: string) {
  return (
    criterion.startsWith('toolTrajectory:') ||
    criterion.startsWith('nodeToolTrajectory:')
  );
}

function VersionToolTrajectoryComparison({
  baselineLabel,
  candidateLabel,
  baseline,
  candidate,
  nodeNames,
  toolNames,
}: {
  baselineLabel: string;
  candidateLabel: string;
  baseline?: EvaluationVersionCriterionDiff['baseline'];
  candidate?: EvaluationVersionCriterionDiff['candidate'];
  nodeNames: Record<string, string>;
  toolNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const expected = baseline?.expected ?? candidate?.expected;
  const expectedValue = expected as Record<string, unknown>;
  const nodeId = stringValue(expectedValue?.nodeId);
  const expectedTools = Array.isArray(expected)
    ? expected
    : Array.isArray(expectedValue?.tools)
      ? expectedValue.tools
      : [];
  const baselineActual = baseline?.actual as Record<string, unknown> | undefined;
  const candidateActual = candidate?.actual as Record<string, unknown> | undefined;
  const baselineTools = Array.isArray(baselineActual?.toolUses)
    ? baselineActual.toolUses
    : [];
  const candidateTools = Array.isArray(candidateActual?.toolUses)
    ? candidateActual.toolUses
    : [];
  const callCount = Math.max(
    expectedTools.length,
    baselineTools.length,
    candidateTools.length,
  );

  return (
    <div className='mt-3 grid gap-3 text-xs'>
      <div className='flex items-center justify-between gap-3'>
        <p className='text-muted-foreground font-medium'>
          {nodeId
            ? `${t('evaluations.agentNode')} · ${nodeNames[nodeId] ?? nodeId}`
            : t('evaluations.toolTrajectory')}
        </p>
        <span className='text-muted-foreground shrink-0'>
          {callCount} {t('evaluations.callCount')}
        </span>
      </div>
      {Array.from({ length: callCount }, (_, index) => (
        <div key={index} className='bg-background/50 rounded-md border'>
          <div className='flex items-center gap-2 border-b bg-muted/30 px-3 py-2'>
            <span className='text-muted-foreground font-mono'>#{index + 1}</span>
            <span className='font-medium'>
              {toolDisplayName(
                expectedTools[index] ?? baselineTools[index] ?? candidateTools[index],
                toolNames,
                t('evaluations.tool'),
              )}
            </span>
          </div>
          <div className='p-3'>
            <p className='text-muted-foreground mb-1.5 font-medium'>
              {t('evaluations.expected')}
            </p>
            <ToolCallSnapshot
              tool={expectedTools[index]}
              emptyLabel={t('evaluations.noExpectedToolCalls')}
            />
          </div>
          <div className='grid grid-cols-2 gap-3 border-t p-3'>
            <VersionToolTrajectoryOutcome
              label={baselineLabel}
              outcome={baseline}
              tool={baselineTools[index]}
            />
            <VersionToolTrajectoryOutcome
              label={candidateLabel}
              outcome={candidate}
              tool={candidateTools[index]}
            />
          </div>
        </div>
      ))}
      {!callCount ? (
        <p className='text-muted-foreground rounded-md border border-dashed px-3 py-4 text-center'>
          {t('evaluations.noExpectedToolCalls')}
        </p>
      ) : null}
    </div>
  );
}

function ToolCallSnapshot({
  tool,
  emptyLabel,
}: {
  tool: unknown;
  emptyLabel: string;
}) {
  const { t } = useTranslation();
  if (!tool) {
    return (
      <div className='text-muted-foreground flex min-w-0 items-center py-1 italic'>
        {emptyLabel}
      </div>
    );
  }
  const item = tool as Record<string, unknown>;
  const result = toolResult(item);
  return (
    <div className='min-w-0'>
      <div className='grid grid-cols-2 gap-2'>
        <ToolValue label={t('evaluations.toolArguments')} value={item.args} />
        <ToolValue label={t('evaluations.toolResults')} value={result.value} />
      </div>
    </div>
  );
}

function ToolValue({ label, value }: { label: string; value: unknown }) {
  const text =
    value === null || value === undefined ? '—' : JSON.stringify(value, null, 2);
  return (
    <div className='min-w-0'>
      <p className='text-muted-foreground mb-1 font-medium'>{label}</p>
      <pre className='bg-muted/60 max-h-32 overflow-y-auto overflow-x-hidden rounded px-2 py-1.5 font-mono text-[11px] leading-5 wrap-break-word whitespace-pre-wrap'>
        {text}
      </pre>
    </div>
  );
}

function VersionToolTrajectoryOutcome({
  label,
  outcome,
  tool,
}: {
  label: string;
  outcome?: EvaluationVersionCriterionDiff['baseline'];
  tool: unknown;
}) {
  const { t } = useTranslation();
  const actual = outcome?.actual as Record<string, unknown> | undefined;
  return (
    <div className='min-w-0'>
      <div className='mb-1.5 flex items-center justify-between gap-2'>
        <p className='text-muted-foreground truncate font-medium'>{label}</p>
        <span
          className={
            outcome == null
              ? 'text-muted-foreground shrink-0'
              : outcome.passed
                ? 'shrink-0 text-emerald-600 dark:text-emerald-400'
                : 'text-destructive shrink-0'
          }
        >
          {outcome == null
            ? t('evaluations.assertionNotPresent')
            : outcome.passed
              ? t('evaluations.assertionPassed')
              : t('evaluations.assertionFailed')}
        </span>
      </div>
      <ToolCallSnapshot
        tool={tool}
        emptyLabel={t('evaluations.assertionNotPresent')}
      />
      {(['missing', 'extra', 'responseMismatches'] as const).flatMap((key) =>
        Array.isArray(actual?.[key]) && actual[key].length
          ? [
              <div key={key} className='mt-2'>
                <EvidenceValue label={t(`evaluations.${key}`)} value={actual[key]} />
              </div>,
            ]
          : [],
      )}
    </div>
  );
}

function toolDisplayName(
  tool: unknown,
  toolNames: Record<string, string>,
  fallback: string,
) {
  const name = stringValue(
    (tool as Record<string, unknown> | undefined)?.name,
  );
  return (toolNames[name] ?? name) || fallback;
}

export function CriterionComparisonCell({
  label,
  outcome,
  criterion,
  nodeNames,
  routeNames,
  toolNames,
}: {
  label: string;
  outcome?: EvaluationVersionCriterionDiff['baseline'];
  criterion: string;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  return (
    <div className='bg-background/70 min-w-0 rounded-md border px-2.5 py-2'>
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
          toolNames={toolNames}
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
  toolNames,
}: {
  criterion: string;
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  if (
    criterion.startsWith('toolTrajectory:') ||
    criterion.startsWith('nodeToolTrajectory:')
  ) {
    return (
      <ToolTrajectoryCriterion
        expected={expected}
        actual={actual}
        nodeNames={nodeNames}
        toolNames={toolNames}
      />
    );
  }
  if (criterion.startsWith('safety:')) {
    return <SafetyCriterion expected={expected} actual={actual} />;
  }
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
      <ReadableValue value={actual} />
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
  } else {
    evidence = <ReadableValue value={actual} />;
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
    <div className='bg-muted mt-3 max-h-48 overflow-auto rounded-lg p-3 text-sm leading-5'>
      <ReadableValue value={typeof text === 'string' ? text : value} />
    </div>
  );
}

export function ResultCriteria({
  value,
  expectation,
  nodeNames,
  routeNames,
  toolNames,
}: {
  value: unknown;
  expectation?: unknown;
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
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
            ) : stringValue(item.criterion).startsWith('toolTrajectory:') ||
              stringValue(item.criterion).startsWith('nodeToolTrajectory:') ? (
              <ToolTrajectoryCriterion
                expected={item.expected}
                actual={item.actual}
                nodeNames={nodeNames}
                toolNames={toolNames}
              />
            ) : stringValue(item.criterion).startsWith('safety:') ? (
              <SafetyCriterion expected={item.expected} actual={item.actual} />
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
      <div className='bg-muted/60 max-h-36 overflow-y-auto overflow-x-hidden rounded px-2 py-1.5 leading-5'>
        <ReadableValue value={value} />
      </div>
    </div>
  );
}

function ReadableValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className='text-muted-foreground'>—</span>;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return (
      <span className='wrap-break-word whitespace-pre-wrap'>
        {String(value)}
      </span>
    );
  }
  if (Array.isArray(value)) {
    return value.length ? (
      <div className='flex flex-wrap gap-1.5'>
        {value.map((item, index) => (
          <Badge
            key={index}
            variant='outline'
            className='max-w-full wrap-break-word whitespace-normal'
          >
            {typeof item === 'object' && item !== null
              ? `${Object.keys(item as Record<string, unknown>).length} ${Object.keys(item as Record<string, unknown>).length === 1 ? 'field' : 'fields'}`
              : String(item)}
          </Badge>
        ))}
      </div>
    ) : (
      <span className='text-muted-foreground'>—</span>
    );
  }
  return (
    <pre className='font-mono text-[11px] leading-5 wrap-break-word whitespace-pre-wrap'>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function toolResult(item: Record<string, unknown>) {
  // Evaluation snapshots renamed this field over time. Keeping the lookup in
  // one place ensures the comparison table and regular result view agree.
  const key = [
    'result',
    'output',
    'response',
    'expectedResponse',
    'expected_response',
  ].find((candidate) => candidate in item);
  return {
    hasResult: key !== undefined,
    value: key === undefined ? undefined : item[key],
  };
}

function ToolUseList({
  tools,
  emptyLabel,
  toolNames = {},
}: {
  tools: unknown[];
  emptyLabel?: string;
  toolNames?: Record<string, string>;
}) {
  const { t } = useTranslation();
  if (!tools.length)
    return (
      <p className='text-muted-foreground'>
        {emptyLabel ?? t('evaluations.noToolCallsConfigured')}
      </p>
    );
  return (
    <div className='grid content-start gap-2'>
      {tools.map((tool, index) => {
        const item = tool as Record<string, unknown>;
        const result = toolResult(item);
        return (
          <div
            key={`${stringValue(item.name)}-${index}`}
            className='bg-background min-w-0 rounded-md border p-2.5'
          >
            <p className='font-medium'>
              {toolNames[stringValue(item.name)] ??
                (stringValue(item.name) || t('evaluations.tool'))}
            </p>
            <div
              className={
                result.hasResult
                  ? 'mt-2 grid grid-cols-2 gap-2'
                  : 'mt-2 grid gap-2'
              }
            >
              <EvidenceValue
                label={t('evaluations.toolArguments')}
                value={item.args}
              />
              {result.hasResult ? (
                <EvidenceValue
                  label={t('evaluations.toolResults')}
                  value={result.value}
                />
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ToolTrajectoryCriterion({
  expected,
  actual,
  nodeNames,
  toolNames,
}: {
  expected: unknown;
  actual: unknown;
  nodeNames: Record<string, string>;
  toolNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const wanted = expected as Record<string, unknown>;
  const observed = actual as Record<string, unknown>;
  const nodeId = stringValue(wanted?.nodeId || observed?.nodeId);
  // Top-level trajectory scoring stores `expected` as ToolUse[], whereas a
  // node-scoped trajectory wraps the same list in `{ nodeId, tools }`.
  const expectedTools = Array.isArray(expected)
    ? expected
    : Array.isArray(wanted?.tools)
      ? wanted.tools
      : [];
  const actualTools = Array.isArray(observed?.toolUses)
    ? observed.toolUses
    : [];
  return (
    <div className='mt-3 grid content-start gap-3 text-xs'>
      {nodeId ? (
        <p className='text-muted-foreground'>
          {t('evaluations.agentNode')}:{' '}
          <span className='text-foreground font-medium'>
            {nodeNames[nodeId] ?? nodeId}
          </span>
        </p>
      ) : null}
      <div className='grid grid-cols-2 items-start gap-3'>
        <div className='min-w-0'>
          <p className='text-muted-foreground mb-1 font-medium'>
            {t('evaluations.expected')}
          </p>
          <ToolUseList
            tools={expectedTools}
            emptyLabel={t('evaluations.noExpectedToolCalls')}
            toolNames={toolNames}
          />
        </div>
        <div className='min-w-0'>
          <p className='text-muted-foreground mb-1 font-medium'>
            {t('evaluations.actual')}
          </p>
          <ToolUseList
            tools={actualTools}
            emptyLabel={t('evaluations.noToolCallsConfigured')}
            toolNames={toolNames}
          />
        </div>
      </div>
      {(['missing', 'extra', 'responseMismatches'] as const).flatMap((key) =>
        Array.isArray(observed?.[key]) && observed[key].length
          ? [
              <EvidenceValue
                key={key}
                label={t(`evaluations.${key}`)}
                value={observed[key]}
              />,
            ]
          : [],
      )}
    </div>
  );
}

function SafetyCriterion({
  expected,
  actual,
}: {
  expected: unknown;
  actual: unknown;
}) {
  const { t } = useTranslation();
  const rule = expected as Record<string, unknown>;
  const evidence = actual as Record<string, unknown>;
  const target = stringValue(rule?.target);
  const targetLabel =
    target === 'tool_arguments'
      ? t('evaluations.toolArguments')
      : target === 'tool_results'
        ? t('evaluations.toolResults')
        : t('evaluations.finalOutput');
  return (
    <div className='mt-3 grid gap-2 text-xs sm:grid-cols-2'>
      <EvidenceValue label={t('evaluations.checkTarget')} value={targetLabel} />
      <EvidenceValue
        label={t('evaluations.forbiddenFieldPaths')}
        value={rule?.fieldPaths}
      />
      <EvidenceValue
        label={t('evaluations.forbiddenText')}
        value={rule?.forbiddenText}
      />
      <EvidenceValue
        label={t('evaluations.detectedSafetyIssues')}
        value={[
          ...(Array.isArray(evidence?.presentFields)
            ? evidence.presentFields
            : []),
          ...(Array.isArray(evidence?.forbiddenMatches)
            ? evidence.forbiddenMatches
            : []),
        ]}
      />
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
  toolNames,
}: {
  value: unknown;
  nodeNames: Record<string, string>;
  toolConfigured: boolean;
  nodeConfigured: boolean;
  toolNames: Record<string, string>;
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
        <ToolUseList tools={tools} toolNames={toolNames} />
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
