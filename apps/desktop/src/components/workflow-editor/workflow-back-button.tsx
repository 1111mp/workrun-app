import { Button } from '@workspace/ui/components';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router';

export function WorkflowBackButton() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const fromConversation =
    typeof location.state?.assistantReturnTo === 'string' &&
    location.state.assistantReturnTo.startsWith('/start?');

  return (
    <Button
      variant='ghost'
      size='icon-sm'
      aria-label={t(
        fromConversation
          ? 'workflowEditor.backToConversation'
          : 'workflowEditor.backToWorkflows',
      )}
      nativeButton={fromConversation ? undefined : false}
      // Pop the detail entry so the conversation keeps its original history entry.
      onClick={fromConversation ? () => void navigate(-1) : undefined}
      render={fromConversation ? undefined : <Link to='/workflows' />}
    >
      <ArrowLeftIcon />
    </Button>
  );
}
