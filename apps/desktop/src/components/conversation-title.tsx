import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useEntryWorkspace } from '@/components/app-sidebar';
import { useAssistantStore } from '@/stores/assistant.store';

export function ConversationTitle() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const id = params.get('session');
  const scope = useEntryWorkspace();
  const title = useAssistantStore((state) => {
    if (!id) return undefined;
    // Session IDs alone must not expose titles from a different workspace.
    return (
      (state.scopes[id] === scope ? state.sessions[id]?.title : undefined) ||
      state.summaries[scope]?.find((session) => session.id === id)?.title
    );
  });
  return <>{title || (id ? t('workflows.modes.chat') : t('start.newTask'))}</>;
}
