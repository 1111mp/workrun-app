import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ScrollArea,
} from '@workspace/ui/components';

import { OperationReviewControls } from '@/components/operation-review-controls';
import type { ExecutionHistory } from '@/services/run-history';

function statusLabel(status: string) {
  return status === 'unknown' ? 'Awaiting confirmation' : status;
}

function operationLabel(path: string) {
  try {
    const parts: unknown = JSON.parse(path);
    if (Array.isArray(parts) && typeof parts[1] === 'string') return parts[1];
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
}: {
  history?: ExecutionHistory;
  runId?: string;
  inactive?: boolean;
  onChanged?: () => Promise<void>;
}) {
  if (!history) return null;
  const unknownCount = history.operations.filter(
    (operation) => operation.status === 'unknown',
  ).length;
  return (
    <Collapsible className='px-6 py-3'>
      <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
        Execution history · {history.attempts.length} attempts
      </CollapsibleTrigger>
      {unknownCount > 0 ? (
        <Badge variant='outline'>{unknownCount} awaiting confirmation</Badge>
      ) : null}
      <CollapsibleContent>
        <ScrollArea className='h-64'>
          <div className='flex flex-col gap-3 py-3 text-sm'>
            {history.compensation ? (
              <div className='flex flex-col gap-1'>
                <p>
                  Compensation: {history.compensation.status} ·{' '}
                  {history.compensation.completed}/{history.compensation.total}
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
                Recovery: {history.recovery.status}
                {history.recovery.status === 'pending'
                  ? ` · next check ${new Date(history.recovery.nextCheckAt).toLocaleString()}`
                  : ''}
                {history.recovery.lastError
                  ? ` · ${history.recovery.lastError}`
                  : ''}
              </p>
            ) : null}
            {history.attempts.map((attempt) => (
              <div key={attempt.sequence} className='flex flex-col gap-1'>
                <div className='flex items-center gap-2'>
                  <span>Attempt {attempt.sequence}</span>
                  <Badge variant='outline'>{statusLabel(attempt.status)}</Badge>
                  <span className='text-muted-foreground text-xs'>
                    {new Date(attempt.startedAt).toLocaleString()}
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
                      ? 'Compensation attempt'
                      : operationLabel(operation.path)}
                  </span>
                  <Badge variant='outline'>
                    {statusLabel(operation.status)}
                  </Badge>
                </div>
                <span className='text-muted-foreground text-xs break-all'>
                  Operation {operation.id}
                </span>
                {operation.review ? (
                  <p className='text-muted-foreground'>
                    Reconciled attempt #{operation.review.attemptSequence}:{' '}
                    {operation.review.decision}
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
                    Compensation: {operation.compensation.mode} ·{' '}
                    {operation.compensation.status}
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
                    #{attempt.sequence} · {attempt.action} ·{' '}
                    {statusLabel(attempt.status)}
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
