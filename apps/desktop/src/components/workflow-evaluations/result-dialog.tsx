import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FieldDescription,
  FieldLegend,
  FieldSet,
} from '@workspace/ui/components';
import {
  CheckCircle2Icon,
  CircleAlertIcon,
  TestTubeDiagonalIcon,
  XCircleIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type {
  EvaluationCase,
  EvaluationCaseResult,
} from '@/services/evaluation';

import {
  hasNodeTrajectoryAssertion,
  hasToolTrajectoryAssertion,
  ResultCriteria,
  ResultJson,
  ResultMetric,
  ResultTrace,
  ResultValue,
} from './result-details';
import { formatCost, formatDuration } from './run-panel';
import { evaluationTraceToolNames } from './workflow-utils';

function ResultIcon({ verdict }: { verdict: EvaluationCaseResult['verdict'] }) {
  if (verdict === 'passed')
    return <CheckCircle2Icon className='size-4 text-emerald-500' />;
  if (verdict === 'failed')
    return <XCircleIcon className='text-destructive size-4' />;
  if (verdict === 'error')
    return <CircleAlertIcon className='size-4 text-amber-500' />;
  return <TestTubeDiagonalIcon className='text-muted-foreground size-4' />;
}

export function EvaluationResultDialog({
  result,
  cases,
  nodeNames,
  routeNames,
  toolNames,
  onOpenChange,
  onViewWorkflowRun,
}: {
  result?: EvaluationCaseResult;
  cases: EvaluationCase[];
  nodeNames: Record<string, string>;
  routeNames: Record<string, string>;
  toolNames: Record<string, string>;
  onOpenChange: (result?: EvaluationCaseResult) => void;
  onViewWorkflowRun: (runId: string) => void;
}) {
  const { t } = useTranslation();
  // The normalized trace is immutable with the evaluation run and retains the
  // display name emitted at execution time. Prefer it over the mutable catalog.
  const frozenToolNames = result
    ? { ...toolNames, ...evaluationTraceToolNames(result.normalizedTrace) }
    : toolNames;

  return (
    <Dialog
      open={Boolean(result)}
      onOpenChange={(open) => !open && onOpenChange(undefined)}
    >
      <DialogContent className='max-w-4xl! gap-0 overflow-hidden p-0'>
        <DialogHeader className='via-background relative overflow-hidden border-b bg-linear-to-br from-sky-500/12 to-violet-500/10 px-6 py-6 pr-14'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(214_90%_60%/0.16)_1px,transparent_1px)] bg-size-[14px_14px] opacity-70' />
          <div className='relative flex items-start gap-3'>
            <div className='bg-background/70 flex size-10 shrink-0 items-center justify-center rounded-xl border border-sky-500/20 text-sky-700 shadow-sm dark:text-sky-300'>
              <TestTubeDiagonalIcon className='size-5' />
            </div>
            <div className='min-w-0'>
              <DialogTitle className='text-lg'>
                {cases.find((item) => item.id === result?.evaluationCaseId)
                  ?.name ?? t('evaluations.evaluationResult')}
              </DialogTitle>
              <DialogDescription className='mt-1 max-w-xl leading-5'>
                {t('evaluations.resultSnapshotDescription')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className='max-h-[min(68vh,620px)] overflow-y-auto px-6 py-6'>
          {result ? (
            <div className='flex flex-col gap-4'>
              <div className='rounded-xl border border-violet-500/20 bg-violet-500/5 p-4'>
                <div className='mb-3 flex items-center gap-2'>
                  <ResultIcon verdict={result.verdict} />
                  <span className='text-sm font-medium'>
                    {t('evaluations.resultSummary')}
                  </span>
                </div>
                <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
                  <ResultMetric
                    label={t('evaluations.result')}
                    value={result.verdict}
                  />
                  <ResultMetric
                    label={t('evaluations.score')}
                    value={
                      result.score !== null && result.score !== undefined
                        ? `${Math.round(result.score * 100)}%`
                        : '—'
                    }
                  />
                  <ResultMetric
                    label={t('evaluations.duration')}
                    value={formatDuration(result.durationMs)}
                  />
                  <ResultMetric
                    label={t('evaluations.cost')}
                    value={formatCost(result.estimatedCostMicrousd)}
                  />
                </div>
              </div>
              {result.failureReason ? (
                <div className='border-destructive/30 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm'>
                  {result.failureReason}
                </div>
              ) : null}
              <FieldSet className='rounded-xl border p-4 sm:p-5'>
                <FieldLegend>{t('evaluations.actualOutput')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.actualOutputDescription')}
                </FieldDescription>
                <ResultValue value={result.actualOutput} />
              </FieldSet>
              <FieldSet className='rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 sm:p-5'>
                <FieldLegend>{t('evaluations.assertionVerdict')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.assertionVerdictDescription')}
                </FieldDescription>
                <ResultCriteria
                  value={result.criteriaResults}
                  expectation={
                    cases.find((item) => item.id === result.evaluationCaseId)
                      ?.expectation
                  }
                  nodeNames={nodeNames}
                  routeNames={routeNames}
                  toolNames={frozenToolNames}
                />
              </FieldSet>
              <FieldSet className='rounded-xl border border-sky-500/20 bg-sky-500/5 p-4 sm:p-5'>
                <FieldLegend>{t('evaluations.executionEvidence')}</FieldLegend>
                <FieldDescription>
                  {t('evaluations.traceDescription')}
                </FieldDescription>
                <ResultTrace
                  value={result.normalizedTrace}
                  nodeNames={nodeNames}
                  toolConfigured={hasToolTrajectoryAssertion(
                    result.criteriaResults,
                  )}
                  nodeConfigured={hasNodeTrajectoryAssertion(
                    result.criteriaResults,
                  )}
                  toolNames={frozenToolNames}
                />
              </FieldSet>
              {/* Keep raw evidence available for debugging without making it the primary reading path. */}
              <details className='rounded-lg border px-3 py-2 text-xs'>
                <summary className='cursor-pointer font-medium'>
                  {t('evaluations.viewRawEvidence')}
                </summary>
                <div className='mt-3 flex flex-col gap-3'>
                  <ResultJson
                    title={t('evaluations.criteriaJson')}
                    value={result.criteriaResults}
                  />
                  <ResultJson
                    title={t('evaluations.traceJson')}
                    value={result.normalizedTrace}
                  />
                </div>
              </details>
            </div>
          ) : null}
        </div>
        <DialogFooter className='mx-0 mb-0'>
          <DialogClose render={<Button variant='outline' />}>
            {t('common.close')}
          </DialogClose>
          {result?.workflowRunId ? (
            <DialogClose
              render={<Button />}
              onClick={() => {
                onViewWorkflowRun(result.workflowRunId!);
              }}
            >
              {t('evaluations.viewRunOutput')}
            </DialogClose>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
