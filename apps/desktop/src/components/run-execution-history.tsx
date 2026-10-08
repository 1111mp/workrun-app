import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
} from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import { OperationReviewControls } from '@/components/operation-review-controls';
import type { ExecutionHistory } from '@/services/run-history';

function operationLabel(path: string, nodeNames: Record<string, string>) {
  try {
    const parts: unknown = JSON.parse(path);
    if (Array.isArray(parts) && typeof parts[1] === 'string')
      return nodeNames[parts[1]] ?? parts[1];
  } catch {
    // Legacy paths remain readable even when they predate structured identity.
  }
  return path;
}

export function RunExecutionHistory({
  history,
  runId,
  inactive,
  onChanged,
  nodeNames = {},
}: {
  history?: ExecutionHistory;
  nodeNames?: Record<string, string>;
  runId?: string;
  inactive?: boolean;
  onChanged?: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const statusLabel = (status: string) =>
    t(`executionRecovery.status.${status}`, { defaultValue: status });
  const dateLabel = (date: string) =>
    new Date(date).toLocaleString(i18n.resolvedLanguage ?? i18n.language);
  if (!history || history.compensation?.automatic) return null;
  const unknownCount = history.operations.filter(
    (operation) => operation.status === 'unknown',
  ).length;
  return (
    <Collapsible
      className='px-6 py-3'
      defaultOpen={
        unknownCount > 0 ||
        history.operations.some(
          (operation) => operation.approval?.status === 'pending',
        )
      }
    >
      <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
        {t('executionRecovery.historyTitle', {
          count: history.attempts.length,
        })}
      </CollapsibleTrigger>
      {unknownCount > 0 ? (
        <Badge variant='outline'>
          {t('executionRecovery.awaitingCount', { count: unknownCount })}
        </Badge>
      ) : null}
      <CollapsibleContent>
        <ScrollArea className='h-64'>
          <div className='flex flex-col gap-3 py-3 text-sm'>
            {history.compensation ? (
              <div className='flex flex-col gap-1'>
                <p>
                  {t('executionRecovery.compensationProgress', {
                    status: statusLabel(history.compensation.status),
                    completed: history.compensation.completed,
                    total: history.compensation.total,
                  })}
                </p>
                {history.compensation.lastError ? (
                  <p className='text-muted-foreground break-words'>
                    {history.compensation.lastError}
                  </p>
                ) : null}
              </div>
            ) : null}
            {history.recovery && history.recovery.status !== 'done' ? (
              <p className='text-muted-foreground'>
                {t('executionRecovery.recovery', {
                  status: statusLabel(history.recovery.status),
                })}
                {history.recovery.status === 'pending'
                  ? ` · ${t('executionRecovery.nextCheck', { time: dateLabel(history.recovery.nextCheckAt) })}`
                  : ''}
                {history.recovery.lastError
                  ? ` · ${history.recovery.lastError}`
                  : ''}
              </p>
            ) : null}
            {history.attempts.map((attempt) => (
              <div key={attempt.sequence} className='flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <span>
                    {t('executionRecovery.attempt', {
                      sequence: attempt.sequence,
                    })}
                  </span>
                  <Badge variant='outline'>{statusLabel(attempt.status)}</Badge>
                  <span className='text-muted-foreground text-xs'>
                    {dateLabel(attempt.startedAt)}
                  </span>
                </div>
                {attempt.error ? (
                  <p className='text-muted-foreground break-words'>
                    {attempt.error}
                  </p>
                ) : null}
              </div>
            ))}
            {history.operations.map((operation) => (
              <div key={operation.id} className='flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <span>
                    {operation.purpose === 'compensation'
                      ? t('executionRecovery.compensationAttempt')
                      : operationLabel(operation.path, nodeNames)}
                  </span>
                  <Badge variant='outline'>
                    {statusLabel(operation.status)}
                  </Badge>
                </div>
                <span className='text-muted-foreground text-xs break-all'>
                  {t('executionRecovery.operation', { id: operation.id })}
                </span>
                {operation.review ? (
                  <p className='text-muted-foreground'>
                    {t('executionRecovery.reviewSummary', {
                      sequence: operation.review.attemptSequence,
                      decision: t(
                        `executionRecovery.decision.${operation.review.decision}`,
                        { defaultValue: operation.review.decision },
                      ),
                    })}
                  </p>
                ) : null}
                {runId && onChanged ? (
                  <OperationReviewControls
                    operation={operation}
                    runId={runId}
                    canReview={
                      !!inactive &&
                      (!history.compensation ||
                        history.compensation.status === 'blocked' ||
                        history.compensation.status === 'completed')
                    }
                    canApprove={
                      !!inactive && history.compensation?.status === 'blocked'
                    }
                    onChanged={onChanged}
                  />
                ) : null}
                {operation.compensation ? (
                  <p className='text-muted-foreground break-words'>
                    {t('executionRecovery.compensationSummary', {
                      mode: t(
                        `executionRecovery.mode.${operation.compensation.mode}`,
                        { defaultValue: operation.compensation.mode },
                      ),
                      status: statusLabel(operation.compensation.status),
                    })}
                    {operation.compensation.lastError
                      ? ` · ${operation.compensation.lastError}`
                      : ''}
                  </p>
                ) : null}
                {operation.attempts.map((attempt) => (
                  <p
                    key={attempt.sequence}
                    className='text-muted-foreground break-words'
                  >
                    #{attempt.sequence} ·{' '}
                    {t(`executionRecovery.action.${attempt.action}`, {
                      defaultValue: attempt.action,
                    })}{' '}
                    · {statusLabel(attempt.status)}
                    {attempt.errorSummary ? ` · ${attempt.errorSummary}` : ''}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </ScrollArea>
      </CollapsibleContent>
    </Collapsible>
  );
}
