import { listen } from '@tauri-apps/api/event';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  Badge,
  Button,
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
  Textarea,
} from '@workspace/ui/components';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import { toast } from 'sonner';

import {
  claimNextPendingAction,
  releasePendingAction,
  type PendingAction,
} from '@/services/run-history';
import { resolveBackgroundWorkflowAction } from '@/services/workflow';

type Payload = Record<string, unknown>;
type ActionDialogProps = {
  action: PendingAction;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (resolution: Payload) => void;
};

const approvalClaimantStorageKey = 'workrun.approval-claimant-id';

function approvalClaimantId() {
  try {
    const existing = window.sessionStorage.getItem(approvalClaimantStorageKey);
    if (existing) return existing;

    const id = crypto.randomUUID();
    // A reload can terminate the old page before its best-effort release IPC
    // reaches Rust. Keep the owner ID for this tab so its durable claim remains
    // usable after React mounts again.
    window.sessionStorage.setItem(approvalClaimantStorageKey, id);
    return id;
  } catch {
    // Storage can be unavailable in restricted webviews. The ref remains
    // stable for this mounted coordinator even though a reload cannot recover.
    return crypto.randomUUID();
  }
}

function object(value: unknown): Payload | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Payload)
    : undefined;
}

function ReviewMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      components={{
        h1: ({ children }) => (
          <h1 className='font-heading text-xl font-semibold tracking-tight'>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className='font-heading mt-6 text-lg font-semibold first:mt-0'>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className='mt-5 text-sm font-semibold'>{children}</h3>
        ),
        li: ({ children }) => <li className='leading-6'>{children}</li>,
        p: ({ children }) => <p className='leading-6'>{children}</p>,
        ul: ({ children }) => (
          <ul className='list-disc space-y-1 pl-5'>{children}</ul>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}

function ToolApprovalDialog({
  action,
  submitting,
  onClose,
  onSubmit,
}: ActionDialogProps) {
  const payload = object(action.payload) ?? {};

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader className='grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
          <AlertDialogMedia className='mb-0 size-8'>
            <ShieldAlertIcon />
          </AlertDialogMedia>
          <div className='min-w-0 space-y-1.5'>
            <AlertDialogTitle>
              Allow {typeof payload.name === 'string' ? payload.name : 'Tool'}
              {' to run?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {typeof payload.description === 'string'
                ? payload.description
                : 'The Agent requested a Tool App execution.'}
            </AlertDialogDescription>
            <div className='flex flex-wrap gap-1.5 pt-1'>
              <Badge variant='outline'>
                Source:{' '}
                {typeof payload.sourceName === 'string'
                  ? payload.sourceName
                  : typeof payload.source === 'string'
                    ? payload.source
                    : 'Tool App'}
              </Badge>
              <Badge variant='secondary'>
                Risk:{' '}
                {typeof payload.riskLevel === 'string'
                  ? payload.riskLevel
                  : 'unknown'}
              </Badge>
            </div>
          </div>
        </AlertDialogHeader>
        <pre className='bg-muted max-h-64 overflow-auto rounded-md p-3 text-xs'>
          {JSON.stringify(payload.input ?? {}, null, 2)}
        </pre>
        <AlertDialogFooter>
          <Button
            variant='outline'
            disabled={submitting}
            onClick={() => onSubmit({ approved: false })}
          >
            Cancel
          </Button>
          <Button
            disabled={submitting}
            onClick={() => onSubmit({ approved: true })}
          >
            {submitting ? 'Saving…' : 'Run tool'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function HumanReviewDialog({
  action,
  submitting,
  onClose,
  onSubmit,
}: ActionDialogProps) {
  const payload = object(action.payload) ?? {};
  const contentKey =
    typeof payload.contentKey === 'string' ? payload.contentKey : undefined;
  const content = payload.content;
  const editable = payload.editable === true;
  const [edit, setEdit] = useState<string>();
  const canEdit = editable && contentKey && typeof content === 'string';
  const resolution = (approved: boolean) => ({
    approved,
    edits: canEdit && edit !== undefined ? { [contentKey]: edit } : {},
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className='max-h-[88vh] w-[min(94vw,72rem)]! max-w-none!'>
        <AlertDialogHeader className='grid-cols-[auto_minmax(0,1fr)] grid-rows-1 place-items-start gap-x-2 text-left has-data-[slot=alert-dialog-media]:grid-rows-1'>
          <AlertDialogMedia className='mb-0 size-8'>
            <ShieldCheckIcon />
          </AlertDialogMedia>
          <div className='min-w-0 space-y-1.5'>
            <AlertDialogTitle>
              {typeof payload.title === 'string'
                ? payload.title
                : 'Human review required'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {typeof payload.description === 'string'
                ? payload.description
                : 'Review the workflow context before allowing it to continue.'}
            </AlertDialogDescription>
            <p className='text-muted-foreground text-sm'>
              Approval and rejection follow their matching workflow outputs. An
              unconnected output stops this run.
            </p>
          </div>
        </AlertDialogHeader>
        <div className='max-h-[calc(88vh-12rem)] min-h-0 overflow-y-auto'>
          <section className='bg-muted/20 rounded-lg border p-5'>
            <div className='mb-4 flex items-center gap-2'>
              <Badge variant='secondary'>审核内容</Badge>
              {contentKey ? (
                <code className='text-xs'>{contentKey}</code>
              ) : null}
            </div>
            {canEdit ? (
              <Textarea
                className='min-h-72 font-mono text-sm leading-6'
                value={edit ?? content}
                onChange={(event) => setEdit(event.target.value)}
              />
            ) : typeof content === 'string' ? (
              <ReviewMarkdown content={content} />
            ) : (
              <pre className='bg-muted max-h-[calc(88vh-16rem)] overflow-auto rounded-md p-3 text-xs'>
                {JSON.stringify(content ?? null, null, 2)}
              </pre>
            )}
          </section>
          {payload.context && typeof payload.context === 'object' ? (
            <section className='bg-muted/20 mt-4 rounded-lg border p-5'>
              <div className='mb-4 flex items-center gap-2'>
                <Badge variant='secondary'>补充上下文</Badge>
              </div>
              <pre className='bg-muted max-h-72 overflow-auto rounded-md p-3 text-xs'>
                {JSON.stringify(payload.context, null, 2)}
              </pre>
            </section>
          ) : null}
        </div>
        <AlertDialogFooter>
          <Button
            variant='outline'
            disabled={submitting}
            onClick={() => onSubmit(resolution(false))}
          >
            Reject
          </Button>
          <Button
            disabled={submitting}
            onClick={() => onSubmit(resolution(true))}
          >
            {submitting ? 'Saving decision…' : 'Approve & continue'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function AskUserQuestionDialog({
  action,
  submitting,
  onClose,
  onSubmit,
}: ActionDialogProps) {
  const payload = object(action.payload) ?? {};
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap((item) => {
        const option = object(item);
        return typeof option?.id === 'string' &&
          typeof option.label === 'string'
          ? [option]
          : [];
      })
    : [];

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {typeof payload.title === 'string'
              ? payload.title
              : 'Choose an option'}
          </AlertDialogTitle>
          {typeof payload.description === 'string' ? (
            <AlertDialogDescription>
              {payload.description}
            </AlertDialogDescription>
          ) : null}
        </AlertDialogHeader>
        <Questionnaire
          items={[
            {
              name: 'answer',
              required: true,
              choices: options.map((option) => ({
                value: option.id as string,
              })),
            },
          ]}
          onSubmit={(event) => {
            event.preventDefault();
            const answer = new FormData(event.currentTarget).get('answer');
            if (typeof answer === 'string') onSubmit({ optionId: answer });
          }}
        >
          <QuestionnaireItem name='answer' required>
            <QuestionnaireTitle className='sr-only'>
              Available options
            </QuestionnaireTitle>
            <QuestionnaireChoices>
              {options.map((option) => (
                <QuestionnaireChoice
                  key={option.id as string}
                  value={option.id as string}
                >
                  <span>{option.label as string}</span>
                  {typeof option.description === 'string' ? (
                    <QuestionnaireChoiceDescription>
                      {option.description}
                    </QuestionnaireChoiceDescription>
                  ) : null}
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
            <QuestionnaireError />
          </QuestionnaireItem>
          <QuestionnaireActions>
            <QuestionnaireSubmit disabled={submitting}>
              {submitting ? 'Saving answer…' : 'Continue'}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </Questionnaire>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PendingActionDialog(props: ActionDialogProps) {
  switch (props.action.kind) {
    case 'tool_approval':
      return <ToolApprovalDialog {...props} />;
    case 'human_review':
      return <HumanReviewDialog {...props} />;
    case 'ask_user_question':
      return <AskUserQuestionDialog {...props} />;
  }
}

/**
 * The only component that claims approvals. Page-local run views may replay
 * the prompt for context, but never own the decision, so navigation cannot
 * produce duplicate dialogs for the same paused workflow.
 */
function ApprovalCoordinator() {
  const [claimantId] = useState(approvalClaimantId);
  const [action, setAction] = useState<PendingAction>();
  const [dismissed, setDismissed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [queueVersion, setQueueVersion] = useState(0);
  const releasedAction = useRef<string>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void listen('pending-action-created', () => {
      setQueueVersion((version) => version + 1);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (action || dismissed) return;
    let cancelled = false;
    const claim = async () => {
      try {
        const next = await claimNextPendingAction(claimantId);
        if (!cancelled && next) setAction(next);
      } catch (error) {
        if (!cancelled) {
          toast.error('Could not load the approval queue', {
            toasterId: 'global',
            description: error instanceof Error ? error.message : String(error),
          });
        }
      }
    };
    void claim();
    return () => {
      cancelled = true;
    };
  }, [action, dismissed, queueVersion, claimantId]);

  useEffect(
    () => () => {
      if (action && releasedAction.current !== action.id) {
        void releasePendingAction(action.id, claimantId);
      }
    },
    [action, claimantId],
  );

  const close = () => {
    if (!action || submitting) return;
    releasedAction.current = action.id;
    void releasePendingAction(action.id, claimantId);
    setAction(undefined);
    setDismissed(true);
  };

  const submit = async (resolution: Payload) => {
    if (!action || submitting) return;
    setSubmitting(true);
    try {
      await resolveBackgroundWorkflowAction(action.id, claimantId, resolution);
      releasedAction.current = action.id;
      setAction(undefined);
    } catch (error) {
      toast.error('Could not continue the workflow', {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return action ? (
    <PendingActionDialog
      action={action}
      submitting={submitting}
      onClose={close}
      onSubmit={(resolution) => void submit(resolution)}
    />
  ) : null;
}

export { ApprovalCoordinator };
