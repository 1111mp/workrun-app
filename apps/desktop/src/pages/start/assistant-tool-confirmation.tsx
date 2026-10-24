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
} from '@workspace/ui/components';
import { useTranslation } from 'react-i18next';

import type { AssistantToolConfirmation } from '@/services/assistant';

export function AssistantToolConfirmationCard({
  confirmation,
  active,
  busy,
  onDecide,
}: {
  confirmation: AssistantToolConfirmation;
  active: boolean;
  busy: boolean;
  onDecide: (decision: 'approve' | 'deny') => void;
}) {
  const { t } = useTranslation();
  const waiting = confirmation.interaction.status === 'waiting';
  return (
    <Card
      className='my-4 w-full min-w-0'
      aria-label={t('assistant.toolConfirmation.title')}
    >
      <CardHeader>
        <CardTitle>{confirmation.tool.displayName}</CardTitle>
        <CardDescription>
          {t('assistant.toolConfirmation.description')}
        </CardDescription>
        <CardAction>
          <Badge variant='secondary'>
            {t(
              active
                ? waiting
                  ? 'assistant.toolConfirmation.waiting'
                  : 'assistant.toolConfirmation.processing'
                : 'assistant.toolConfirmation.closed',
            )}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className='flex min-w-0 flex-col gap-2'>
        <p className='text-muted-foreground text-sm break-all'>
          {confirmation.tool.id}
        </p>
        <pre
          className='max-h-72 overflow-auto text-sm break-all whitespace-pre-wrap'
          aria-label={t('assistant.toolConfirmation.arguments')}
        >
          {JSON.stringify(confirmation.arguments, null, 2)}
        </pre>
      </CardContent>
      {active && (
        <CardFooter className='flex-wrap gap-2'>
          <Button
            disabled={busy || !waiting}
            onClick={() => onDecide('approve')}
          >
            {t('assistant.toolConfirmation.approve')}
          </Button>
          <Button
            variant='outline'
            disabled={busy || !waiting}
            onClick={() => onDecide('deny')}
          >
            {t('assistant.toolConfirmation.deny')}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
