import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Questionnaire,
  QuestionnaireItem,
  QuestionnaireTitle,
} from '@workspace/ui/components';
import { ChevronDownIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router';

import { WorkflowChangeCard } from '@/components/workflow-diff/workflow-change-card';
import type { WorkflowPlan } from '@/services/assistant';

import { AssistantPlanOutcome } from './assistant-plan-outcome';

export function AssistantWorkflowPlan({
  plan,
  busy,
  onDecide,
  onDiscuss,
  active = true,
}: {
  active?: boolean;
  plan: WorkflowPlan;
  busy: boolean;
  onDecide: (decision: 'approve' | 'cancel') => void;
  onDiscuss: (question?: string) => void;
}) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigationState =
    location.pathname === '/start'
      ? {
          assistantReturnTo: `${location.pathname}${location.search}${location.hash}`,
        }
      : undefined;
  const doc = plan.document;
  const isRevision = Boolean(doc.target_id);
  const titleKey = isRevision
    ? 'assistant.plan.revisionTitle'
    : 'assistant.plan.title';
  const compact =
    ['approved', 'building', 'saved', 'cancelled'].includes(plan.status) ||
    (!active && !doc.questions.length);
  // Confirmation changes the card from a review surface to a compact receipt.
  // Scope the reader's choice to that mode so a previously expanded proposal folds.
  const [expansion, setExpansion] = useState<{
    compact: boolean;
    open: boolean;
  }>();
  const open = expansion?.compact === compact ? expansion.open : !compact;
  const editable = ['ready', 'needs_clarification', 'failed'].includes(
    plan.status,
  );
  const ready =
    plan.status === 'ready' &&
    !doc.questions.length &&
    !plan.dependencyIssues.length;
  const list = (title: string, values: string[]) =>
    values.length > 0 && (
      <section className='flex flex-col gap-2'>
        <h3 className='font-medium'>{title}</h3>
        <ul className='list-disc pl-5'>
          {values.map((value, index) => (
            <li key={index}>{value}</li>
          ))}
        </ul>
      </section>
    );
  return (
    <Collapsible
      open={open}
      onOpenChange={(open) => setExpansion({ compact, open })}
    >
      <Card className='my-3 w-full' aria-label={t(titleKey)}>
        <CardHeader>
          <CardTitle>
            {t(titleKey)} ·{' '}
            {t('assistant.plan.version', { version: plan.version })}
          </CardTitle>
          <CardDescription>{doc.summary}</CardDescription>
          <CardAction>
            <Badge variant='secondary'>
              {t(
                isRevision && plan.status === 'building'
                  ? 'assistant.plan.revisionBuilding'
                  : `assistant.plan.status.${plan.status}`,
              )}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent>
          <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
            <ChevronDownIcon data-icon='inline-start' />
            {t(open ? 'assistant.plan.hidePlan' : 'assistant.plan.viewPlan')}
          </CollapsibleTrigger>
        </CardContent>
        <CollapsibleContent>
          <CardContent className='flex flex-col gap-5'>
            {active && plan.interaction?.status === 'waiting' && (
              <p className='text-muted-foreground text-sm'>
                {t(
                  isRevision
                    ? 'assistant.plan.revisionWaitingFeedback'
                    : 'assistant.plan.waitingFeedback',
                )}
              </p>
            )}
            {doc.questions.length > 0 && (
              <section
                className='flex flex-col gap-2'
                aria-label={t('assistant.plan.questions')}
              >
                <h3 className='font-medium'>{t('assistant.plan.questions')}</h3>
                <p className='text-muted-foreground text-sm'>
                  {t('assistant.plan.clarificationHint')}
                </p>
                {doc.questions.map((question, index) => (
                  <Questionnaire
                    key={index}
                    onSubmit={(event) => event.preventDefault()}
                  >
                    <QuestionnaireItem
                      name={`plan-${plan.id}-v${plan.version}-question-${index}`}
                    >
                      <QuestionnaireTitle>{question}</QuestionnaireTitle>
                      {active && editable && plan.status !== 'approved' && (
                        <Button
                          type='button'
                          variant='outline'
                          size='sm'
                          disabled={busy}
                          onClick={() => onDiscuss(question)}
                        >
                          {t('assistant.plan.answerQuestion')}
                        </Button>
                      )}
                    </QuestionnaireItem>
                  </Questionnaire>
                ))}
              </section>
            )}
            <p>{doc.goal}</p>
            {doc.target_id && (
              <Link
                className='underline'
                to={`/workflows/${encodeURIComponent(doc.target_id)}`}
                state={navigationState}
              >
                {t('assistant.plan.revisionTarget')}
              </Link>
            )}
            {doc.inputs.length > 0 && (
              <section className='flex flex-col gap-2'>
                <h3 className='font-medium'>{t('assistant.plan.inputs')}</h3>
                <ul className='list-disc pl-5'>
                  {doc.inputs.map((input, index) => (
                    <li key={index}>
                      {input.name} · {input.description}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {list(t('assistant.plan.outputs'), doc.outputs)}
            <section className='flex flex-col gap-2'>
              <h3 className='font-medium'>{t('assistant.plan.steps')}</h3>
              <ol className='flex list-decimal flex-col gap-3 pl-5'>
                {doc.steps.map((step, index) => (
                  <li key={index}>
                    <p className='font-medium'>{step.title}</p>
                    <p className='text-muted-foreground'>{step.description}</p>
                  </li>
                ))}
              </ol>
            </section>
            {list(t('assistant.plan.assumptions'), doc.assumptions)}
            {list(t('assistant.plan.acceptance'), doc.acceptance_criteria)}
            {list(t('assistant.plan.dependencies'), plan.dependencyIssues)}
            <Collapsible>
              <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
                <ChevronDownIcon data-icon='inline-start' />
                {t('assistant.plan.details')}
              </CollapsibleTrigger>
              <CollapsibleContent className='flex flex-col gap-4 pt-3'>
                {list(t('assistant.plan.constraints'), doc.constraints)}
                {doc.steps.map((step, index) => (
                  <section key={index} className='flex flex-col gap-2'>
                    <h3 className='font-medium'>{step.title}</h3>
                    <div className='flex flex-wrap gap-2'>
                      {step.node_types.map((type) => (
                        <Badge key={type} variant='outline'>
                          {type}
                        </Badge>
                      ))}
                    </div>
                    <p className='whitespace-pre-wrap'>
                      {step.configuration_notes}
                    </p>
                    <ul className='list-disc pl-5'>
                      {step.dependencies.map((dependency, i) => (
                        <li key={i} className='wrap-break-word'>
                          {dependency.purpose} · {dependency.kind}:{' '}
                          {dependency.id}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </CollapsibleContent>
            </Collapsible>
          </CardContent>
        </CollapsibleContent>
        <CardFooter className='flex-wrap gap-2'>
          {plan.outcome?.after_revision_id && (
            <WorkflowChangeCard
              beforeRevisionId={plan.outcome.before_revision_id}
              afterRevisionId={plan.outcome.after_revision_id}
            />
          )}
          {plan.outcome?.summary && (
            <AssistantPlanOutcome summary={plan.outcome.summary} />
          )}
          {editable && active && (
            <>
              <Button
                disabled={busy || !ready}
                onClick={() => onDecide('approve')}
              >
                {t(
                  isRevision
                    ? 'assistant.plan.approveRevision'
                    : 'assistant.plan.approve',
                )}
              </Button>
              <Button
                variant='outline'
                disabled={busy || plan.status === 'approved'}
                onClick={() => onDiscuss()}
              >
                {t('assistant.plan.discuss')}
              </Button>
              <Button
                variant='ghost'
                disabled={busy}
                onClick={() => onDecide('cancel')}
              >
                {t('assistant.plan.cancel')}
              </Button>
            </>
          )}
          {plan.workflowId && (
            <Button
              variant='outline'
              nativeButton={false}
              role='link'
              render={
                <Link
                  to={`/workflows/${encodeURIComponent(plan.workflowId)}`}
                  state={navigationState}
                />
              }
            >
              {t('assistant.plan.openWorkflow')}
            </Button>
          )}
          <p className='text-muted-foreground text-xs'>
            {t(
              isRevision
                ? 'assistant.plan.revisionOnly'
                : 'assistant.plan.creationOnly',
            )}
          </p>
        </CardFooter>
      </Card>
    </Collapsible>
  );
}
