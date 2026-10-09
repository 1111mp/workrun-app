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
import { CircleHelpIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import { toast } from 'sonner';

import { ArtifactFiles } from '@/components/artifact-files';
import { humanReviewAttachments } from '@/services/human-review';
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
  const { t } = useTranslation();
  const payload = object(action.payload) ?? {};

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className='max-w-xl! gap-0 overflow-hidden p-0'>
        <AlertDialogHeader className='via-background to-background relative block overflow-hidden border-b bg-linear-to-br from-amber-500/14 px-7 py-7 pr-16 text-left'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(38_92%_50%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
          <div className='relative flex items-start gap-4'>
            <AlertDialogMedia className='bg-background/80 mb-0 flex size-11 shrink-0 items-center justify-center rounded-xl border border-amber-500/20 text-amber-700 shadow-sm dark:text-amber-300'>
              <ShieldAlertIcon className='size-5' />
            </AlertDialogMedia>
            <div className='min-w-0'>
              <AlertDialogTitle className='text-lg tracking-tight'>
                {t('approval.tool.title', {
                  name:
                    typeof payload.name === 'string'
                      ? payload.name
                      : t('approval.tool.fallbackName'),
                })}
              </AlertDialogTitle>
              <AlertDialogDescription className='mt-1 max-w-2xl leading-5'>
                {typeof payload.description === 'string'
                  ? payload.description
                  : t('approval.tool.description')}
              </AlertDialogDescription>
              <div className='flex flex-wrap gap-1.5 pt-3'>
                <Badge variant='outline' className='bg-background/60'>
                  {t('approval.tool.source')}:{' '}
                  {typeof payload.sourceName === 'string'
                    ? payload.sourceName
                    : typeof payload.source === 'string'
                      ? payload.source
                      : t('approval.tool.fallbackSource')}
                </Badge>
                <Badge variant='secondary'>
                  {t('approval.tool.risk')}:{' '}
                  {typeof payload.riskLevel === 'string'
                    ? payload.riskLevel
                    : t('approval.tool.unknown')}
                </Badge>
              </div>
            </div>
          </div>
        </AlertDialogHeader>
        <div className='max-h-[min(58vh,560px)] overflow-y-auto px-7 py-6'>
          <section className='bg-muted/15 rounded-xl border p-4'>
            <div className='mb-3 flex items-center gap-2'>
              <span className='bg-primary/10 text-primary flex size-7 items-center justify-center rounded-lg'>
                <ShieldCheckIcon className='size-3.5' />
              </span>
              <h2 className='text-sm font-medium'>
                {t('approval.tool.input')}
              </h2>
            </div>
            <pre className='bg-background max-h-[min(40vh,24rem)] overflow-auto rounded-lg border p-4 font-mono text-xs leading-5'>
              {JSON.stringify(payload.input ?? {}, null, 2)}
            </pre>
          </section>
        </div>
        <AlertDialogFooter className='bg-muted/15 mx-0 mb-0 border-t px-7 py-4'>
          <Button
            variant='outline'
            disabled={submitting}
            onClick={() => onSubmit({ approved: false })}
          >
            {t('approval.cancel')}
          </Button>
          <Button
            disabled={submitting}
            onClick={() => onSubmit({ approved: true })}
          >
            {submitting ? t('approval.saving') : t('approval.tool.run')}
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
  const { t } = useTranslation();
  const payload = object(action.payload) ?? {};
  const contentKey =
    typeof payload.contentKey === 'string' ? payload.contentKey : undefined;
  const content = payload.content;
  const attachments = humanReviewAttachments(payload);
  const editable = payload.editable === true;
  const [edit, setEdit] = useState<string>();
  const canEdit = editable && contentKey && typeof content === 'string';
  const resolution = (approved: boolean) => ({
    approved,
    edits: canEdit && edit !== undefined ? { [contentKey]: edit } : {},
  });

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className='max-h-[80vh] max-w-3xl! gap-0 overflow-hidden p-0'>
        <AlertDialogHeader className='via-background to-background relative block overflow-hidden border-b bg-linear-to-br from-emerald-500/14 px-7 py-7 pr-16 text-left'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(160_84%_39%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
          <div className='relative flex items-start gap-4'>
            <AlertDialogMedia className='bg-background/80 mb-0 flex size-11 shrink-0 items-center justify-center rounded-xl border border-emerald-500/20 text-emerald-700 shadow-sm dark:text-emerald-300'>
              <ShieldCheckIcon className='size-5' />
            </AlertDialogMedia>
            <div className='min-w-0'>
              <AlertDialogTitle className='text-lg tracking-tight'>
                {typeof payload.title === 'string'
                  ? payload.title
                  : t('approval.review.title')}
              </AlertDialogTitle>
              <AlertDialogDescription className='mt-1 max-w-3xl leading-5'>
                {typeof payload.description === 'string'
                  ? payload.description
                  : t('approval.review.description')}
              </AlertDialogDescription>
              <p className='text-muted-foreground pt-3 text-sm leading-5'>
                {t('approval.review.routingDescription')}
              </p>
            </div>
          </div>
        </AlertDialogHeader>
        <div className='max-h-[calc(80vh-14rem)] min-h-0 overflow-y-auto px-7 py-6'>
          {content != null && (
            <section className='bg-muted/15 rounded-xl border p-5'>
              <div className='mb-4 flex items-center gap-2'>
                <span className='flex size-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'>
                  <ShieldCheckIcon className='size-3.5' />
                </span>
                <h2 className='text-sm font-medium'>
                  {t('approval.review.content')}
                </h2>
                {contentKey ? (
                  <code className='bg-background rounded-md border px-1.5 py-0.5 text-xs'>
                    {contentKey}
                  </code>
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
                <pre className='bg-background max-h-[calc(80vh-18rem)] overflow-auto rounded-lg border p-4 font-mono text-xs leading-5'>
                  {JSON.stringify(content ?? null, null, 2)}
                </pre>
              )}
            </section>
          )}
          {attachments.length > 0 && (
            <section className='bg-muted/15 mt-4 rounded-xl border p-5'>
              <h2 className='mb-4 text-sm font-medium'>
                {t('approval.review.attachments')}
              </h2>
              <ArtifactFiles value={attachments} modalPreview />
            </section>
          )}
          {payload.context &&
          typeof payload.context === 'object' &&
          Object.keys(payload.context).length > 0 ? (
            <section className='bg-muted/15 mt-4 rounded-xl border p-5'>
              <div className='mb-4 flex items-center gap-2'>
                <Badge variant='secondary'>
                  {t('approval.review.context')}
                </Badge>
              </div>
              <pre className='bg-background max-h-72 overflow-auto rounded-lg border p-4 font-mono text-xs leading-5'>
                {JSON.stringify(payload.context, null, 2)}
              </pre>
            </section>
          ) : null}
        </div>
        <AlertDialogFooter className='bg-muted/15 mx-0 mb-0 border-t px-7 py-4'>
          <Button
            variant='outline'
            disabled={submitting}
            onClick={() => onSubmit(resolution(false))}
          >
            {t('approval.review.reject')}
          </Button>
          <Button
            disabled={submitting}
            onClick={() => onSubmit(resolution(true))}
          >
            {submitting
              ? t('approval.review.savingDecision')
              : t('approval.review.approveContinue')}
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
  const { t } = useTranslation();
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
      <AlertDialogContent className='max-w-2xl! gap-0 overflow-hidden p-0'>
        <AlertDialogHeader className='via-background to-background relative block overflow-hidden border-b bg-linear-to-br from-violet-500/14 px-7 py-7 pr-16 text-left'>
          <div className='pointer-events-none absolute inset-0 bg-[radial-gradient(hsl(264_80%_60%/0.14)_1px,transparent_1px)] bg-size-[14px_14px]' />
          <div className='relative flex items-start gap-4'>
            <AlertDialogMedia className='bg-background/80 mb-0 flex size-11 shrink-0 items-center justify-center rounded-xl border border-violet-500/20 text-violet-700 shadow-sm dark:text-violet-300'>
              <CircleHelpIcon className='size-5' />
            </AlertDialogMedia>
            <div className='min-w-0'>
              <AlertDialogTitle className='text-lg tracking-tight'>
                {typeof payload.title === 'string'
                  ? payload.title
                  : t('approval.question.title')}
              </AlertDialogTitle>
              {typeof payload.description === 'string' ? (
                <AlertDialogDescription className='mt-1 max-w-xl leading-5'>
                  {payload.description}
                </AlertDialogDescription>
              ) : null}
            </div>
          </div>
        </AlertDialogHeader>
        <Questionnaire
          className='gap-0'
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
          <div className='max-h-[min(58vh,560px)] overflow-y-auto px-7 py-6'>
            <QuestionnaireItem name='answer' required>
              <QuestionnaireTitle className='text-muted-foreground text-xs font-medium tracking-[0.14em] uppercase'>
                {t('approval.question.availableOptions')}
              </QuestionnaireTitle>
              <QuestionnaireChoices>
                {options.map((option) => (
                  <QuestionnaireChoice
                    key={option.id as string}
                    value={option.id as string}
                    className='bg-muted/15 hover:bg-muted/50 px-4 py-3 data-checked:border-violet-500/40 data-checked:bg-violet-500/8'
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
          </div>
          <QuestionnaireActions className='bg-muted/15 min-h-0 border-t px-7 py-4'>
            <QuestionnaireSubmit disabled={submitting}>
              {submitting
                ? t('approval.question.savingAnswer')
                : t('approval.continue')}
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
  const { t } = useTranslation();
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
          toast.error(t('approval.errors.loadQueue'), {
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
  }, [action, dismissed, queueVersion, claimantId, t]);

  useEffect(
    () => () => {
      if (action && releasedAction.current !== action.id) {
        void releasePendingAction(action.id, claimantId).catch(() => {
          // A workspace switch can make the previous reservation inaccessible.
        });
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
    // A page reload unmounts this component and releases its claim. Mark the
    // action as retained before awaiting IPC so that cleanup cannot race the
    // durable resolution that resumes the workflow.
    releasedAction.current = action.id;
    setSubmitting(true);
    try {
      await resolveBackgroundWorkflowAction(action.id, claimantId, resolution);
      setAction(undefined);
    } catch (error) {
      // Keep the action available for a retry if the resolution was not made
      // durable; the normal unmount cleanup may release this claim again.
      releasedAction.current = null;
      toast.error(t('approval.errors.continueWorkflow'), {
        toasterId: 'global',
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return action ? (
    <PendingActionDialog
      key={action.id}
      action={action}
      submitting={submitting}
      onClose={close}
      onSubmit={(resolution) => void submit(resolution)}
    />
  ) : null;
}

export { ApprovalCoordinator };
