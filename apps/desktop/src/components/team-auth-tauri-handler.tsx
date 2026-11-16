import { useBetterAuthTauri } from '@daveyplate/better-auth-tauri/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { createTeamAuthClient } from '@/lib/auth-client';
import { router } from '@/routes';
import {
  clearTeamModelSession,
  syncTeamModelSession,
} from '@/services/team-model-session';
import {
  useRunWorkspaceStore,
  useWorkflowRunStore,
  useWorkrunStore,
} from '@/stores';
import { useAssistantStore } from '@/stores/assistant.store';

function TeamAuthTauriHandler() {
  const serverUrl = useWorkrunStore((s) => s.config?.team?.server_url);
  return serverUrl ? (
    <ConfiguredTeamAuthTauriHandler serverUrl={serverUrl} />
  ) : null;
}

function ConfiguredTeamAuthTauriHandler({ serverUrl }: { serverUrl: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const authClient = useMemo(
    () => createTeamAuthClient(serverUrl),
    [serverUrl],
  );

  const { data: session } = authClient.useSession();
  const notifySessionError = useEffectEvent(() => {
    toast.error(t('settings.models.teamSessionFailed'), {
      toasterId: 'global',
    });
  });
  const workspaceMode = useWorkrunStore((s) => s.config?.workspace_mode);
  const previousAccount = useRef('');

  useEffect(() => {
    let active = true;
    const privateQueries = {
      predicate: (query: { queryKey: readonly unknown[] }) =>
        query.queryKey[0] !== 'team-user' ||
        query.queryKey[1] !== serverUrl ||
        query.queryKey[2] !== session?.session.token,
    };
    const account = JSON.stringify([
      serverUrl,
      workspaceMode,
      session?.user.id,
    ]);
    if (previousAccount.current !== account) {
      previousAccount.current = account;
      void queryClient.cancelQueries(privateQueries);
      queryClient.removeQueries(privateQueries);
      useWorkrunStore.getState().setTeamUser(undefined);
      useRunWorkspaceStore.setState({
        tabs: [],
        activeRunId: undefined,
        requestedActionId: undefined,
        open: false,
      });
      useWorkflowRunStore.getState().resetRunView();
      useWorkflowRunStore.setState({
        activeChatSession: undefined,
        lastRunInput: undefined,
        runPanelOpen: false,
        showRunOutput: false,
      });
      useAssistantStore.getState().disposeAssistantEvents();
      useAssistantStore.setState({
        sessions: {},
        scopes: {},
        summaries: {},
        streams: {},
        syncErrors: {},
        listErrors: {},
      });
    }
    void syncTeamModelSession(
      serverUrl,
      workspaceMode === 'team' ? (session?.session.token ?? null) : null,
    )
      .then(() => {
        if (!active) return;
        void queryClient.invalidateQueries(privateQueries);
      })
      .catch(() => {
        if (active && workspaceMode === 'team' && session?.session.token) {
          notifySessionError();
        }
      });
    return () => {
      active = false;
    };
  }, [
    serverUrl,
    workspaceMode,
    session?.user.id,
    session?.session.token,
    queryClient,
  ]);

  useEffect(
    () => () => {
      void clearTeamModelSession(serverUrl).catch(() => {});
    },
    [serverUrl],
  );

  const onError = useCallback(() => {
    toast.error(t('onboarding.login.oauthFailed'), { toasterId: 'global' });
    void router.navigate('/login', { replace: true });
  }, [t]);

  const onSuccess = useCallback((callbackURL?: string | null) => {
    void router.navigate(callbackURL || '/workflows', { replace: true });
  }, []);

  useBetterAuthTauri({
    authClient,
    debugLogs: import.meta.env.DEV,
    onError,
    onSuccess,
    scheme: 'workrun',
  });

  return null;
}

export { TeamAuthTauriHandler };
