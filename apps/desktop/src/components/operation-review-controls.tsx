import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  FieldGroup,
  FieldLabel,
  Textarea,
} from '@workspace/ui/components';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  approveWorkflowCompensation,
  reviewWorkflowOperation,
  type ExecutionHistory,
  type OperationReviewDecision,
} from '@/services/run-history';

type Operation = ExecutionHistory['operations'][number];

export function OperationReviewControls({
  operation,
  runId,
  canReview,
  canApprove,
  onChanged,
}: {
  operation: Operation;
  runId: string;
  canReview: boolean;
  canApprove: boolean;
  onChanged: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState('');
  const [receipt, setReceipt] = useState('');
  const [stopped, setStopped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approval = operation.approval;
  const needsApproval = approval?.status === 'pending';
  const reviewable =
    canReview &&
    operation.dispatched &&
    ['unknown', 'failed'].includes(operation.status) &&
    operation.adapter !== 'subworkflow';
  if (!reviewable && !needsApproval) return null;
  const apply = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await onChanged();
      setOpen(false);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  const resolve = (completed: boolean) => {
    void apply(async () => {
      if (completed) {
        try {
          JSON.parse(receipt);
        } catch {
          throw new Error(t('executionRecovery.invalidJson'));
        }
      }
      const decision: OperationReviewDecision = completed
        ? { kind: 'completed', result: JSON.parse(receipt) }
        : { kind: 'no_effect' };
      await reviewWorkflowOperation({
        runId,
        operationId: operation.id,
        expectedAttempt: operation.attempts.at(-1)?.sequence ?? 0,
        stoppedConfirmed: stopped,
        evidence,
        decision,
      });
    });
  };
  const receiptHint =
    operation.purpose === 'compensation'
      ? t('executionRecovery.hintCompensation')
      : operation.adapter === 'remote_agent'
        ? t('executionRecovery.hintRemote', {
            example: '{"response":"…","artifacts":[]}',
          })
        : operation.adapter === 'process'
          ? t('executionRecovery.hintProcess', {
              example: '{"exitCode":0,"result":{…}}',
            })
          : t('executionRecovery.hintTool');
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          setOpen(next);
          setError('');
        }
      }}
    >
      <DialogTrigger
        render={<Button variant='outline' size='sm' />}
        disabled={needsApproval ? !canApprove : !canReview}
      >
        {needsApproval
          ? t('executionRecovery.reviewApproval')
          : t('executionRecovery.reconcile')}
      </DialogTrigger>
      <DialogContent className='sm:max-w-lg' showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {needsApproval
              ? t('executionRecovery.approveTitle', {
                  name: approval.targetName,
                })
              : t('executionRecovery.reconcileTitle')}
          </DialogTitle>
          <DialogDescription>
            {needsApproval
              ? t('executionRecovery.approvalDescription')
              : t('executionRecovery.reviewDescription')}
          </DialogDescription>
        </DialogHeader>
        {needsApproval ? (
          <pre className='max-h-64 overflow-auto break-all whitespace-pre-wrap'>
            {approval.arguments == null
              ? t('executionRecovery.argumentsUnavailable')
              : JSON.stringify(approval.arguments, null, 2)}
          </pre>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-evidence`}>
                {t('executionRecovery.evidence')}
              </FieldLabel>
              <Textarea
                id={`${id}-evidence`}
                value={evidence}
                onChange={(event) => setEvidence(event.target.value)}
                disabled={busy}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-receipt`}>
                {t('executionRecovery.result')}
              </FieldLabel>
              <Textarea
                id={`${id}-receipt`}
                value={receipt}
                onChange={(event) => setReceipt(event.target.value)}
                placeholder={receiptHint}
                disabled={busy}
              />
            </Field>
            <Field orientation='horizontal'>
              <Checkbox
                id={`${id}-stopped`}
                checked={stopped}
                onCheckedChange={setStopped}
                disabled={busy}
              />
              <FieldLabel htmlFor={`${id}-stopped`}>
                {t('executionRecovery.stopped')}
              </FieldLabel>
            </Field>
          </FieldGroup>
        )}
        {error ? (
          <p role='alert' className='text-destructive break-words'>
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {needsApproval ? (
            <>
              <Button
                variant='outline'
                disabled={busy || !canApprove}
                onClick={() =>
                  void apply(() =>
                    approveWorkflowCompensation(runId, approval.id, false),
                  )
                }
              >
                {t('executionRecovery.deny')}
              </Button>
              <Button
                disabled={busy || !canApprove || approval.arguments == null}
                onClick={() =>
                  void apply(() =>
                    approveWorkflowCompensation(runId, approval.id, true),
                  )
                }
              >
                {t('executionRecovery.approveOnce')}
              </Button>
            </>
          ) : (
            <>
              <Button
                variant='outline'
                disabled={busy || !stopped || !evidence.trim() || !canReview}
                onClick={() => resolve(false)}
              >
                {t('executionRecovery.noEffect')}
              </Button>
              <Button
                disabled={
                  busy ||
                  !stopped ||
                  !evidence.trim() ||
                  !receipt.trim() ||
                  !canReview
                }
                onClick={() => resolve(true)}
              >
                {t('executionRecovery.recordCompleted')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
