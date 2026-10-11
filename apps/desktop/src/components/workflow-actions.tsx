import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireTitle,
  QuestionnaireChoices,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  Spinner,
  Textarea,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { CircleHelpIcon, ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Markdown from 'react-markdown';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { ArtifactFiles } from '@/components/artifact-files';
import { humanReviewAttachments } from '@/services/human-review';
import { listPendingActions, type PendingAction } from '@/services/run-history';
import { resolveBackgroundWorkflowAction } from '@/services/workflow';
import { useRunWorkspaceStore, useWorkrunStore } from '@/stores';

type Draft = { optionId?: string; edit?: string };
// Drafts belong to requests, not mounted panels. Session storage also keeps
// unfinished edits through a renderer reload for the lifetime of this tab.
const useActionDrafts = create(
  persist<{
    drafts: Record<string, Draft>;
    update: (key: string, draft?: Draft) => void;
  }>(
    (set) => ({
      drafts: {},
      update: (key, draft) =>
        set((state) => {
          const drafts = { ...state.drafts };
          if (draft) drafts[key] = { ...drafts[key], ...draft };
          else delete drafts[key];
          return { drafts };
        }),
    }),
    {
      name: 'workrun.action-drafts',
      storage: createJSONStorage(() => sessionStorage),
    },
  ),
);

export function actionPayload(action: PendingAction): Record<string, unknown> {
  return typeof action.payload === 'object' && action.payload !== null
    ? (action.payload as Record<string, unknown>)
    : {};
}

export function useWorkflowActions(runId?: string) {
  const workspace = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );
  return useQuery({
    queryKey: ['run-history', 'actions', workspace, runId],
    queryFn: () => listPendingActions(runId!),
    enabled: Boolean(runId),
  });
}

