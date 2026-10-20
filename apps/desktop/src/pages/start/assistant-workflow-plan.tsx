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
} from '@workspace/ui/components';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { WorkflowPlan } from '@/services/assistant';

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
  onDiscuss: () => void;
}) {
  const { t } = useTranslation();
  const doc = plan.document;
  const editable = [
    'ready',
    'needs_clarification',
    'failed',
    'approved',
  ].includes(plan.status);
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
    <Card className='my-4 w-full' aria-label={t('assistant.plan.title')}>
      <CardHeader>
        <CardTitle>
          {t('assistant.plan.title')} ·{' '}
          {t('assistant.plan.version', { version: plan.version })}
        </CardTitle>
        <CardDescription>{doc.summary}</CardDescription>
        <CardAction>
          <Badge variant='secondary'>
            {t(`assistant.plan.status.${plan.status}`)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className='flex flex-col gap-5'>
        {active && plan.interaction?.status === 'waiting' && (
          <p className='text-muted-foreground text-sm'>
            {t('assistant.plan.waitingFeedback')}
          </p>
        )}
        <p>{doc.goal}</p>
        {doc.target_id && (
          <Link
            className='underline'
            to={`/workflows/${encodeURIComponent(doc.target_id)}`}
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
        {list(t('assistant.plan.questions'), doc.questions)}
        {list(t('assistant.plan.dependencies'), plan.dependencyIssues)}
        {plan.outcome?.summary && <p role='status'>{plan.outcome.summary}</p>}
        <Collapsible>
          <CollapsibleTrigger render={<Button variant='ghost' size='sm' />}>
            <ChevronDownIcon data-icon='inline-start' />
            {t('assistant.plan.details')}
          </CollapsibleTrigger>
          <CollapsibleContent className='flex flex-col gap-4 pt-3'>
            {list(t('assistant.plan.constraints'), doc.constraints)}
            {list(t('assistant.plan.acceptance'), doc.acceptance_criteria)}
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
                    <li key={i} className='break-words'>
                      {dependency.purpose} · {dependency.kind}: {dependency.id}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
      <CardFooter className='flex-wrap gap-2'>
        {editable && active && (
          <>
            <Button
              disabled={busy || !ready}
              onClick={() => onDecide('approve')}
            >
              {t('assistant.plan.approve')}
            </Button>
            <Button
              variant='outline'
              disabled={busy || plan.status === 'approved'}
              onClick={onDiscuss}
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
              <Link to={`/workflows/${encodeURIComponent(plan.workflowId)}`} />
            }
          >
            {t('assistant.plan.openWorkflow')}
          </Button>
        )}
        <p className='text-muted-foreground text-xs'>
          {t('assistant.plan.creationOnly')}
        </p>
      </CardFooter>
    </Card>
  );
}
