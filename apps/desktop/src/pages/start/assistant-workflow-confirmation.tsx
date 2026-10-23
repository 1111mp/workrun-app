import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Spinner,
} from '@workspace/ui/components';
import { cn } from '@workspace/ui/lib/utils';
import { ShieldCheckIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AssistantWorkflowConfirmation } from '@/services/assistant';

export function AssistantWorkflowConfirmationCard({
  confirmation,
  active,
  busy,
  onDecide,
}: {
  confirmation: AssistantWorkflowConfirmation;
  active: boolean;
  busy: boolean;
  onDecide: (decision: 'approve' | 'reselect' | 'cancel') => Promise<void>;
}) {
  const { t } = useTranslation();
  const submitting = useRef(false);
  const [pending, setPending] = useState<
    'approve' | 'reselect' | 'cancel' | null
  >(null);
  const [error, setError] = useState<string>();
  const waiting = active && confirmation.status === 'waiting';
  const decide = async (decision: 'approve' | 'reselect' | 'cancel') => {
    if (!waiting || busy || submitting.current) return;
    submitting.current = true;
    setPending(decision);
    setError(undefined);
    try {
      await onDecide(decision);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      submitting.current = false;
      setPending(null);
    }
  };
  return (
    <Card
      className={cn(
        'my-2 min-w-0 border-l-4',
        waiting ? 'border-l-primary' : 'border-l-muted-foreground/30',
      )}
      role='region'
      aria-label={t('assistant.runConfirmation.title')}
    >
      <CardHeader className='border-b'>
        <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
          <span className='text-muted-foreground flex items-center gap-2 text-xs font-medium'>
            <span
              className={cn(
                'flex size-8 items-center justify-center rounded-lg',
                waiting ? 'bg-primary/10 text-primary' : 'bg-muted',
              )}
            >
              <ShieldCheckIcon className='size-4 shrink-0' aria-hidden='true' />
            </span>
            {t('assistant.runConfirmation.title')}
          </span>
          <Badge variant={waiting ? 'secondary' : 'outline'}>
            {t(`assistant.runConfirmation.${confirmation.status}`)}
          </Badge>
        </div>
        <CardTitle className='wrap-break-word'>{confirmation.name}</CardTitle>
        {confirmation.description && (
          <CardDescription>{confirmation.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className='flex min-w-0 flex-col gap-3'>
        <p className='text-muted-foreground text-sm'>
          {t(
            confirmation.status !== 'waiting'
              ? `assistant.runConfirmation.${confirmation.status}Description`
              : confirmation.changed
                ? 'assistant.runConfirmation.changed'
                : 'assistant.runConfirmation.description',
          )}
        </p>
        <details>
          <summary className='cursor-pointer text-sm'>
            {t('assistant.runConfirmation.inputs')}
          </summary>
          <pre className='mt-2 max-h-64 overflow-auto text-xs break-all whitespace-pre-wrap'>
            {JSON.stringify(confirmation.input, null, 2)}
          </pre>
        </details>
        {error && (
          <Alert variant='destructive'>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
      {waiting && (
        <CardFooter className='grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end'>
          <Button
            variant='ghost'
            className='order-last col-span-2 sm:order-first sm:mr-auto'
            disabled={busy || pending !== null}
            onClick={() => void decide('cancel')}
          >
            {pending === 'cancel' && <Spinner />}
            {t('assistant.runConfirmation.cancel')}
          </Button>
          <Button
            variant='outline'
            disabled={busy || pending !== null}
            onClick={() => void decide('reselect')}
          >
            {pending === 'reselect' && <Spinner />}
            {t('assistant.runConfirmation.reselect')}
          </Button>
          <Button
            disabled={busy || pending !== null}
            onClick={() => void decide('approve')}
          >
            {pending === 'approve' && <Spinner />}
            {t('assistant.runConfirmation.approve')}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