function focusWorkflowAction(id: string, root: Element | null) {
  (root ?? document)
    .querySelector(`[data-action-id="${CSS.escape(id)}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function WorkflowActionNotice({ runId }: { runId?: string }) {
  const { t } = useTranslation();
  const query = useWorkflowActions(runId);
  const actions =
    query.data?.filter((action) => action.status === 'pending') ?? [];
  if (query.isError)
    return (
      <Alert variant='destructive' className='mx-4 w-auto'>
        <AlertTitle>{t('approval.errors.loadQueue')}</AlertTitle>
        <AlertDescription>
          <Button variant='outline' onClick={() => void query.refetch()}>
            {t('approval.cards.retry')}
          </Button>
        </AlertDescription>
      </Alert>
    );
  if (!actions.length) return null;
  return (
    <div
      className='flex flex-wrap items-center gap-2 border-b px-4 py-2'
      role='status'
    >
      <Badge variant='secondary'>
        {t('runCenter.attentionCount', { count: actions.length })}
      </Badge>
      <span className='text-muted-foreground text-xs'>
        {t('approval.cards.later')}
      </span>
      {actions.map((action) => (
        <Button
          key={action.id}
          size='sm'
          variant='ghost'
          onClick={(event) =>
            focusWorkflowAction(
              action.id,
              event.currentTarget.closest('[data-slot="drawer-popup"]'),
            )
          }
        >
          {t(
            `runCenter.actions.${action.kind === 'tool_approval' ? 'toolApproval' : action.kind === 'human_review' ? 'humanReview' : 'askQuestion'}`,
          )}
        </Button>
      ))}
    </div>
  );
}

export function WorkflowActionCards({
  runId,
  actionIds,
  excludedActionIds,
  nodeName,
}: {
  runId?: string;
  actionIds?: string[];
  excludedActionIds?: string[];
  nodeName?: (id: string) => string;
}) {
  const { data = [] } = useWorkflowActions(runId);
  const requestedActionId = useRunWorkspaceStore(
    (state) => state.requestedActionId,
  );
  const host = useRef<HTMLDivElement>(null);
  const actions = data.filter((action) =>
    actionIds
      ? actionIds.includes(action.id)
      : !excludedActionIds?.includes(action.id),
  );

  useEffect(() => {
    if (
      !requestedActionId ||
      !actions.some((action) => action.id === requestedActionId)
    )
      return;
    // Wait until the drawer and message rows have mounted before positioning.
    const frame = requestAnimationFrame(() => {
      host.current
        ?.querySelector<HTMLElement>(
          `[data-action-id="${CSS.escape(requestedActionId)}"]`,
        )
        ?.scrollIntoView({ block: 'center' });
      useRunWorkspaceStore.getState().requestAction(undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [requestedActionId, actions]);

  if (!actions.length) return null;

  return (
    <div ref={host} className='flex flex-col gap-3'>
      {actions.map((action) => (
        <WorkflowActionCard
          key={action.id}
          action={action}
          nodeName={nodeName}
        />
      ))}
    </div>
  );
}

export function WorkflowActionCard({
  action,
  nodeName,
}: {
  action: PendingAction;
  nodeName?: (id: string) => string;
}) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const workspace = useWorkrunStore(
    (state) => state.config?.workspace_mode ?? 'personal',
  );
  const draftKey = `${workspace}:${action.runId}:${action.id}`;
  const draft = useActionDrafts((state) => state.drafts[draftKey]);
  const updateDraft = useActionDrafts((state) => state.update);
  const [submitting, setSubmitting] = useState(false);
  const submission = useRef(false);
  const [error, setError] = useState<string>();
  const [submitted, setSubmitted] = useState<Record<string, unknown>>();
  const payload = actionPayload(action);
  const pending = action.status === 'pending' && !submitted;
  const resolution = submitted ?? action.resolution;
  const [expanded, setExpanded] = useState(false);
  const isQuestion = action.kind === 'ask_user_question';
  const isReview = action.kind === 'human_review';
  const Icon = isQuestion
    ? CircleHelpIcon
    : isReview
      ? ShieldCheckIcon
      : ShieldAlertIcon;
  const title =
    typeof payload.title === 'string'
      ? payload.title
      : isQuestion
        ? t('approval.question.title')
        : isReview
          ? t('approval.review.title')
          : t('approval.tool.title', {
              name: payload.name ?? t('approval.tool.fallbackName'),
            });
  const contentKey =
    typeof payload.contentKey === 'string' ? payload.contentKey : undefined;
  const canEdit =
    payload.editable === true &&
    Boolean(contentKey) &&
    // Optional text input may be absent when the review is reached. The
    // configured editing permission still lets the reviewer supply it.
    (payload.content == null || typeof payload.content === 'string');
  const source =
    typeof payload.sourceName === 'string'
      ? payload.sourceName
      : typeof payload.source === 'string'
        ? payload.source
        : t('approval.tool.fallbackSource');
  const risk = t(
    `approval.tool.riskLevels.${['low', 'medium', 'high'].includes(String(payload.riskLevel)) ? String(payload.riskLevel) : 'unknown'}`,
  );
  const kindKey = isQuestion ? 'question' : isReview ? 'review' : 'tool';
  const originalContent =
    typeof payload.content === 'string' ? payload.content : undefined;
  const editedContent = (
    resolution?.edits as Record<string, unknown> | undefined
  )?.[contentKey ?? ''];
  const displayContent =
    typeof editedContent === 'string' ? editedContent : originalContent;
  const selectedOptionId =
    typeof resolution?.optionId === 'string' ? resolution.optionId : '';
  const attachments = isReview ? humanReviewAttachments(payload) : [];
  const options = Array.isArray(payload.options)
    ? payload.options.flatMap((value) => {
        if (typeof value !== 'object' || value === null) return [];
        const option = value as Record<string, unknown>;
        return typeof option.id === 'string' && typeof option.label === 'string'
          ? [
              {
                id: option.id,
                label: option.label,
                description: option.description,
              },
            ]
          : [];
      })
    : [];
  const resultLabel =
    action.status === 'cancelled' || action.status === 'expired'
      ? t(`approval.cards.${action.status}`)
      : isQuestion
        ? t('approval.cards.answered', {
            answer:
              options.find((option) => option.id === resolution?.optionId)
                ?.label ??
              resolution?.optionId ??
              '',
          })
        : t(
            `approval.cards.${resolution?.approved === true ? 'approved' : resolution?.approved === false ? 'rejected' : 'resolved'}`,
          );

  const submit = async (value: Record<string, unknown>) => {
    if (submission.current || !pending) return;
    submission.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      // Each attempt gets its own owner. Reloads and other panels cannot reuse
      // an in-flight reservation to apply the checkpoint twice.
      await resolveBackgroundWorkflowAction(
        action.id,
        crypto.randomUUID(),
        value,
      );
      setSubmitted(value);
      updateDraft(draftKey);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submission.current = false;
      setSubmitting(false);
      void client.invalidateQueries({ queryKey: ['run-history'] });
    }
  };
  const decision = (approved: boolean) =>
    void submit({
      approved,
      ...(isReview
        ? {
            edits:
              canEdit && draft?.edit !== undefined
                ? { [contentKey!]: draft.edit }
                : {},
          }
        : {}),
    });

  return (
    <Card
      id={`workflow-action-${action.id}`}
      data-action-id={action.id}
      role='region'
      aria-labelledby={`${action.id}-title`}
      aria-busy={submitting}
      className={cn(
        'my-2 min-w-0 border-l-4',
        pending ? 'border-l-primary' : 'border-l-muted-foreground/30',
      )}
    >
      <CardHeader className='border-b'>
        <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
          <span className='text-muted-foreground flex items-center gap-2 text-xs font-medium'>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-lg',
                pending ? 'bg-primary/10 text-primary' : 'bg-muted',
              )}
            >
              <Icon className='size-4 shrink-0' aria-hidden='true' />
            </span>
            {t(`approval.cards.types.${kindKey}`)}
          </span>
          <Badge variant={pending ? 'secondary' : 'outline'}>
            {pending
              ? t('approval.cards.pending')
              : t('approval.cards.processed')}
          </Badge>
        </div>
        <CardTitle id={`${action.id}-title`} className='wrap-break-word'>
          {title}
        </CardTitle>
        <CardDescription className='mt-1 flex flex-col gap-2'>
          {typeof payload.description === 'string' ? payload.description : null}
          <span className='text-xs'>
            {typeof payload.nodeId === 'string'
              ? `${nodeName?.(payload.nodeId) ?? payload.nodeId} · `
              : ''}
            {new Date(action.createdAt).toLocaleString(
              i18n.resolvedLanguage ?? i18n.language,
            )}
          </span>
        </CardDescription>
      </CardHeader>
      {!pending && (
        <CardFooter className='justify-between gap-2'>
          <span role='status'>
            {resultLabel}
            {action.resolvedAt
              ? ` · ${new Date(action.resolvedAt).toLocaleString(i18n.resolvedLanguage ?? i18n.language)}`
              : ''}
          </span>
          <Button
            size='sm'
            variant='ghost'
            onClick={() => setExpanded(!expanded)}
          >
            {t(
              expanded
                ? 'approval.cards.hideDetails'
                : 'approval.cards.details',
            )}
          </Button>
        </CardFooter>
      )}
      {(pending || expanded) && (
        <CardContent className='flex flex-col gap-4'>
          {!isQuestion && !isReview && (
            <>
              <div className='flex flex-wrap gap-2'>
                <Badge variant='secondary'>
                  {t('approval.tool.source')}: {source}
                </Badge>
                <Badge variant='outline'>
                  {t('approval.tool.risk')}: {risk}
                </Badge>
              </div>
              <FieldSet>
                <FieldLegend>{t('approval.tool.input')}</FieldLegend>
                <pre className='bg-muted max-h-80 overflow-auto rounded-lg p-3 text-xs'>
                  {JSON.stringify(payload.input ?? {}, null, 2)}
                </pre>
              </FieldSet>
            </>
          )}
          {isReview && (
            <>
              <p className='text-muted-foreground text-xs'>
                {t('approval.review.routingDescription')}
              </p>
              {(displayContent !== undefined ||
                payload.content != null ||
                (pending && canEdit)) && (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor={`${action.id}-content`}>
                      {t('approval.review.content')}
                      {contentKey ? ` · ${contentKey}` : ''}
                    </FieldLabel>
                    {pending && canEdit ? (
                      <Textarea
                        id={`${action.id}-content`}
                        disabled={submitting}
                        className='min-h-64'
                        value={draft?.edit ?? originalContent ?? ''}
                        onChange={(event) =>
                          updateDraft(draftKey, { edit: event.target.value })
                        }
                      />
                    ) : displayContent !== undefined ? (
                      <div className='flex flex-col gap-3 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5'>
                        <Markdown>{displayContent}</Markdown>
                      </div>
                    ) : (
                      <pre className='bg-muted max-h-96 overflow-auto rounded-lg p-3 text-xs'>
                        {JSON.stringify(payload.content, null, 2)}
                      </pre>
                    )}
                  </Field>
                </FieldGroup>
              )}
              {attachments.length > 0 && (
                <FieldSet>
                  <FieldLegend>{t('approval.review.attachments')}</FieldLegend>
                  <ArtifactFiles value={attachments} />
                </FieldSet>
              )}
              {payload.context != null && (
                <FieldSet>
                  <FieldLegend>{t('approval.review.context')}</FieldLegend>
                  <pre className='bg-muted max-h-80 overflow-auto rounded-lg p-3 text-xs'>
                    {JSON.stringify(payload.context, null, 2)}
                  </pre>
                </FieldSet>
              )}
            </>
          )}
          {isQuestion && (
            <Questionnaire
              onSubmit={(event) => {
                event.preventDefault();
                if (
                  pending &&
                  !submitting &&
                  options.some((option) => option.id === draft?.optionId)
                ) {
                  void submit({ optionId: draft?.optionId });
                }
              }}
            >
              <QuestionnaireItem
                name={action.id}
                required
                disabled={!pending || submitting}
              >
                <QuestionnaireTitle>
                  {t('approval.question.availableOptions')}
                </QuestionnaireTitle>
                <QuestionnaireChoices>
                  {options.map((option) => (
                    <QuestionnaireChoice
                      key={option.id}
                      value={option.id}
                      checked={
                        (pending ? draft?.optionId : selectedOptionId) ===
                        option.id
                      }
                      onChange={(event) => {
                        if (pending && !submitting && event.target.checked) {
                          updateDraft(draftKey, { optionId: option.id });
                        }
                      }}
                    >
                      {option.label}
                      {typeof option.description === 'string' && (
                        <QuestionnaireChoiceDescription>
                          {option.description}
                        </QuestionnaireChoiceDescription>
                      )}
                    </QuestionnaireChoice>
                  ))}
                </QuestionnaireChoices>
              </QuestionnaireItem>
            </Questionnaire>
          )}
          {error && (
            <Alert variant='destructive'>
              <AlertTitle>{t('approval.errors.continueWorkflow')}</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      )}
      {pending && (
        <CardFooter className='flex-wrap justify-end gap-3'>
          <p className='text-muted-foreground mr-auto basis-full text-xs leading-relaxed'>
            {t(`approval.cards.hints.${kindKey}`)}
          </p>
          {submitting && <Spinner />}
          {isQuestion ? (
            <Button
              disabled={
                submitting ||
                !options.some((option) => option.id === draft?.optionId)
              }
              onClick={() => void submit({ optionId: draft?.optionId })}
            >
              {t(
                submitting
                  ? 'approval.question.savingAnswer'
                  : 'approval.continue',
              )}
            </Button>
          ) : (
            <>
              <Button
                variant='outline'
                disabled={submitting}
                onClick={() => decision(false)}
              >
                {t(
                  isReview
                    ? 'approval.review.reject'
                    : 'approval.cards.denyTool',
                )}
              </Button>
              <Button disabled={submitting} onClick={() => decision(true)}>
                {t(
                  submitting
                    ? 'approval.saving'
                    : isReview
                      ? 'approval.review.approveContinue'
                      : 'approval.tool.run',
                )}
              </Button>
            </>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
