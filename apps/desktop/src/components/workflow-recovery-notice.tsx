import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Spinner,
} from '@workspace/ui/components';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { dismissRunRecovery, inspectRunRecord } from '@/services/run-history';
import { recoverInterruptedWorkflowRun } from '@/services/workflow';
import { useWorkrunStore } from '@/stores';

/** Recovery belongs to the original run; never fall back to replay on error. */
export function WorkflowRecoveryNotice({ runId }: { runId?: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const workspace = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );
  const record = useQuery({
    queryKey: ['run-history', 'recovery-state', workspace, runId],
    queryFn: () => inspectRunRecord(runId!),
    enabled: Boolean(runId),
  });
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string>();
  if (record.isError && !record.data)
    return (
      <Alert variant='destructive' className='mx-4 my-2 w-auto'>
        <AlertTitle>{t('executionRecovery.loadFailed')}</AlertTitle>
        <AlertDescription>
          {record.error instanceof Error
            ? record.error.message
            : String(record.error)}
          <Button variant='outline' onClick={() => void record.refetch()}>
            {t('approval.cards.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!record.data || record.data.status !== 'interrupted') return null;
  const run = record.data;
  const job = run.executionHistory?.recovery;
  const compensation = run.executionHistory?.compensation;
  const dismissed =
    (run.runtime as Record<string, unknown> | null)?.recoveryDismissed === true;
  const automatic =
    !dismissed && (job?.status === 'pending' || job?.status === 'running');
  const recover = async (dismiss = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(undefined);
    try {
      if (dismiss) await dismissRunRecovery(run.id);
      else await recoverInterruptedWorkflowRun(run.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
      await client.invalidateQueries({ queryKey: ['run-history'] });
    }
  };
  return (
    <Alert className='mx-4 my-2 w-auto'>
      <AlertTitle>
        {t(
          dismissed
            ? 'executionRecovery.dismissed'
            : automatic
              ? 'executionRecovery.confirmingRemote'
              : 'executionRecovery.awaitingRecovery',
        )}
      </AlertTitle>
      <AlertDescription>
        <p>
          {t(
            automatic
              ? 'executionRecovery.remoteDescription'
              : 'executionRecovery.interruptedDescription',
          )}
        </p>
        {(error || job?.lastError || run.error) && (
          <p role='status'>{error || job?.lastError || run.error}</p>
        )}
        {compensation ? (
          <p>{t('executionRecovery.compensationBlocksRecovery')}</p>
        ) : run.targetType !== 'workflow' ? (
          <p>{t('executionRecovery.appRecoveryUnsupported')}</p>
        ) : null}
        <div className='flex flex-wrap gap-2'>
          {run.targetType === 'workflow' && !compensation && !dismissed && (
            <Button disabled={busy || automatic} onClick={() => void recover()}>
              {(busy || automatic) && <Spinner data-icon='inline-start' />}
              {t('executionRecovery.tryRecover')}
            </Button>
          )}
          {!automatic && !dismissed && (
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => void recover(true)}
            >
              {t('executionRecovery.dismiss')}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
