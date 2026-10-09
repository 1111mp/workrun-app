import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@workspace/ui/components';
import type { Node } from '@xyflow/react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { RunExecutionHistory } from '@/components/run-execution-history';
import {
  abandonWorkflowRun,
  inspectRunRecord,
  retryWorkflowCompensation,
} from '@/services/run-history';
import { recoverInterruptedWorkflowRun } from '@/services/workflow';

/** Operation facts and review stay next to the graph output they explain. */
export function RunOperationPanel({
  runId,
  nodes,
}: {
  runId?: string;
  nodes: Node[];
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [abandonOpen, setAbandonOpen] = useState(false);
  const query = useQuery({
    queryKey: ['run-operation-history', runId],
    queryFn: () => inspectRunRecord(runId!),
    enabled: !!runId,
    refetchInterval: (query) => {
      const run = query.state.data;
      return run &&
        (['queued', 'running', 'waiting_for_input'].includes(run.status) ||
          ['pending', 'running'].includes(
            run.executionHistory?.compensation?.status ?? '',
          ))
        ? 3000
        : false;
    },
  });
  const record = query.data;
  const refresh = async () => {
    const result = await query.refetch();
    if (result.error) throw result.error;
  };
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setAbandonOpen(false);
      await refresh();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  if (!runId) return null;
  if (!record)
    return (
      <div className='px-6 py-3 text-sm'>
        {query.error ? (
          <>
            <p role='alert'>
              {t('workflowEditor.output.operationLoadFailed')}：
              {String(query.error)}
            </p>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void query.refetch()}
            >
              {t('workflowEditor.output.operationReload')}
            </Button>
          </>
        ) : (
          t('workflowEditor.output.operationLoading')
        )}
      </div>
    );
  const plan = record.executionHistory?.compensation;
  if (plan?.automatic) return null;
  const inactive = !['queued', 'running', 'waiting_for_input'].includes(
    record.status,
  );
  return (
    <div className='border-t'>
      <RunExecutionHistory
        runId={runId}
        history={record.executionHistory}
        inactive={inactive}
        onChanged={refresh}
        nodeNames={Object.fromEntries(
          nodes.map((node) => [
            node.id,
            typeof node.data.name === 'string' ? node.data.name : node.id,
          ]),
        )}
      />
      <div className='flex flex-wrap items-center gap-2 px-6 pb-3'>
        {!plan && record.status === 'interrupted' ? (
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() =>
              void action(() => recoverInterruptedWorkflowRun(runId))
            }
          >
            {t('workflowEditor.output.continueTask')}
          </Button>
        ) : null}
        {!plan ? (
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() => setAbandonOpen(true)}
          >
            {t('workflowEditor.output.abandonCompensate')}
          </Button>
        ) : null}
        {plan?.status === 'blocked' ? (
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={() => void action(() => retryWorkflowCompensation(runId))}
          >
            {t('workflowEditor.output.retryCompensation')}
          </Button>
        ) : null}
        {error ? (
          <p role='alert' className='text-destructive break-words'>
            {error}
          </p>
        ) : null}
      </div>
      <Dialog
        open={abandonOpen}
        onOpenChange={(open) => {
          if (!busy) setAbandonOpen(open);
        }}
      >
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{t('workflowEditor.output.abandonTitle')}</DialogTitle>
            <DialogDescription>
              {t('workflowEditor.output.abandonDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant='outline'
              disabled={busy}
              onClick={() => setAbandonOpen(false)}
            >
              {t('workflowEditor.output.cancelAction')}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void action(() => abandonWorkflowRun(runId))}
            >
              {t('workflowEditor.output.abandonCompensate')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
