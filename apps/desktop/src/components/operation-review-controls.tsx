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
      ? 'Result of the completed compensation (JSON).'
      : operation.adapter === 'remote_agent'
        ? 'Remote receipt: {"response":"…","artifacts":[]}.'
        : operation.adapter === 'process'
          ? 'Process receipt: {"exitCode":0,"result":{…}}.'
          : 'Original tool result (JSON).';
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
        {needsApproval ? 'Review compensation approval' : 'Reconcile outcome'}
      </DialogTrigger>
      <DialogContent className='sm:max-w-lg' showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>
            {needsApproval
              ? `Approve ${approval.targetName}`
              : 'Reconcile operation outcome'}
          </DialogTitle>
          <DialogDescription>
            {needsApproval
              ? 'Approve one dispatch with the original frozen arguments shown below. Denying keeps this compensation blocked.'
              : 'Check the provider or resources first. Record evidence only after related execution has stopped. Confirming no effect permits a new submission when this operation is continued.'}
          </DialogDescription>
        </DialogHeader>
        {needsApproval ? (
          <pre className='max-h-64 overflow-auto break-all whitespace-pre-wrap'>
            {approval.arguments == null
              ? 'Frozen arguments are unavailable; approval is disabled.'
              : JSON.stringify(approval.arguments, null, 2)}
          </pre>
        ) : (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`${id}-evidence`}>
                Reconciliation evidence
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
                Completed result (JSON)
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
                I have confirmed all related execution has stopped.
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
                Deny
              </Button>
              <Button
                disabled={busy || !canApprove || approval.arguments == null}
                onClick={() =>
                  void apply(() =>
                    approveWorkflowCompensation(runId, approval.id, true),
                  )
                }
              >
                Approve once
              </Button>
            </>
          ) : (
            <>
              <Button
                variant='outline'
                disabled={busy || !stopped || !evidence.trim() || !canReview}
                onClick={() => resolve(false)}
              >
                Confirm no effect
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
                Record completed result
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
